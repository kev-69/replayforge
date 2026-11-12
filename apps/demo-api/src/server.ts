import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  DEFAULT_REDACT_HEADERS,
  JsonlFileSink,
  createRecordingId,
  type CaptureOptions,
} from "@replayforge/capture";
import type { CaptureSettings } from "@replayforge/core";
import { createPgDatabase, Recordings, type Database } from "@replayforge/storage";
import { buildApp } from "./app.js";
import { RecordingLifecycle } from "./recording-lifecycle.js";

/**
 * Entry point. Configuration comes from CLI flags first, then env vars:
 *   --port 3001            (PORT)
 *   --host 0.0.0.0         (HOST)
 *   --capture              (CAPTURE=on)        record traffic
 *   --recordings-dir dir   (RECORDINGS_DIR)    default ./recordings
 *   --database-url url     (DATABASE_URL)      store recording lifecycle events (optional)
 * The `pnpm dev*` scripts use CLI flags because `FOO=bar cmd` doesn't work in
 * Windows shells. Docker Compose uses env vars.
 */
const { values } = parseArgs({
  options: {
    port: { type: "string" },
    host: { type: "string" },
    capture: { type: "boolean" },
    "recordings-dir": { type: "string" },
    "database-url": { type: "string" },
  },
  strict: true,
});

const port = Number(values.port ?? process.env.PORT ?? 3001);
const host = values.host ?? process.env.HOST ?? "0.0.0.0";
const captureEnabled = values.capture ?? process.env.CAPTURE === "on";
const recordingsDir = values["recordings-dir"] ?? process.env.RECORDINGS_DIR ?? "recordings";
const databaseUrl = values["database-url"] ?? process.env.DATABASE_URL;

const SERVICE = { name: "demo-api", version: "0.1.0" };

interface Capture {
  recordingId: string;
  sink: JsonlFileSink;
  settings: CaptureSettings;
}

let capture: Capture | undefined;
if (captureEnabled) {
  // Each process run is one recording: recordings/<recordingId>/events.jsonl
  const recordingId = createRecordingId();
  const sink = await JsonlFileSink.open(join(recordingsDir, recordingId, "events.jsonl"), {
    onError: (err) =>
      console.error("capture sink failed; traffic is no longer being recorded", err),
  });
  // Spelled out (instead of relying on the plugin's defaults) because the
  // same values go into the plugin AND into the RecordingStarted event.
  const settings: CaptureSettings = {
    sampleRate: 1,
    maxBodyBytes: 1024 * 1024,
    redactHeaders: [...DEFAULT_REDACT_HEADERS],
    redactBodyFields: [],
  };
  capture = { recordingId, sink, settings };
  console.log(`capturing traffic to ${sink.filePath}`);
}

const captureOptions: CaptureOptions | undefined = capture && {
  sink: capture.sink,
  recordingId: capture.recordingId,
  service: SERVICE,
  exclude: ["/health"],
  ...capture.settings,
};
const app = buildApp({ logger: true, ...(captureOptions ? { capture: captureOptions } : {}) });

// Recording lifecycle events (Stage 2). Only when capturing AND a database is configured.
let db: Database | undefined;
let lifecycle: RecordingLifecycle | undefined;
if (capture && databaseUrl) {
  db = createPgDatabase(databaseUrl);
  lifecycle = new RecordingLifecycle(new Recordings(db), app.log);
  await lifecycle.started({
    recordingId: capture.recordingId,
    service: { ...SERVICE, hostname: hostname() },
    location: resolve(capture.sink.filePath),
    startedAt: new Date().toISOString(),
    settings: capture.settings,
  });
}

async function shutdown(): Promise<void> {
  // 1. close() runs onClose hooks; the capture plugin flushes and closes the sink there.
  await app.close();
  // 2. Only now are the sink's numbers final, so seal the recording with them.
  if (capture && lifecycle) await lifecycle.sealed(capture.recordingId, capture.sink.getStats());
  await db?.close();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, "shutting down");
    shutdown().then(
      () => process.exit(0),
      (err: unknown) => {
        app.log.error(err);
        process.exit(1);
      },
    );
  });
}

await app.listen({ port, host });
