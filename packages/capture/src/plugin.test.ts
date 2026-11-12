import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { authorizationSessionKey, replayforgeCapture, type CaptureOptions } from "./plugin.js";
import { CapturedExchange } from "@replayforge/core";
import { MemorySink, type CaptureSink } from "./sinks.js";

let app: FastifyInstance;

afterEach(async () => {
  await app?.close();
});

/** A small app with one route per behavior we want to observe. */
async function setup(options: Partial<CaptureOptions> = {}) {
  const sink = new MemorySink();
  app = Fastify();
  await app.register(replayforgeCapture, {
    sink,
    service: { name: "test-api", version: "1.2.3" },
    ...options,
  });
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_req, body, done) =>
    done(null, body),
  );
  app.post("/echo", async (request) => ({ received: request.body }));
  app.post("/bytes", async (request, reply) =>
    reply.type("application/octet-stream").send(request.body as Buffer),
  );
  app.get("/items/:id", async (request) => ({ id: (request.params as { id: string }).id }));
  app.get("/slow", async () => {
    await delay(20);
    return { ok: true };
  });
  app.get("/stream", async (_request, reply) =>
    reply.type("text/plain").send(Readable.from(["a", "b"])),
  );
  app.get("/no-content", async (_request, reply) => reply.code(204).send());
  app.get("/health", async () => ({ ok: true }));
  return sink;
}

const only = (sink: MemorySink): CapturedExchange => {
  expect(sink.exchanges).toHaveLength(1);
  return sink.exchanges[0]!;
};

