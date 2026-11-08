import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { once } from "node:events";
import type { CapturedExchange } from "./schema.js";

/**
 * A sink is where captured exchanges go.
 *
 * `write` is deliberately SYNCHRONOUS and returns nothing. The capture plugin
 * calls it after the response has been sent and never waits on it, so a slow
 * disk can't slow down the API. If a sink can't keep up, it drops events and
 * counts them, which is better than using unbounded memory.
 */
export interface CaptureSink {
  write(exchange: CapturedExchange): void;
  /** Flush everything still buffered and release resources. */
  close(): Promise<void>;
}

/** Keeps exchanges in an array. Used in tests. */
export class MemorySink implements CaptureSink {
  readonly exchanges: CapturedExchange[] = [];
  closed = false;

  write(exchange: CapturedExchange): void {
    this.exchanges.push(exchange);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export interface JsonlFileSinkOptions {
  /**
   * If more than this many bytes are waiting to reach the disk, new events
   * are dropped instead of buffered. Default 16 MiB.
   */
  maxBufferedBytes?: number;
  /** Called (once per error) when the file can't be written. */
  onError?: (error: Error) => void;
}

export interface SinkStats {
  written: number;
  dropped: number;
}

/**
 * Appends one JSON object per line ("JSON Lines", .jsonl) to a file.
 *
 * Why JSONL instead of one big JSON array?
 *   - Appending is O(1): no need to rewrite a closing `]`.
 *   - A crash mid-write damages at most the last line; every earlier line is still valid.
 *   - Readers can stream it line by line with constant memory (Stage 3 relies on this).
 *
 * Buffering comes from Node's WriteStream. `write()` queues data in memory and
 * the stream writes it to disk in the background, batching queued chunks
 * together. `writableLength` reports how many bytes are queued, which is
 * how we detect that the disk is falling behind (backpressure).
 */
export class JsonlFileSink implements CaptureSink {
  private readonly maxBufferedBytes: number;
  private failed = false;
  private closed = false;
  private readonly stats: SinkStats = { written: 0, dropped: 0 };

  private constructor(
    readonly filePath: string,
    private readonly stream: WriteStream,
    options: JsonlFileSinkOptions,
  ) {
    this.maxBufferedBytes = options.maxBufferedBytes ?? 16 * 1024 * 1024;
    // Without an 'error' listener, a disk error would crash the whole process.
    // Capture must fail open, so we only remember the error and stop writing.
    stream.on("error", (error) => {
      if (this.failed) return;
      this.failed = true;
      options.onError?.(error);
    });
  }

  /** Creates the parent directory and opens `filePath` for appending. */
  static async open(filePath: string, options: JsonlFileSinkOptions = {}): Promise<JsonlFileSink> {
    await mkdir(dirname(filePath), { recursive: true });
    const stream = createWriteStream(filePath, { flags: "a", encoding: "utf8" });
    await once(stream, "open"); // surface "permission denied" etc. now, not on the first write
    return new JsonlFileSink(filePath, stream, options);
  }

  write(exchange: CapturedExchange): void {
    if (this.closed || this.failed || this.stream.writableLength > this.maxBufferedBytes) {
      this.stats.dropped++;
      return;
    }
    this.stream.write(JSON.stringify(exchange) + "\n");
    this.stats.written++;
  }

  getStats(): SinkStats {
    return { ...this.stats };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.failed) {
      this.stream.destroy();
      return;
    }
    // end() flushes everything still queued; 'finish' means it all reached the OS.
    await new Promise<void>((resolve) => this.stream.end(resolve));
  }
}
