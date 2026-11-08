import { z } from "zod";

/**
 * The shape of one captured request/response pair ("exchange").
 *
 * This is a FIRST DRAFT. Stage 2 promotes it into a proper event model in its
 * own package and adds versioning rules, and Stage 3 adds integrity hashes.
 * `schemaVersion` exists from day one so later stages can tell old recordings
 * apart from new ones.
 *
 * Zod gives us both:
 *   - a runtime validator (CapturedExchange.parse) used before anything is written, and
 *   - a static TypeScript type (z.infer) used everywhere in the code.
 */

/** A captured body. `kind` says how (or whether) the bytes were stored. */
export const CapturedBody = z.discriminatedUnion("kind", [
  /** There was no body (e.g. a GET request, or a 204 response). */
  z.object({ kind: z.literal("empty") }),
  /** Textual body (JSON, HTML, form data, ...) stored as a UTF-8 string. */
  z.object({
    kind: z.literal("text"),
    data: z.string(),
    /** Size of the ORIGINAL body in bytes, even when `truncated` is true. */
    sizeBytes: z.int().nonnegative(),
    truncated: z.boolean(),
  }),
  /** Binary body (images, protobuf, ...) stored as base64 so it survives JSON. */
  z.object({
    kind: z.literal("base64"),
    data: z.string(),
    sizeBytes: z.int().nonnegative(),
    truncated: z.boolean(),
  }),
  /** There was a body but it wasn't captured (e.g. a streamed response). */
  z.object({ kind: z.literal("omitted"), reason: z.enum(["stream"]) }),
]);
export type CapturedBody = z.infer<typeof CapturedBody>;

/** Header names are lower-case. Repeated headers (e.g. set-cookie) become arrays. */
export const HeaderMap = z.record(z.string(), z.union([z.string(), z.array(z.string())]));
export type HeaderMap = z.infer<typeof HeaderMap>;

export const CapturedExchange = z.object({
  schemaVersion: z.literal(1),
  /** Unique id of this exchange. */
  id: z.uuid(),
  /** Which recording this exchange belongs to (one per app process). */
  recordingId: z.string().min(1),
  /** Arrival order within the recording, starting at 0. */
  sequence: z.int().nonnegative(),
  /**
   * Groups requests made by the same client session (here: a hash of the
   * Authorization header). Replay uses it to keep a user's requests in order.
   */
  sessionKey: z.string().nullable(),
  /** Wall-clock time the request arrived (ISO 8601). Good for humans. */
  capturedAt: z.iso.datetime(),
  /** Milliseconds since the recording started, from a monotonic clock. Good for replay timing. */
  offsetMs: z.number().nonnegative(),
  source: z.object({
    service: z.string(),
    version: z.string(),
    hostname: z.string(),
  }),
  request: z.object({
    method: z.string(),
    /** Path plus query string exactly as received, e.g. "/api/products?category=home". */
    url: z.string(),
    /** Fastify's route pattern, e.g. "/api/products/:id". Null when no route matched (404). */
    route: z.string().nullable(),
    headers: HeaderMap,
    body: CapturedBody,
  }),
  response: z.object({
    status: z.int().min(100).max(599),
    headers: HeaderMap,
    body: CapturedBody,
    /** Time from request arrival to response sent, in milliseconds. */
    latencyMs: z.number().nonnegative(),
  }),
  /** Where values were replaced by "[REDACTED]", e.g. "request.headers.cookie". */
  redactions: z.array(z.string()),
});
export type CapturedExchange = z.infer<typeof CapturedExchange>;

export const CAPTURE_SCHEMA_VERSION = 1 as const;
