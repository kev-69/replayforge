import {
  RECORDING_EVENT_VERSIONS,
  RecordingAggregate,
  parseRecordingEvent,
  recordingStreamId,
  type RecordingCommand,
  type RecordingEvent,
  type RecordingStartedPayload,
  type RecordingState,
} from "@replayforge/core";
import { handleCommand, type CommandResult } from "./command-handler.js";
import { toIso, toNumber, type Database, type SqlClient } from "./db.js";
import { EventStore, type StoredEvent } from "./event-store.js";
import { catchUp, rebuild, type Projection } from "./projector.js";

/** A row of the `recordings` read model. */
export interface RecordingSummary {
  recordingId: string;
  status: "recording" | "sealed";
  service: string;
  serviceVersion: string;
  hostname: string;
  location: string;
  sampleRate: number;
  startedAt: string;
  sealedAt: string | null;
  sealReason: string | null;
  exchangeCount: number | null;
  droppedCount: number | null;
  labels: string[];
  streamVersion: number;
}

const STREAM_PREFIX = recordingStreamId("");

function isRecordingEvent(event: StoredEvent): boolean {
  return event.streamId.startsWith(STREAM_PREFIX) && event.type in RECORDING_EVENT_VERSIONS;
}

/**
 * Keeps the `recordings` table in sync with the recording events.
 * Each event type becomes one small SQL statement.
 */
export const recordingsProjection: Projection = {
  name: "recordings",

  async reset(tx) {
    await tx.query("DELETE FROM recordings");
  },

  async apply(tx, stored) {
    if (!isRecordingEvent(stored)) return;
    const event = parseRecordingEvent(stored);
    const id = stored.streamId.slice(STREAM_PREFIX.length);
    const v = stored.streamVersion;

    switch (event.type) {
      case "RecordingStarted": {
        const p = event.payload;
        await tx.query(
          `INSERT INTO recordings (recording_id, status, service, service_version, hostname,
                                   location, sample_rate, started_at, stream_version)
           VALUES ($1, 'recording', $2, $3, $4, $5, $6, $7, $8)`,
          [
            id,
            p.service.name,
            p.service.version,
            p.service.hostname,
            p.location,
            p.settings.sampleRate,
            p.startedAt,
            v,
          ],
        );
        return;
      }
      case "RecordingLabelAdded":
        await tx.query(
          `UPDATE recordings SET labels = array_append(labels, $2), stream_version = $3
           WHERE recording_id = $1`,
          [id, event.payload.label, v],
        );
        return;
      case "RecordingLabelRemoved":
        await tx.query(
          `UPDATE recordings SET labels = array_remove(labels, $2), stream_version = $3
           WHERE recording_id = $1`,
          [id, event.payload.label, v],
        );
        return;
      case "RecordingSealed": {
        const p = event.payload;
        await tx.query(
          `UPDATE recordings
           SET status = 'sealed', sealed_at = $2, seal_reason = $3,
               exchange_count = $4, dropped_count = $5, stream_version = $6
           WHERE recording_id = $1`,
          [id, p.sealedAt, p.reason, p.exchangeCount, p.droppedCount, v],
        );
        return;
      }
    }
  },
};

function rowToSummary(row: Record<string, unknown>): RecordingSummary {
  const nullableNumber = (x: unknown) => (x === null || x === undefined ? null : toNumber(x));
  return {
    recordingId: String(row.recording_id),
    status: row.status as RecordingSummary["status"],
    service: String(row.service),
    serviceVersion: String(row.service_version),
    hostname: String(row.hostname),
    location: String(row.location),
    sampleRate: toNumber(row.sample_rate),
    startedAt: toIso(row.started_at),
    sealedAt: row.sealed_at ? toIso(row.sealed_at) : null,
    sealReason: (row.seal_reason as string | null) ?? null,
    exchangeCount: nullableNumber(row.exchange_count),
    droppedCount: nullableNumber(row.dropped_count),
    labels: (row.labels as string[] | null) ?? [],
    streamVersion: toNumber(row.stream_version),
  };
}

export type StartRecordingInput = RecordingStartedPayload;

/**
 * The public API for recordings, used by the demo API and the CLI.
 *
 *   writes  -> commands -> events  (the source of truth, `events` table)
 *   reads   -> the `recordings` projection (a derived cache)
 *
 * Writes don't touch the projection directly. Call `catchUp()` to bring it up
 * to date. That gap is EVENTUAL CONSISTENCY: right after a write, the read
 * model may briefly lag behind the events.
 */
export class Recordings {
  readonly store: EventStore;

  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.store = new EventStore(db);
  }

  start(input: StartRecordingInput) {
    return this.execute(input.recordingId, { type: "StartRecording", payload: input });
  }

  addLabel(recordingId: string, label: string) {
    return this.execute(recordingId, { type: "AddLabel", label, at: this.timestamp() });
  }

  removeLabel(recordingId: string, label: string) {
    return this.execute(recordingId, { type: "RemoveLabel", label, at: this.timestamp() });
  }

  seal(
    recordingId: string,
    seal: {
      reason: "shutdown" | "manual";
      exchangeCount?: number | null;
      droppedCount?: number | null;
    },
  ) {
    return this.execute(recordingId, {
      type: "SealRecording",
      at: this.timestamp(),
      reason: seal.reason,
      exchangeCount: seal.exchangeCount ?? null,
      droppedCount: seal.droppedCount ?? null,
    });
  }

  /** The full, typed event history of one recording, straight from the event log. */
  async history(
    recordingId: string,
  ): Promise<Array<{ stored: StoredEvent; event: RecordingEvent }>> {
    const stored = await this.store.readStream(recordingStreamId(recordingId));
    return stored.map((s) => ({ stored: s, event: parseRecordingEvent(s) }));
  }

  /** Applies any new events to the `recordings` table. Returns how many were applied. */
  catchUp(): Promise<number> {
    return catchUp(this.db, this.store, recordingsProjection);
  }

  /** Rebuilds the `recordings` table from scratch. Returns how many events were replayed. */
  rebuild(): Promise<number> {
    return rebuild(this.db, this.store, recordingsProjection);
  }

  async list(client: SqlClient = this.db): Promise<RecordingSummary[]> {
    const { rows } = await client.query(
      "SELECT * FROM recordings ORDER BY started_at DESC, recording_id",
    );
    return rows.map(rowToSummary);
  }

  async get(recordingId: string): Promise<RecordingSummary | null> {
    const { rows } = await this.db.query("SELECT * FROM recordings WHERE recording_id = $1", [
      recordingId,
    ]);
    return rows[0] ? rowToSummary(rows[0]) : null;
  }

  private execute(
    recordingId: string,
    command: RecordingCommand,
  ): Promise<CommandResult<RecordingState>> {
    return handleCommand(this.store, RecordingAggregate, recordingStreamId(recordingId), command);
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}
