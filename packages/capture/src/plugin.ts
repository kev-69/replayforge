import { createHash, randomBytes, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { BodyTap, encodeBody } from "./body.js";
import { DEFAULT_REDACT_HEADERS, redactHeaders, redactJsonBody, toLowerSet } from "./redact.js";
import {
  CAPTURE_SCHEMA_VERSION,
  CapturedExchange,
  type CapturedBody,
  type HeaderMap,
} from "@replayforge/core";
import type { CaptureSink } from "./sinks.js";

export interface CaptureOptions {
  /** Where captured exchanges go. The plugin closes it when Fastify closes. */
  sink: CaptureSink;
  /** Identifies this service in every exchange. */
  service: { name: string; version: string };
  /** Defaults to a new id from createRecordingId(). */
  recordingId?: string;
  /** Fraction of requests to capture, 0..1. Default 1 (everything). */
  sampleRate?: number;
  /** Bodies larger than this are truncated. Default 1 MiB. */
  maxBodyBytes?: number;
  /** URL paths that are never captured. Strings match exactly; RegExps are tested. */
  exclude?: ReadonlyArray<string | RegExp>;
  /** Header names to redact in requests and responses. Default: cookie, set-cookie, proxy-authorization. */
  redactHeaders?: readonly string[];
  /** JSON body field names to redact, at any depth. Default: none. */
  redactBodyFields?: readonly string[];
  /** Groups requests by client session. Default: hash of the Authorization header. */
  sessionKey?: (request: FastifyRequest) => string | null;
  /** Random number source for sampling. Inject one in tests. */
  random?: () => number;
}

/** e.g. "rec_20261107T101500Z_3f9a1c": sortable by time, unique enough across restarts. */
export function createRecordingId(now = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  return `rec_${stamp}_${randomBytes(3).toString("hex")}`;
}

/** Default session key: a short hash of the Authorization header, so the raw token isn't repeated. */
export function authorizationSessionKey(request: FastifyRequest): string | null {
  const auth = request.headers.authorization;
  if (!auth) return null;
  return createHash("sha256").update(auth).digest("hex").slice(0, 16);
}

/** What we track for one in-flight request, from onRequest to onResponse. */
interface InFlight {
  sequence: number;
  startedAt: bigint; // process.hrtime.bigint(): nanoseconds from a monotonic clock
  capturedAt: string; // wall-clock ISO time
  requestTap: BodyTap | null;
  responseBody: CapturedBody | null;
}

const NS_PER_MS = 1_000_000n;

/** Converts a nanosecond duration to milliseconds with microsecond precision. */
function nsToMs(ns: bigint): number {
  return Number((ns * 1000n) / NS_PER_MS) / 1000;
}

/** Turns Node's header object into our HeaderMap type (no undefined, numbers become strings). */
function normalizeHeaders(raw: Record<string, string | string[] | number | undefined>): HeaderMap {
  const out: HeaderMap = {};
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    out[name.toLowerCase()] = Array.isArray(value) ? value.map(String) : String(value);
  }
  return out;
}

/** Does this request carry a body? (Only then is it worth tapping the stream.) */
function hasBody(request: FastifyRequest): boolean {
  const length = request.headers["content-length"];
  if (length !== undefined) return length !== "0";
  return request.headers["transfer-encoding"] !== undefined;
}

