import { RecordingAggregate, RecordingError, recordingStreamId } from "@replayforge/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleCommand } from "./command-handler.js";
import type { Database } from "./db.js";
import { ConcurrencyError, EventStore } from "./event-store.js";
import { Recordings, type StartRecordingInput } from "./recordings.js";
import { createTestDatabase } from "./testing.js";

let db: Database;
let recordings: Recordings;
let clock: Date;

beforeEach(async () => {
  db = await createTestDatabase();
  clock = new Date("2026-11-12T10:00:00.000Z");
  recordings = new Recordings(db, () => clock);
});

afterEach(async () => {
  await db.close();
});

const start = (id = "rec_1"): StartRecordingInput => ({
  recordingId: id,
  service: { name: "demo-api", version: "0.1.0", hostname: "box" },
  location: `/data/${id}/events.jsonl`,
  startedAt: "2026-11-12T09:00:00.000Z",
  settings: {
    sampleRate: 0.5,
    maxBodyBytes: 1024,
    redactHeaders: ["cookie"],
    redactBodyFields: [],
  },
});

describe("Recordings: commands become events", () => {
  it("records the full lifecycle as events in one stream", async () => {
    await recordings.start(start());
    await recordings.addLabel("rec_1", "baseline");
    await recordings.seal("rec_1", { reason: "shutdown", exchangeCount: 42, droppedCount: 1 });

    const history = await recordings.history("rec_1");
    expect(history.map((h) => [h.stored.streamVersion, h.event.type])).toEqual([
      [1, "RecordingStarted"],
      [2, "RecordingLabelAdded"],
      [3, "RecordingSealed"],
    ]);
  });

  it("returns [] for a command that changes nothing (idempotent retry)", async () => {
    await recordings.start(start());
    await recordings.seal("rec_1", { reason: "shutdown" });
    const again = await recordings.seal("rec_1", { reason: "manual" });
    expect(again.appended).toEqual([]);
    expect(again.version).toBe(2);
  });

  it("surfaces business errors from decide()", async () => {
    await expect(recordings.addLabel("missing", "x")).rejects.toBeInstanceOf(RecordingError);
    await recordings.start(start());
    await expect(recordings.start(start())).rejects.toThrow(/already exists/);
  });
});

describe("handleCommand: retry after a concurrency conflict", () => {
  it("reloads and decides again when another writer got there first", async () => {
    const store = new EventStore(db);
    await recordings.start(start());
    const streamId = recordingStreamId("rec_1");

    // Wrap the store so that, right before our first append, a competing
    // writer seals the recording. Our append then fails with ConcurrencyError.
    let interfered = false;
    const racingStore = {
      readStream: store.readStream.bind(store),
      append: async (...args: Parameters<EventStore["append"]>) => {
        if (!interfered) {
          interfered = true;
          await recordings.seal("rec_1", { reason: "shutdown", exchangeCount: 7 });
        }
        return store.append(...args);
      },
    };

    const result = await handleCommand(racingStore, RecordingAggregate, streamId, {
      type: "SealRecording",
      at: clock.toISOString(),
      reason: "manual",
      exchangeCount: null,
      droppedCount: null,
    });

    // Second attempt saw the competitor's seal, so decide() returned []: nothing appended.
    expect(result.appended).toEqual([]);
    const types = (await store.readStream(streamId)).map((e) => e.type);
    expect(types).toEqual(["RecordingStarted", "RecordingSealed"]); // sealed once, not twice
  });

  it("gives up after maxAttempts", async () => {
    await recordings.start(start());
    const alwaysConflicting = {
      readStream: (id: string) => recordings.store.readStream(id),
      append: async () => {
        throw new ConcurrencyError("x", 1, 2);
      },
    };
    await expect(
      handleCommand(
        alwaysConflicting,
        RecordingAggregate,
        recordingStreamId("rec_1"),
        { type: "AddLabel", label: "a", at: clock.toISOString() },
        { maxAttempts: 2 },
      ),
    ).rejects.toThrow(/expected version/);
  });
});

describe("the recordings projection", () => {
  it("is empty until catchUp() runs: reads are eventually consistent", async () => {
    await recordings.start(start());
    expect(await recordings.list()).toEqual([]);
    expect(await recordings.catchUp()).toBe(1);
    expect(await recordings.list()).toHaveLength(1);
  });

  it("projects the current state of each recording", async () => {
    await recordings.start(start());
    await recordings.addLabel("rec_1", "baseline");
    await recordings.addLabel("rec_1", "v1");
    await recordings.removeLabel("rec_1", "baseline");
    clock = new Date("2026-11-12T11:00:00.000Z");
    await recordings.seal("rec_1", { reason: "shutdown", exchangeCount: 42, droppedCount: 1 });
    await recordings.catchUp();

    expect(await recordings.get("rec_1")).toEqual({
      recordingId: "rec_1",
      status: "sealed",
      service: "demo-api",
      serviceVersion: "0.1.0",
      hostname: "box",
      location: "/data/rec_1/events.jsonl",
      sampleRate: 0.5,
      startedAt: "2026-11-12T09:00:00.000Z",
      sealedAt: "2026-11-12T11:00:00.000Z",
      sealReason: "shutdown",
      exchangeCount: 42,
      droppedCount: 1,
      labels: ["v1"],
      streamVersion: 5,
    });
  });

  it("only applies new events on each catch-up (the checkpoint moves forward)", async () => {
    await recordings.start(start("rec_1"));
    expect(await recordings.catchUp()).toBe(1);
    expect(await recordings.catchUp()).toBe(0);
    await recordings.start(start("rec_2"));
    await recordings.addLabel("rec_1", "x");
    expect(await recordings.catchUp()).toBe(2);
  });

  it("can be rebuilt from the events and ends up identical", async () => {
    await recordings.start(start("rec_1"));
    await recordings.start(start("rec_2"));
    await recordings.addLabel("rec_2", "keep");
    await recordings.seal("rec_1", { reason: "manual" });
    await recordings.catchUp();
    const before = await recordings.list();

    // Simulate a corrupted read model: someone edits the table by hand.
    await db.query("UPDATE recordings SET labels = '{oops}', status = 'recording'");
    expect((await recordings.list())[0]!.labels).toEqual(["oops"]);

    expect(await recordings.rebuild()).toBe(4);
    expect(await recordings.list()).toEqual(before);
  });

  it("ignores events from other kinds of streams", async () => {
    await recordings.store.append("replay-session-1", 0, [
      { type: "ReplayStarted", schemaVersion: 1, payload: {} },
    ]);
    await recordings.start(start());
    expect(await recordings.catchUp()).toBe(2);
    expect(await recordings.list()).toHaveLength(1);
  });
});
