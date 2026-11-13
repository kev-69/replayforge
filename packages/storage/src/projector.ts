import { toNumber, type Database, type SqlClient } from "./db.js";
import type { EventStore, StoredEvent } from "./event-store.js";

/**
 * A projection turns the event log into a table that's easy to query.
 *
 * The event log is great for writing ("what happened?") and bad for questions
 * like "list all sealed recordings, newest first". A projection answers those:
 * it reads every event once, in global order, and keeps a read-model table up to date.
 */
export interface Projection {
  /** Unique name, used as the checkpoint key. */
  name: string;
  /** Applies one event. Must ignore event types it doesn't care about. */
  apply(tx: SqlClient, event: StoredEvent): Promise<void>;
  /** Empties the read model, for a rebuild. */
  reset(tx: SqlClient): Promise<void>;
}

const BATCH_SIZE = 500;

/**
 * Brings a projection up to date ("catch-up subscription").
 *
 * Each batch runs in ONE transaction that both updates the read model and
 * moves the checkpoint. Either both happen or neither does, so after a crash
 * we resume exactly where we left off and never apply an event twice or skip
 * one. That gives exactly-once processing without any extra bookkeeping.
 *
 * Returns how many events were applied.
 */
export async function catchUp(
  db: Database,
  store: EventStore,
  projection: Projection,
): Promise<number> {
  let total = 0;
  for (;;) {
    const applied = await db.transaction(async (tx) => {
      // FOR UPDATE locks the checkpoint row: two catch-ups of the same
      // projection running at once queue up instead of applying events twice.
      await tx.query(
        "INSERT INTO projection_checkpoints (name, position) VALUES ($1, 0) ON CONFLICT (name) DO NOTHING",
        [projection.name],
      );
      const { rows } = await tx.query<{ position: unknown }>(
        "SELECT position FROM projection_checkpoints WHERE name = $1 FOR UPDATE",
        [projection.name],
      );
      const position = toNumber(rows[0]!.position);

      const events = await store.readAll(position, BATCH_SIZE, tx);
      for (const event of events) await projection.apply(tx, event);

      if (events.length > 0) {
        await tx.query("UPDATE projection_checkpoints SET position = $2 WHERE name = $1", [
          projection.name,
          events.at(-1)!.globalPosition,
        ]);
      }
      return events.length;
    });
    total += applied;
    if (applied < BATCH_SIZE) return total;
  }
}

/**
 * Throws the read model away and rebuilds it from the very first event.
 *
 * This is the payoff of event sourcing. A projection with a bug, or a brand-new
 * projection, can be (re)computed from history because the events are the
 * source of truth and the tables are only a cache.
 */
export async function rebuild(
  db: Database,
  store: EventStore,
  projection: Projection,
): Promise<number> {
  await db.transaction(async (tx) => {
    await projection.reset(tx);
    await tx.query(
      `INSERT INTO projection_checkpoints (name, position) VALUES ($1, 0)
       ON CONFLICT (name) DO UPDATE SET position = 0`,
      [projection.name],
    );
  });
  return catchUp(db, store, projection);
}
