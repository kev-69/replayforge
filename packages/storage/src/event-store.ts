import { randomUUID } from "node:crypto";
import { isUniqueViolation, toIso, toNumber, type Database, type SqlClient } from "./db.js";

/** An event about to be appended. The store knows nothing about specific event types. */
export interface NewEvent {
  type: string;
  schemaVersion: number;
  payload: unknown;
  metadata?: Record<string, unknown>;
}

/** An event as stored, with its position in its stream and in the global log. */
export interface StoredEvent {
  eventId: string;
  streamId: string;
  /** 1-based position within the stream. */
  streamVersion: number;
  /** Position in the log of ALL events, across streams. Projections read in this order. */
  globalPosition: number;
  type: string;
  schemaVersion: number;
  payload: unknown;
  metadata: Record<string, unknown>;
  recordedAt: string;
}

/**
 * Thrown when `expectedVersion` doesn't match: someone else appended to the
 * stream after we read it. The caller should reload and decide again.
 */
export class ConcurrencyError extends Error {
  constructor(
    readonly streamId: string,
    readonly expectedVersion: number,
    readonly actualVersion: number | null,
  ) {
    super(
      `stream ${streamId}: expected version ${expectedVersion}, ` +
        `but it is at ${actualVersion ?? "a newer version"}`,
    );
    this.name = "ConcurrencyError";
  }
}

/**
 * All appends share this advisory lock, so they COMMIT one at a time.
 *
 * Why: projections read "every event after position N". `global_position`
 * comes from a sequence, and sequence numbers are handed out when a row is
 * INSERTED, not when its transaction COMMITS. Without the lock this can happen:
 *
 *   tx A inserts position 10 ......................... commits
 *   tx B inserts position 11 ... commits
 *   projector reads "after 9" -> sees only 11 -> saves checkpoint 11
 *   A commits                  -> position 10 is now visible, but behind the checkpoint: SKIPPED FOREVER
 *
 * Serializing appends makes positions become visible in order. The cost is
 * that appends can't run in parallel. That's fine at our scale; docs/architecture.md
 * covers the alternatives.
 */
const APPEND_LOCK_KEY = 7_420_001;

const COLUMNS = `event_id, stream_id, stream_version, global_position, type, schema_version,
                 payload, metadata, recorded_at`;

function rowToEvent(row: Record<string, unknown>): StoredEvent {
  return {
    eventId: String(row.event_id),
    streamId: String(row.stream_id),
    streamVersion: toNumber(row.stream_version),
    globalPosition: toNumber(row.global_position),
    type: String(row.type),
    schemaVersion: toNumber(row.schema_version),
    payload: row.payload,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    recordedAt: toIso(row.recorded_at),
  };
}

export class EventStore {
  constructor(private readonly db: Database) {}

  /**
   * Appends events to a stream, but only if the stream is currently at
   * `expectedVersion` (0 = the stream must not exist yet). This check is
   * OPTIMISTIC CONCURRENCY CONTROL: we don't lock the stream while deciding,
   * we only check at write time that nobody got there first.
   *
   * Returns the stored events. Appending [] is a no-op.
   */
  async append(
    streamId: string,
    expectedVersion: number,
    events: readonly NewEvent[],
  ): Promise<StoredEvent[]> {
    if (events.length === 0) return [];
    try {
      return await this.db.transaction(async (tx) => {
        await tx.query("SELECT pg_advisory_xact_lock($1)", [APPEND_LOCK_KEY]);

        const current = await this.currentVersion(streamId, tx);
        if (current !== expectedVersion) {
          throw new ConcurrencyError(streamId, expectedVersion, current);
        }

        const stored: StoredEvent[] = [];
        for (const [i, event] of events.entries()) {
          const { rows } = await tx.query(
            `INSERT INTO events (event_id, stream_id, stream_version, type, schema_version, payload, metadata)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
             RETURNING ${COLUMNS}`,
            [
              randomUUID(),
              streamId,
              expectedVersion + i + 1,
              event.type,
              event.schemaVersion,
              JSON.stringify(event.payload),
              JSON.stringify(event.metadata ?? {}),
            ],
          );
          stored.push(rowToEvent(rows[0]!));
        }
        return stored;
      });
    } catch (error) {
      // The UNIQUE (stream_id, stream_version) constraint is the last line of
      // defense. Even if the version check above had a bug, two writers still
      // couldn't both store "version N" of a stream.
      if (isUniqueViolation(error, "events_stream_version_unique")) {
        throw new ConcurrencyError(streamId, expectedVersion, null);
      }
      throw error;
    }
  }

  /** All events of one stream, oldest first. */
  async readStream(streamId: string, client: SqlClient = this.db): Promise<StoredEvent[]> {
    const { rows } = await client.query(
      `SELECT ${COLUMNS} FROM events WHERE stream_id = $1 ORDER BY stream_version`,
      [streamId],
    );
    return rows.map(rowToEvent);
  }

  /** Events of ALL streams with global_position > `after`, oldest first. Used by projections. */
  async readAll(after: number, limit: number, client: SqlClient = this.db): Promise<StoredEvent[]> {
    const { rows } = await client.query(
      `SELECT ${COLUMNS} FROM events WHERE global_position > $1 ORDER BY global_position LIMIT $2`,
      [after, limit],
    );
    return rows.map(rowToEvent);
  }

  /** The stream's latest version, or 0 if it has no events. */
  async currentVersion(streamId: string, client: SqlClient = this.db): Promise<number> {
    const { rows } = await client.query<{ version: unknown }>(
      "SELECT COALESCE(MAX(stream_version), 0) AS version FROM events WHERE stream_id = $1",
      [streamId],
    );
    return toNumber(rows[0]!.version);
  }
}
