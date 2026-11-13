import type { Database } from "@replayforge/storage";
import { Recordings } from "@replayforge/storage";
import { createTestDatabase } from "@replayforge/storage/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "./run.js";

let db: Database;
let output: string[];

beforeEach(async () => {
  db = await createTestDatabase();
  output = [];
});

afterEach(async () => {
  await db.close();
});

const cli = (...argv: string[]) => run(argv, { db, out: (line) => output.push(line) });
const printed = () => output.join("\n");

async function seedRecording(id = "rec_1") {
  await new Recordings(db).start({
    recordingId: id,
    service: { name: "demo-api", version: "0.1.0", hostname: "box" },
    location: `/data/${id}/events.jsonl`,
    startedAt: "2026-11-12T09:00:00.000Z",
    settings: { sampleRate: 1, maxBodyBytes: 1024, redactHeaders: [], redactBodyFields: [] },
  });
}

describe("replayforge CLI", () => {
  it("db migrate reports when there is nothing to do", async () => {
    expect(await cli("db", "migrate")).toBe(0);
    expect(printed()).toBe("database is up to date");
  });

  it("recordings list shows a table", async () => {
    expect(await cli("recordings", "list")).toBe(0);
    expect(printed()).toBe("no recordings yet");

    await seedRecording();
    output = [];
    await cli("recordings", "list");
    const [header, row] = printed().split("\n");
    expect(header).toMatch(/^RECORDING\s+STATUS\s+SERVICE\s+STARTED\s+EXCHANGES\s+LABELS$/);
    expect(row).toMatch(/^rec_1\s+recording\s+demo-api@0.1.0\s+2026-11-12 09:00:00\s+-\s+-$/);
  });

  it("label, unlabel and seal append events, visible in show", async () => {
    await seedRecording();
    expect(await cli("recordings", "label", "rec_1", "baseline")).toBe(0);
    expect(await cli("recordings", "label", "rec_1", "baseline")).toBe(0);
    expect(await cli("recordings", "unlabel", "rec_1", "baseline")).toBe(0);
    expect(await cli("recordings", "seal", "rec_1")).toBe(0);
    expect(output).toEqual([
      "ok (RecordingLabelAdded)",
      "nothing to change",
      "ok (RecordingLabelRemoved)",
      "sealed",
    ]);

    output = [];
    await cli("recordings", "show", "rec_1");
    expect(printed()).toContain("status      sealed (manual)");
    expect(printed()).toContain("labels      -");
    const events = output.filter((l) => l.startsWith("  #")).map((l) => l.split(/\s+/)[3]);
    expect(events).toEqual([
      "RecordingStarted",
      "RecordingLabelAdded",
      "RecordingLabelRemoved",
      "RecordingSealed",
    ]);
  });

  it("projections rebuild replays every event", async () => {
    await seedRecording("rec_1");
    await seedRecording("rec_2");
    expect(await cli("projections", "rebuild")).toBe(0);
    expect(printed()).toBe('rebuilt "recordings" from 2 events');
  });

  it("reports unknown recordings with exit code 1", async () => {
    expect(await cli("recordings", "show", "nope")).toBe(1);
    expect(await cli("recordings", "seal", "nope")).toBe(1);
    expect(output).toEqual(["error: recording nope not found", "error: recording nope not found"]);
  });

  it("prints usage with exit code 2 for bad input", async () => {
    expect(await cli()).toBe(2);
    expect(printed()).toContain("usage: replayforge");
    output = [];
    expect(await cli("recordings", "label", "rec_1")).toBe(2);
    expect(output[0]).toBe("error: expected <id> <label>\n");
  });
});
