import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import { describe, expect, it } from "vitest";
import { BodyTap, encodeBody, isTextContentType } from "./body.js";

describe("isTextContentType", () => {
  it.each([
    ["application/json", true],
    ["application/json; charset=utf-8", true],
    ["application/problem+json", true],
    ["text/html", true],
    ["application/xml", true],
    ["application/x-www-form-urlencoded", true],
    ["application/octet-stream", false],
    ["image/png", false],
  ])("%s -> %s", (contentType, expected) => {
    expect(isTextContentType(contentType)).toBe(expected);
  });

  it("returns undefined when there is no content type", () => {
    expect(isTextContentType(undefined)).toBeUndefined();
  });
});

describe("encodeBody", () => {
  it("returns empty for zero bytes", () => {
    expect(encodeBody(Buffer.alloc(0), { contentType: "application/json", maxBytes: 10 })).toEqual({
      kind: "empty",
    });
  });

  it("guesses from the bytes when there is no content type", () => {
    expect(
      encodeBody(Buffer.from("héllo"), { contentType: undefined, maxBytes: 100 }),
    ).toMatchObject({ kind: "text" });
    expect(
      encodeBody(Buffer.from([0xc3, 0x28]), { contentType: undefined, maxBytes: 100 }),
    ).toMatchObject({
      kind: "base64",
    });
  });

  it("counts sizeBytes in bytes, not characters", () => {
    const body = encodeBody(Buffer.from("é"), { contentType: "text/plain", maxBytes: 100 });
    expect(body).toEqual({ kind: "text", data: "é", sizeBytes: 2, truncated: false });
  });
});

describe("BodyTap", () => {
  it("passes every byte through while keeping only the first maxBytes", async () => {
    const tap = new BodyTap(4);
    const out = text(Readable.from([Buffer.from("abc"), Buffer.from("defg")]).pipe(tap));
    expect(await out).toBe("abcdefg"); // the consumer (Fastify) gets everything
    const snap = tap.snapshot();
    expect(snap.bytes.toString()).toBe("abcd");
    expect(snap.totalBytes).toBe(7);
    expect(snap.truncated).toBe(true);
    expect(tap.receivedEncodedLength).toBe(7);
  });
});