describe("replayforgeCapture", () => {
  it("captures a JSON round trip and produces a schema-valid exchange", async () => {
    const sink = await setup({ recordingId: "rec_test" });
    const res = await app.inject({ method: "POST", url: "/echo?x=1", payload: { hello: "world" } });
    expect(res.statusCode).toBe(200);

    const ex = only(sink);
    expect(() => CapturedExchange.parse(ex)).not.toThrow();
    expect(ex).toMatchObject({
      schemaVersion: 1,
      recordingId: "rec_test",
      sequence: 0,
      source: { service: "test-api", version: "1.2.3" },
      request: {
        method: "POST",
        url: "/echo?x=1",
        route: "/echo",
        body: { kind: "text", data: '{"hello":"world"}', truncated: false },
      },
      response: {
        status: 200,
        body: { kind: "text", data: '{"received":{"hello":"world"}}' },
      },
    });
    expect(ex.request.headers["content-type"]).toBe("application/json");
    expect(ex.response.headers["content-type"]).toMatch(/^application\/json/);
  });

  it("keeps the exact raw request bytes, not a re-serialized object", async () => {
    const sink = await setup();
    const raw = '{ "b": 2,\n  "a": 1 }'; // odd spacing and key order on purpose
    await app.inject({
      method: "POST",
      url: "/echo",
      payload: raw,
      headers: { "content-type": "application/json" },
    });
    expect(only(sink).request.body).toEqual({
      kind: "text",
      data: raw,
      sizeBytes: raw.length,
      truncated: false,
    });
  });

  it("stores binary bodies as base64", async () => {
    const sink = await setup();
    const bytes = Buffer.from([0x00, 0xff, 0x10, 0x80]);
    await app.inject({
      method: "POST",
      url: "/bytes",
      payload: bytes,
      headers: { "content-type": "application/octet-stream" },
    });
    const ex = only(sink);
    expect(ex.request.body).toEqual({
      kind: "base64",
      data: bytes.toString("base64"),
      sizeBytes: 4,
      truncated: false,
    });
    expect(ex.response.body).toMatchObject({ kind: "base64", data: bytes.toString("base64") });
  });

  it("truncates bodies over maxBodyBytes but still reports the full size", async () => {
    const sink = await setup({ maxBodyBytes: 10 });
    const big = JSON.stringify({ text: "x".repeat(100) });
    const res = await app.inject({
      method: "POST",
      url: "/echo",
      payload: big,
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(200); // the app still received the whole body
    expect(only(sink).request.body).toEqual({
      kind: "text",
      data: big.slice(0, 10),
      sizeBytes: big.length,
      truncated: true,
    });
  });

  it("records empty bodies for GET requests and 204 responses", async () => {
    const sink = await setup();
    await app.inject({ method: "GET", url: "/no-content" });
    const ex = only(sink);
    expect(ex.request.body).toEqual({ kind: "empty" });
    expect(ex.response.status).toBe(204);
    expect(ex.response.body).toEqual({ kind: "empty" });
  });

  it("does not copy streamed responses", async () => {
    const sink = await setup();
    const res = await app.inject({ method: "GET", url: "/stream" });
    expect(res.body).toBe("ab");
    expect(only(sink).response.body).toEqual({ kind: "omitted", reason: "stream" });
  });

  it("captures requests that match no route (404) with route = null", async () => {
    const sink = await setup();
    await app.inject({ method: "GET", url: "/does-not-exist" });
    const ex = only(sink);
    expect(ex.response.status).toBe(404);
    expect(ex.request.route).toBeNull();
  });

  it("records the route pattern, not the concrete URL", async () => {
    const sink = await setup();
    await app.inject({ method: "GET", url: "/items/42" });
    expect(only(sink).request).toMatchObject({ url: "/items/42", route: "/items/:id" });
  });

  it("measures latency with a monotonic clock", async () => {
    const sink = await setup();
    await app.inject({ method: "GET", url: "/slow" });
    expect(only(sink).response.latencyMs).toBeGreaterThanOrEqual(15);
  });

  it("numbers requests in arrival order and offsets never go backwards", async () => {
    const sink = await setup();
    for (let i = 0; i < 5; i++) await app.inject({ method: "GET", url: `/items/${i}` });
    expect(sink.exchanges.map((e) => e.sequence)).toEqual([0, 1, 2, 3, 4]);
    const offsets = sink.exchanges.map((e) => e.offsetMs);
    expect([...offsets].sort((a, b) => a - b)).toEqual(offsets);
  });

  it("assigns sequence on arrival, so a slow request keeps its place even if it finishes last", async () => {
    const sink = await setup();
    await Promise.all([
      app.inject({ method: "GET", url: "/slow" }),
      app.inject({ method: "GET", url: "/items/1" }),
    ]);
    // Written in completion order (fast one first), numbered in arrival order.
    expect(sink.exchanges.map((e) => [e.request.url, e.sequence])).toEqual([
      ["/items/1", 1],
      ["/slow", 0],
    ]);
  });

  describe("redaction", () => {
    it("redacts cookie headers by default but keeps authorization", async () => {
      const sink = await setup();
      await app.inject({
        method: "GET",
        url: "/items/1",
        headers: { cookie: "sid=secret", authorization: "Bearer abc" },
      });
      const ex = only(sink);
      expect(ex.request.headers.cookie).toBe("[REDACTED]");
      expect(ex.request.headers.authorization).toBe("Bearer abc");
      expect(ex.redactions).toEqual(["request.headers.cookie"]);
    });

    it("redacts JSON body fields at any depth, in requests and responses", async () => {
      const sink = await setup({ redactBodyFields: ["password"] });
      await app.inject({
        method: "POST",
        url: "/echo",
        payload: { user: "a", nested: { Password: "hunter2" } },
      });
      const ex = only(sink);
      expect(JSON.parse((ex.request.body as { data: string }).data)).toEqual({
        user: "a",
        nested: { Password: "[REDACTED]" },
      });
      expect(ex.redactions).toEqual([
        "request.body.nested.Password",
        "response.body.received.nested.Password",
      ]);
      expect(ex.response.body).toMatchObject({ kind: "text" });
      expect((ex.response.body as { data: string }).data).not.toContain("hunter2");
    });
  });

  describe("filtering", () => {
    it("skips excluded paths (with or without a query string)", async () => {
      const sink = await setup({ exclude: ["/health", /^\/items\//] });
      await app.inject({ method: "GET", url: "/health?probe=1" });
      await app.inject({ method: "GET", url: "/items/1" });
      await app.inject({ method: "GET", url: "/no-content" });
      expect(sink.exchanges.map((e) => e.request.url)).toEqual(["/no-content"]);
    });

    it("samples a fraction of requests", async () => {
      const draws = [0.1, 0.9, 0.4, 0.6];
      const sink = await setup({ sampleRate: 0.5, random: () => draws.shift()! });
      for (let i = 0; i < 4; i++) await app.inject({ method: "GET", url: `/items/${i}` });
      expect(sink.exchanges.map((e) => e.request.url)).toEqual(["/items/0", "/items/2"]);
      // sequence counts captured requests only
      expect(sink.exchanges.map((e) => e.sequence)).toEqual([0, 1]);
    });

    it("rejects an invalid sampleRate at registration", async () => {
      app = Fastify();
      await expect(
        app.register(replayforgeCapture, {
          sink: new MemorySink(),
          service: { name: "x", version: "1" },
          sampleRate: 2,
        }),
      ).rejects.toThrow(/sampleRate/);
    });
  });

  describe("session keys", () => {
    it("groups requests by hashed Authorization header", async () => {
      const sink = await setup();
      const get = (authorization?: string) =>
        app.inject({
          method: "GET",
          url: "/items/1",
          headers: authorization ? { authorization } : {},
        });
      await get("Bearer A");
      await get("Bearer A");
      await get("Bearer B");
      await get();
      const [a1, a2, b, none] = sink.exchanges.map((e) => e.sessionKey);
      expect(a1).toBe(a2);
      expect(a1).not.toBe(b);
      expect(a1).toMatch(/^[0-9a-f]{16}$/);
      expect(a1).not.toContain("A"); // it's a hash, not the token
      expect(none).toBeNull();
    });

    it("accepts a custom sessionKey function", async () => {
      const sink = await setup({
        sessionKey: (req) => (req.headers["x-client-id"] as string) ?? null,
      });
      await app.inject({ method: "GET", url: "/items/1", headers: { "x-client-id": "client-7" } });
      expect(only(sink).sessionKey).toBe("client-7");
    });

    it("authorizationSessionKey is exported for reuse", () => {
      expect(authorizationSessionKey).toBeTypeOf("function");
    });
  });

  describe("fail-open", () => {
    it("serves the response normally even if the sink throws", async () => {
      const broken: CaptureSink = {
        write() {
          throw new Error("disk on fire");
        },
        async close() {},
      };
      app = Fastify();
      await app.register(replayforgeCapture, {
        sink: broken,
        service: { name: "x", version: "1" },
      });
      app.get("/", async () => ({ ok: true }));
      const res = await app.inject({ method: "GET", url: "/" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
    });
  });

  it("closes the sink when Fastify closes", async () => {
    const sink = await setup();
    await app.close();
    expect(sink.closed).toBe(true);
  });
});
