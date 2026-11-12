import type { RecordingStartedPayload } from "@replayforge/core";
import type { Recordings } from "@replayforge/storage";

interface Logger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

/**
 * Records the start and end of a capture session as events.
 *
 * FAIL-OPEN, like capture itself (see docs/architecture.md): if Postgres is
 * down, the API still serves traffic and the exchanges are still written to
 * the JSONL file. Only the lifecycle events are missing, and `replayforge
 * recordings seal` can't fix a missing start either, so we log loudly.
 */
export class RecordingLifecycle {
  private startedOk = false;

  constructor(
    private readonly recordings: Recordings,
    private readonly log: Logger,
  ) {}

  async started(payload: RecordingStartedPayload): Promise<void> {
    try {
      await this.recordings.start(payload);
      await this.recordings.catchUp();
      this.startedOk = true;
      this.log.info({ recordingId: payload.recordingId }, "recording started (event stored)");
    } catch (err) {
      this.log.warn(
        { err, recordingId: payload.recordingId },
        "could not store RecordingStarted; capturing to file only",
      );
    }
  }

  async sealed(recordingId: string, stats: { written: number; dropped: number }): Promise<void> {
    if (!this.startedOk) return; // nothing to seal: the start was never stored
    try {
      await this.recordings.seal(recordingId, {
        reason: "shutdown",
        exchangeCount: stats.written,
        droppedCount: stats.dropped,
      });
      await this.recordings.catchUp();
      this.log.info({ recordingId, ...stats }, "recording sealed (event stored)");
    } catch (err) {
      this.log.warn(
        { err, recordingId },
        `could not store RecordingSealed; run: pnpm replayforge recordings seal ${recordingId}`,
      );
    }
  }
}
