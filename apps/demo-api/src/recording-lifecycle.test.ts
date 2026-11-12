import { Recordings, type Database } from "@replayforge/storage";
import { createTestDatabase } from "@replayforge/storage/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RecordingLifecycle } from "./recording-lifecycle.js";

let db: Database;
let warnings: string[];
const log = {
  info: () => {},
  warn: (_obj: object, msg: string) => warnings.push(msg),
};

beforeEach(async () => {
  db = await createTestDatabase();
  warnings = [];
});

afterEach(async () => {
  await db.close();
});

const startPayload = {
  recordingId: "rec_1",
  service: { name: "demo-api", version: "0.1.0", hostname: "box" },
  location: "/data/rec_1/events.jsonl",
  startedAt: "2026-11-12T09:00:00.000Z",
  settings: { sampleRate: 1, maxBodyBytes: 1024, redactHeaders: [], redactBodyFields: [] },
};

describe("RecordingLifecycle", () => {
  it("stores started and sealed events and updates the projection", async () => {
    const recordings = new Recordings(db);
    const lifecycle = new RecordingLifecycle(recordings, log);

    await lifecycle.started(startPayload);
    expect((await recordings.get("rec_1"))?.status).toBe("recording");

    await lifecycle.sealed("rec_1", { written: 12, dropped: 3 });
    expect(await recordings.get("rec_1")).toMatchObject({
      status: "sealed",
      sealReason: "shutdown",
      exchangeCount: 12,
      droppedCount: 3,
    });
    expect(warnings).toEqual([]);
  });

  it("fails open: a broken database only produces warnings", async () => {
    await db.close(); // every query will now fail
    const lifecycle = new RecordingLifecycle(new Recordings(db), log);

    await expect(lifecycle.started(startPayload)).resolves.toBeUndefined();
    await expect(lifecycle.sealed("rec_1", { written: 1, dropped: 0 })).resolves.toBeUndefined();
    expect(warnings).toEqual(["could not store RecordingStarted; capturing to file only"]);
    db = await createTestDatabase(); // so afterEach has something to close
  });
});