const capturePlugin: FastifyPluginAsync<CaptureOptions> = async (fastify, options) => {
  const sampleRate = options.sampleRate ?? 1;
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
  if (!(sampleRate >= 0 && sampleRate <= 1)) throw new Error("sampleRate must be between 0 and 1");
  if (!(Number.isInteger(maxBodyBytes) && maxBodyBytes >= 0)) {
    throw new Error("maxBodyBytes must be a non-negative integer");
  }

  const { sink } = options;
  const recordingId = options.recordingId ?? createRecordingId();
  const source = {
    service: options.service.name,
    version: options.service.version,
    hostname: hostname(),
  };
  const exclude = options.exclude ?? [];
  const headersToRedact = toLowerSet(options.redactHeaders ?? DEFAULT_REDACT_HEADERS);
  const bodyFieldsToRedact = toLowerSet(options.redactBodyFields ?? []);
  const sessionKey = options.sessionKey ?? authorizationSessionKey;
  const random = options.random ?? Math.random;

  const recordingStartedAt = process.hrtime.bigint();
  let nextSequence = 0;

  // Per-request state lives in a WeakMap keyed by the request object. When
  // Fastify drops the request, its entry is garbage-collected automatically.
  // (The alternative, fastify.decorateRequest, adds a property to every
  // request type in the app. A WeakMap keeps the plugin self-contained.)
  const inFlight = new WeakMap<FastifyRequest, InFlight>();

  const isExcluded = (url: string): boolean => {
    const path = url.split("?", 1)[0]!;
    return exclude.some((rule) => (typeof rule === "string" ? rule === path : rule.test(path)));
  };

  // ---------------------------------------------------------------------------
  // 1. onRequest: the request has arrived; headers are known, body not read yet.
  // ---------------------------------------------------------------------------
  fastify.addHook("onRequest", async (request) => {
    if (isExcluded(request.url)) return;
    if (sampleRate < 1 && random() >= sampleRate) return;
    inFlight.set(request, {
      sequence: nextSequence++,
      startedAt: process.hrtime.bigint(),
      capturedAt: new Date().toISOString(),
      requestTap: null,
      responseBody: null,
    });
  });

  // ---------------------------------------------------------------------------
  // 2. preParsing: Fastify is about to read the body. We may swap in a different
  //    stream, so we put a BodyTap in the middle and keep a copy of the raw bytes.
  // ---------------------------------------------------------------------------
  fastify.addHook("preParsing", async (request, _reply, payload) => {
    const state = inFlight.get(request);
    if (!state || !hasBody(request)) return payload;
    const tap = new BodyTap(maxBodyBytes);
    state.requestTap = tap;
    // pipeline() (not .pipe()) forwards errors: if the client aborts, the tap
    // is destroyed too and Fastify sees the error instead of waiting forever.
    pipeline(payload, tap).catch(() => {});
    return tap;
  });

  // ---------------------------------------------------------------------------
  // 3. onSend: the response payload is ready, already serialized. For JSON
  //    routes that's a string. Capture it, then pass it on unchanged.
  // ---------------------------------------------------------------------------
  fastify.addHook("onSend", async (request, reply, payload) => {
    const state = inFlight.get(request);
    if (!state) return payload;
    const contentType = headerString(reply, "content-type");
    if (payload === null || payload === undefined) {
      state.responseBody = { kind: "empty" };
    } else if (typeof payload === "string" || Buffer.isBuffer(payload)) {
      const bytes = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
      state.responseBody = encodeBody(bytes, { contentType, maxBytes: maxBodyBytes });
    } else if (payload instanceof Readable) {
      // Copying a stream would mean buffering it, and streams are often large
      // or never end (e.g. server-sent events). We skip the body and say why.
      state.responseBody = { kind: "omitted", reason: "stream" };
    }
    return payload;
  });

  // ---------------------------------------------------------------------------
  // 4. onResponse: the response has been sent to the client. Now (and not
  //    earlier) we do the work, so capture adds no latency for the client.
  // ---------------------------------------------------------------------------
  fastify.addHook("onResponse", async (request, reply) => {
    const state = inFlight.get(request);
    if (!state) return;
    inFlight.delete(request);
    try {
      const exchange = buildExchange(request, reply, state);
      sink.write(exchange);
    } catch (error) {
      // Fail open: a bug or full disk in capture must never break the API.
      request.log.warn({ err: error }, "replayforge capture: dropped exchange");
    }
  });

  fastify.addHook("onClose", async () => {
    await sink.close();
  });

  function buildExchange(
    request: FastifyRequest,
    reply: FastifyReply,
    state: InFlight,
  ): CapturedExchange {
    const redactions: string[] = [];

    let requestBody: CapturedBody = { kind: "empty" };
    if (state.requestTap) {
      const { bytes, totalBytes } = state.requestTap.snapshot();
      requestBody = encodeBody(bytes, {
        contentType: request.headers["content-type"],
        totalBytes,
        maxBytes: maxBodyBytes,
      });
    }

    const exchange = {
      schemaVersion: CAPTURE_SCHEMA_VERSION,
      id: randomUUID(),
      recordingId,
      sequence: state.sequence,
      sessionKey: sessionKey(request),
      capturedAt: state.capturedAt,
      offsetMs: nsToMs(state.startedAt - recordingStartedAt),
      source,
      request: {
        method: request.method,
        url: request.url,
        route: request.routeOptions.url ?? null,
        headers: redactHeaders(
          normalizeHeaders(request.headers),
          headersToRedact,
          "request.headers",
          redactions,
        ),
        body: redactJsonBody(requestBody, bodyFieldsToRedact, "request.body", redactions),
      },
      response: {
        status: reply.statusCode,
        headers: redactHeaders(
          normalizeHeaders(reply.getHeaders()),
          headersToRedact,
          "response.headers",
          redactions,
        ),
        body: redactJsonBody(
          state.responseBody ?? { kind: "empty" },
          bodyFieldsToRedact,
          "response.body",
          redactions,
        ),
        latencyMs: nsToMs(process.hrtime.bigint() - state.startedAt),
      },
      redactions,
    };

    // Validate before writing. A bad record now becomes a confusing replay failure later.
    return CapturedExchange.parse(exchange);
  }
};

function headerString(reply: FastifyReply, name: string): string | undefined {
  const value = reply.getHeader(name);
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value.join(", ") : String(value);
}

/**
 * fastify-plugin removes Fastify's encapsulation for this plugin, so its hooks
 * apply to the WHOLE app (every route), not only to routes registered inside it.
 */
export const replayforgeCapture = fp(capturePlugin, {
  fastify: "5.x",
  name: "@replayforge/capture",
});
