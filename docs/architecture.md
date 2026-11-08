# Architecture: Stage 1 (HTTP traffic capture)

> This file grows with each stage. Right now it covers only **capture**:
> recording what an API received and what it answered, in a form we can replay later.

## The big picture

```
                     ┌──────────────── demo-api (Fastify) ────────────────┐
  client ──HTTP──▶   │  replayforgeCapture plugin  ──▶  your route handlers  │  ──HTTP──▶ client
  (k6, curl)         │        │                                             │
                     └────────┼─────────────────────────────────────────────┘
                              │ one CapturedExchange per request/response
                              ▼
                       CaptureSink.write()
                              │
                              ▼
            recordings/<recordingId>/events.jsonl   (one JSON object per line)
```

Code lives in two places:

| Path                                                  | What it is                                                                 |
| ----------------------------------------------------- | -------------------------------------------------------------------------- |
| [packages/capture](../packages/capture/src)           | The reusable part: the Fastify plugin, the event schema, the sinks         |
| [apps/demo-api](../apps/demo-api/src)                 | A small e-commerce API: the "system under test" whose traffic we record    |
| [apps/traffic/journey.js](../apps/traffic/journey.js) | A k6 script that simulates shoppers so there's realistic traffic to record |

`apps/demo-api` uses `@replayforge/capture` exactly like any third-party app would: it registers the plugin and passes in a sink.

---

## 1. Fastify's request lifecycle and our four hooks

Fastify runs **hooks** at fixed points while it handles a request. The capture plugin
([plugin.ts](../packages/capture/src/plugin.ts)) uses four of them:

```
request arrives
   │
   ├─ onRequest   ① start the clock, assign a sequence number, decide whether to sample
   │
   ├─ preParsing  ② put a BodyTap between the socket and the body parser (copies raw bytes)
   │   (body parsed → validation → preHandler → YOUR HANDLER runs)
   │
   ├─ onSend      ③ the response payload is serialized: copy it
   │
   │   ...bytes are written to the socket, the client has its answer...
   │
   └─ onResponse  ④ build the CapturedExchange, validate it, hand it to the sink
```

### ① `onRequest`: decide and timestamp

We record two different times, because they answer different questions:

- `capturedAt` is **wall-clock** time (`new Date()`). It's for humans: "this happened at 10:00:03".
  Wall clocks can jump (NTP corrections, daylight saving time), so they aren't good for measuring.
- `offsetMs` and `latencyMs` come from a **monotonic** clock (`process.hrtime.bigint()`). It only ever
  moves forward, so it's the right clock for durations. Stage 4's realtime replay will use
  `offsetMs` to reproduce the original gaps between requests.

**Sequence numbers are assigned on arrival.** Requests can finish out of order (a slow request
started first may finish last). The sink receives exchanges in _completion_ order, but each one
carries its _arrival_ order in `sequence`. Replay sorts by `sequence`. The test
"assigns sequence on arrival..." in [plugin.test.ts](../packages/capture/src/plugin.test.ts)
demonstrates this.

Sampling (`sampleRate`) and `exclude` also happen here. If a request isn't captured we store no
state for it, so later hooks do nothing for it.

### ② `preParsing`: the raw request body

Inside a handler, `request.body` is an already-parsed JavaScript object. Recording that would lose
information: key order, whitespace, number formatting (`1.0` becomes `1`), duplicate keys. Replay
should send **the bytes the client actually sent**.

`preParsing` lets us replace the stream Fastify reads the body from. We insert a
[`BodyTap`](../packages/capture/src/body.ts), a `Transform` stream that passes every chunk through
unchanged and keeps a copy of the first `maxBodyBytes` bytes:

```
socket ──▶ BodyTap (copies up to 1 MiB, counts everything) ──▶ Fastify's JSON parser
```

Details worth knowing:

- We use `pipeline()` instead of `.pipe()` because `.pipe()` doesn't forward errors. If the client
  disconnects halfway, `pipeline` destroys the tap too, and Fastify gets an error instead of waiting
  forever.
- Fastify checks the body size against `Content-Length` using a `receivedEncodedLength` property on
  the stream. A replacement stream has to keep it up to date, which `BodyTap` does.
- Requests without a body (most GETs) are left alone, which avoids extra work.

### ③ `onSend`: the response body

By the time `onSend` runs, Fastify has turned your handler's return value into a string or a
Buffer. We copy it and **return the payload unchanged**. This hook could also change the response,
and a capture tool must never do that.

Streamed responses (`reply.send(stream)`) are stored as `{ kind: "omitted", reason: "stream" }`.
Copying a stream means buffering all of it, and streams can be huge or never end (server-sent events).

