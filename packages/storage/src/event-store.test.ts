import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "./db.js";
import { ConcurrencyError, EventStore, type NewEvent } from "./event-store.js";
import { migrate } from "./migrate.js";
import { createTestDatabase } from "./testing.js";

let db: Database;
let store: EventStore;

beforeEach(async () => {
  db = await createTestDatabase();
  store = new EventStore(db);
});

afterEach(async () => {
  await db.close();
});

const event = (n: number): NewEvent => ({ type: "Something", schemaVersion: 1, payload: { n } });

describe("EventStore", () => {
  it("appends to a new stream with expectedVersion 0 and reads it back in order", async () => {
    const stored = await store.append("s-1", 0, [event(1), event(2)]);
    expect(stored.map((e) => e.streamVersion)).toEqual([1, 2]);

    const read = await store.readStream("s-1");
    expect(read.map((e) => e.payload)).toEqual([{ n: 1 }, { n: 2 }]);
    expect(read[0]).toMatchObject({
      streamId: "s-1",
      type: "Something",
      schemaVersion: 1,
      metadata: {},
    });
    expect(read[0]!.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Date.parse(read[0]!.recordedAt)).not.toBeNaN();
  });

  it("continues a stream from its current version", async () => {
    await store.append("s-1", 0, [event(1)]);
    await store.append("s-1", 1, [event(2)]);
    expect(await store.currentVersion("s-1")).toBe(2);
  });

  it("rejects an append when the stream moved on (optimistic concurrency)", async () => {
    await store.append("s-1", 0, [event(1)]);
    // A second writer still thinks the stream is empty:
    const stale = store.append("s-1", 0, [event(99)]);
    await expect(stale).rejects.toBeInstanceOf(ConcurrencyError);
    await expect(stale).rejects.toThrow("expected version 0, but it is at 1");
    // Nothing from the failed append was written:
    expect((await store.readStream("s-1")).map((e) => e.payload)).toEqual([{ n: 1 }]);
  });

  it("lets exactly one of two racing writers win", async () => {
    const results = await Promise.allSettled([
      store.append("s-1", 0, [event(1)]),
      store.append("s-1", 0, [event(2)]),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const [failure] = results.filter((r) => r.status === "rejected");
    expect((failure as PromiseRejectedResult).reason).toBeInstanceOf(ConcurrencyError);
  });

  it("keeps streams independent but orders everything globally", async () => {
    await store.append("a", 0, [event(1)]);
    await store.append("b", 0, [event(2)]);
    await store.append("a", 1, [event(3)]);

    const all = await store.readAll(0, 100);
    expect(all.map((e) => [e.streamId, e.streamVersion])).toEqual([
      ["a", 1],
      ["b", 1],
      ["a", 2],
    ]);
    const positions = all.map((e) => e.globalPosition);
    expect([...positions].sort((x, y) => x - y)).toEqual(positions);

    // readAll(after, limit) pages through the log
    const page = await store.readAll(all[0]!.globalPosition, 1);
    expect(page.map((e) => e.payload)).toEqual([{ n: 2 }]);
  });

  it("stores metadata next to the payload", async () => {
    await store.append("s-1", 0, [{ ...event(1), metadata: { actor: "cli" } }]);
    expect((await store.readStream("s-1"))[0]!.metadata).toEqual({ actor: "cli" });
  });

  it("treats an empty append as a no-op", async () => {
    expect(await store.append("s-1", 5, [])).toEqual([]);
    expect(await store.currentVersion("s-1")).toBe(0);
  });

  it("refuses to UPDATE or DELETE events: the log is append-only", async () => {
    await store.append("s-1", 0, [event(1)]);
    await expect(db.query("UPDATE events SET payload = '{}'::jsonb")).rejects.toThrow(
      /append-only/,
    );
    await expect(db.query("DELETE FROM events")).rejects.toThrow(/append-only/);
  });
});

describe("migrate", () => {
  it("is idempotent: running it again applies nothing", async () => {
    // createTestDatabase already migrated once
    expect(await migrate(db)).toEqual({ applied: [] });
    const { rows } = await db.query<{ version: string }>(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    expect(rows.map((r) => r.version)).toEqual(["001_event_store", "002_recordings_projection"]);
  });
});
