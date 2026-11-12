import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CapturedExchange } from "@replayforge/core";
import { JsonlFileSink } from "./sinks.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "replayforge-sink-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function exchange(sequence: number): CapturedExchange {
  return {
    schemaVersion: 1,
    id: randomUUID(),
    recordingId: "rec_test",
    sequence,
    sessionKey: null,
    capturedAt: new Date().toISOString(),
    offsetMs: sequence,
    source: { service: "s", version: "1", hostname: "h" },
    request: { method: "GET", url: "/", route: "/", headers: {}, body: { kind: "empty" } },
    response: {
      status: 200,
      headers: {},
      body: { kind: "text", data: "ok", sizeBytes: 2, truncated: false },
      latencyMs: 1,
    },
    redactions: [],
  };
}

const readLines = async (file: string) => (await readFile(file, "utf8")).split("\n");

describe("JsonlFileSink", () => {
  it("creates missing directories and writes one valid JSON object per line", async () => {
    const file = join(dir, "rec_test", "events.jsonl");
    const sink = await JsonlFileSink.open(file);
    for (let i = 0; i < 3; i++) sink.write(exchange(i));
    await sink.close();

    const lines = await readLines(file);
    expect(lines.at(-1)).toBe(""); // file ends with a newline
    const parsed = lines.slice(0, -1).map((l) => CapturedExchange.parse(JSON.parse(l)));
    expect(parsed.map((e) => e.sequence)).toEqual([0, 1, 2]);
    expect(sink.getStats()).toEqual({ written: 3, dropped: 0 });
  });

  it("appends to an existing file instead of overwriting it", async () => {
    const file = join(dir, "events.jsonl");
    const first = await JsonlFileSink.open(file);
    first.write(exchange(0));
    await first.close();
    const second = await JsonlFileSink.open(file);
    second.write(exchange(1));
    await second.close();
    expect((await readLines(file)).filter(Boolean)).toHaveLength(2);
  });

  it("drops (and counts) writes after close instead of throwing", async () => {
    const sink = await JsonlFileSink.open(join(dir, "events.jsonl"));
    await sink.close();
    sink.write(exchange(0));
    expect(sink.getStats()).toEqual({ written: 0, dropped: 1 });
  });

  it("drops events when too much data is waiting for the disk (backpressure)", async () => {
    const sink = await JsonlFileSink.open(join(dir, "events.jsonl"), { maxBufferedBytes: 0 });
    // The first write is accepted and fills the queue; the next ones arrive
    // while it's still in flight, so they are over the 0-byte budget.
    sink.write(exchange(0));
    sink.write(exchange(1));
    sink.write(exchange(2));
    await sink.close();
    expect(sink.getStats()).toEqual({ written: 1, dropped: 2 });
  });

  it("rejects at open time if the file can't be created", async () => {
    // A path *inside* a regular file can never be created.
    const blocker = join(dir, "not-a-dir");
    const s = await JsonlFileSink.open(blocker);
    await s.close();
    await expect(JsonlFileSink.open(join(blocker, "events.jsonl"))).rejects.toThrow();
  });
});