### ④ `onResponse`: build and write after the client is done

`onResponse` runs **after** the response has been sent. Doing the expensive work here (building
the object, Zod validation, JSON serialization) means capture adds almost no latency for the client.

Everything here is wrapped in `try/catch`. This is the **fail-open** rule: a bug in capture, an
invalid record or a full disk must never turn into an error for a real user. In the worst case we
lose a recording, never a response.

---

## 2. Design decisions (and the alternatives)

### Plugin-wide hooks: `fastify-plugin`

Fastify **encapsulates** plugins: hooks added inside a plugin normally apply only to routes
registered inside that same plugin. Wrapping ours with `fastify-plugin` removes that boundary, so
the hooks apply to every route. Capture is registered _first_ in
[app.ts](../apps/demo-api/src/app.ts) so it sees everything, including 400s and 404s.

### Per-request state: `WeakMap` instead of `decorateRequest`

Each request needs some state (start time, sequence, body tap) that has to survive from `onRequest`
to `onResponse`. The idiomatic Fastify way is `fastify.decorateRequest("x", null)`, which adds a
property to every request object, and to every app's TypeScript `FastifyRequest` type. A
`WeakMap<FastifyRequest, InFlight>` keeps that state private to the plugin, and entries are
garbage-collected along with the request.

### The event format: one self-contained "exchange"

Each line in a recording is a `CapturedExchange` ([schema.ts](../packages/capture/src/schema.ts)):
a request **and** its response, together. This is a first draft that Stage 2 refines. Abridged
from a real recording:

```json
{
  "schemaVersion": 1,
  "id": "c25296c8-24b3-4dc3-aefb-765188408029",
  "recordingId": "rec_20261107T131753Z_987f21",
  "sequence": 3,
  "sessionKey": "892b2f129559b692",
  "capturedAt": "2026-11-07T13:17:53.659Z",
  "offsetMs": 391.264,
  "source": { "service": "demo-api", "version": "0.1.0", "hostname": "Kevlar" },
  "request": {
    "method": "POST",
    "url": "/api/cart/items",
    "route": "/api/cart/items",
    "headers": {
      "authorization": "Bearer Y7NT...",
      "content-type": "application/json",
      "...": "..."
    },
    "body": {
      "kind": "text",
      "data": "{\"productId\":\"prod_003\",\"quantity\":2}",
      "sizeBytes": 37,
      "truncated": false
    }
  },
  "response": {
    "status": 201,
    "headers": { "content-type": "application/json; charset=utf-8", "content-length": "135" },
    "body": {
      "kind": "text",
      "data": "{\"items\":[...],\"subtotal\":9198,\"currency\":\"USD\"}",
      "sizeBytes": 135,
      "truncated": false
    },
    "latencyMs": 2.169
  },
  "redactions": []
}
```

Fields worth noticing:

- **`schemaVersion`** exists from day one. When the format changes, old recordings can still be
  recognized and converted.
- **`route`** (`/api/products/:id`) next to **`url`** (`/api/products/prod_003`). Reports can group
  by route, and replay sends the concrete URL. It's `null` for 404s.
- **`sessionKey`** is a short SHA-256 hash of the `Authorization` header. All requests from one
  logged-in shopper share it (login itself has none, because it happens before the token exists).
  Stage 4 uses it to keep each user's requests in order during replay. It's a hash so the key can be
  logged and grouped without repeating the token.
- **`body.kind`** is a discriminated union (`empty | text | base64 | omitted`). Text stays readable
  in the file. Binary data goes in base64 because JSON can't hold raw bytes. `sizeBytes` is always the
  _original_ size, so a `truncated` body still tells you how big it really was.
- **Zod** gives both the TypeScript type (`z.infer`) and a runtime validator. Every exchange is
  validated before it's written: a malformed record is much easier to debug now than as a weird
  replay failure later.

### Redaction: privacy vs. replayability

A recording of production traffic holds secrets: session cookies, tokens, passwords. Redaction
replaces values with `"[REDACTED]"` and lists each replaced location in `redactions`, so nobody
mistakes a redacted value for real data.

