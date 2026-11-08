import { isUtf8 } from "node:buffer";
import { Transform, type TransformCallback } from "node:stream";
import type { CapturedBody } from "./schema.js";

/**
 * A pass-through stream that keeps a copy of the first `maxBytes` bytes that
 * flow through it and counts the rest.
 *
 * The capture plugin puts one of these between the raw socket and Fastify's
 * body parser. Fastify still parses the body as usual, and we keep the exact
 * bytes the client sent: same key order, whitespace and encoding. A parsed
 * object would lose those details, and they can matter during replay.
 */
export class BodyTap extends Transform {
  private readonly chunks: Buffer[] = [];
  private keptBytes = 0;
  private totalBytes = 0;

  /**
   * Fastify reads this property to check the body length against the
   * Content-Length header, so any stream returned from a preParsing hook
   * has to keep it up to date.
   */
  receivedEncodedLength = 0;

  constructor(private readonly maxBytes: number) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.totalBytes += chunk.length;
    this.receivedEncodedLength = this.totalBytes;
    const room = this.maxBytes - this.keptBytes;
    if (room > 0) {
      const kept = chunk.length <= room ? chunk : chunk.subarray(0, room);
      this.chunks.push(kept);
      this.keptBytes += kept.length;
    }
    callback(null, chunk); // always pass the full chunk on to Fastify
  }

  snapshot(): { bytes: Buffer; totalBytes: number; truncated: boolean } {
    return {
      bytes: Buffer.concat(this.chunks),
      totalBytes: this.totalBytes,
      truncated: this.totalBytes > this.keptBytes,
    };
  }
}

const TEXT_TYPE =
  /^text\/|[/+](json|xml)\b|^application\/(x-www-form-urlencoded|javascript|graphql)\b/i;

/** Should a body with this Content-Type be stored as text? */
export function isTextContentType(contentType: string | undefined): boolean | undefined {
  if (!contentType) return undefined; // unknown: decide from the bytes
  return TEXT_TYPE.test(contentType);
}

/**
 * Turns body bytes into a CapturedBody.
 * Text is stored as UTF-8 so a recording stays readable; anything else goes in base64.
 */
export function encodeBody(
  bytes: Buffer,
  options: { contentType: string | undefined; totalBytes?: number; maxBytes: number },
): CapturedBody {
  const totalBytes = options.totalBytes ?? bytes.length;
  if (totalBytes === 0) return { kind: "empty" };

  const kept = bytes.length > options.maxBytes ? bytes.subarray(0, options.maxBytes) : bytes;
  const truncated = totalBytes > kept.length;
  // With no Content-Type, guess from the bytes: valid UTF-8 is treated as text.
  const asText = isTextContentType(options.contentType) ?? isUtf8(kept);

  return asText
    ? { kind: "text", data: kept.toString("utf8"), sizeBytes: totalBytes, truncated }
    : { kind: "base64", data: kept.toString("base64"), sizeBytes: totalBytes, truncated };
}