**The tension:** a value you redact can't be replayed. Redact `authorization` and every replayed
request arrives unauthenticated. So the defaults redact only `cookie`, `set-cookie` and
`proxy-authorization` (the demo API doesn't use cookies), and `authorization` is kept. Body fields
are redacted by name at any depth (`redactBodyFields: ["password"]`), which is off by default for the
same reason: replaying the login needs the password.

Real tools solve this with credential substitution at replay time: redact the recorded token, then
log in fresh during replay and swap in the new token. That's exactly the correlation problem Stage 4
tackles. For a demo with fake users, keeping the token is the pragmatic choice. **Never do that with
real production credentials.**

### Sinks: why JSON Lines, and why `write()` never waits

[`JsonlFileSink`](../packages/capture/src/sinks.ts) appends one JSON object per line:

- **Appending is cheap.** A JSON array would need its closing `]` rewritten on every write.
- **Crashes do limited damage.** A crash mid-write can break at most the last line; every earlier
  line is still valid. Stage 3 detects that broken last line.
- **It streams.** A reader can process a 50,000-request recording line by line with constant memory.

`write()` is **synchronous and returns nothing**. The plugin hands over an exchange and moves on.
Node's `WriteStream` queues data in memory and writes it to disk in the background.

**Backpressure** means a producer (our API) is faster than a consumer (the disk). There are three
options when that happens: block the API (bad: capture would slow down production), buffer without
limit (bad: memory grows until the process crashes), or **drop and count**. We pick the third: if more
than `maxBufferedBytes` (16 MiB) is waiting for the disk, new exchanges are dropped and counted in
`getStats().dropped`. Capture loses data before the API loses performance.

The sink also listens for stream `'error'` events. In Node, an unhandled `'error'` event crashes the
process, so a disk error would take the API down with it.

`MemorySink` stores exchanges in an array. Tests use it to look at exactly what was captured.

---

## 3. What capture can't see (known blind spots)

Seeing the gaps in a tool is part of understanding it:

- **Headers added by Node itself.** `date`, `connection` and `keep-alive` are added by Node's HTTP
  layer when it writes to the socket, which happens after Fastify's hooks run, so they aren't in the
  captured response headers. You can see this in the real recording above.
- **Work done by later plugins.** If a compression plugin is registered _after_ capture, its
  `onSend` runs after ours, so we record the uncompressed body. Usually that's what you want.
- **Aborted requests.** If the client disconnects before the response is sent, `onResponse` may
  never fire and the exchange is never written. Its `WeakMap` entry is just garbage-collected.
- **Exchanges still in the queue at a hard kill.** `app.close()` runs the plugin's `onClose` hook,
  which flushes the sink. `kill -9` (or `taskkill /F`) skips that. Anything still queued in memory is
  lost, and the last line may be half-written.
- **Truncated and streamed bodies** can't be replayed byte-for-byte. They're marked so later stages
  can skip or flag them.

---

## 4. Toolchain notes

- **pnpm workspace.** `packages/*` and `apps/*` are separate packages. `apps/demo-api` depends on
  `"@replayforge/capture": "workspace:*"`, which pnpm links from this repo instead of downloading.
- **No build step.** Each package's `exports` points at its TypeScript source (`./src/index.ts`).
  `tsx` runs TS directly, Vitest compiles it on the fly, and `tsc` only type-checks (`noEmit`).
  That's simple for now. A package published to npm would need a compiled `dist/`.
- **ESM with `.js` import extensions.** `import { x } from "./body.js"` while the file is `body.ts`.
  That's how Node's native ES modules resolve files, and TypeScript's `NodeNext` mode requires it.
- **Strict TypeScript.** `noUncheckedIndexedAccess` makes `array[0]` typed `T | undefined`, and
  `exactOptionalPropertyTypes` stops you from passing `undefined` to an optional field by accident.
- **Versions:** TypeScript is pinned to 6.0 because typescript-eslint doesn't support 7 yet, and
  undici isn't used yet (version 8 needs Node 22.19+, and this machine has 22.14).

---

## 5. Things to try while studying

1. Run the API with capture on (`pnpm dev:capture`), use it, and open the newest
   `recordings/*/events.jsonl`. Find your requests and work out what each field means.
2. Change `maxBodyBytes` to `20` in [server.ts](../apps/demo-api/src/server.ts) and see a truncated body.
3. Add `redactBodyFields: ["password", "token"]` and log in. Look at what the login exchange contains
   now, and think about what this would break when we replay it in Stage 4.
4. Set `sampleRate: 0.5` and check that the `sequence` numbers stay continuous (they count
   _captured_ requests only). Is that a good idea? Hint: what would a gap tell you?
5. Read the test named "assigns sequence on arrival..." in
   [plugin.test.ts](../packages/capture/src/plugin.test.ts) and explain why the order of `sink.exchanges` is different from `sequence`.
6. Comment out the `stream.on("error", ...)` listener in [sinks.ts](../packages/capture/src/sinks.ts)
   and think through what happens when the disk fills up.
