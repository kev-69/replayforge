import { describe, expect, it } from "vitest";
import { REDACTED, redactHeaders, redactJsonBody, toLowerSet } from "./redact.js";
import type { CapturedBody } from "@replayforge/core";

const text = (data: string, truncated = false): CapturedBody => ({
  kind: "text",
  data,
  sizeBytes: Buffer.byteLength(data),
  truncated,
});

describe("redactHeaders", () => {
  it("redacts matching names (case-insensitive), including repeated headers", () => {
    const redactions: string[] = [];
    const out = redactHeaders(
      { "set-cookie": ["a=1", "b=2"], "content-type": "text/plain" },
      toLowerSet(["Set-Cookie"]),
      "response.headers",
      redactions,
    );
    expect(out).toEqual({ "set-cookie": [REDACTED, REDACTED], "content-type": "text/plain" });
    expect(redactions).toEqual(["response.headers.set-cookie"]);
  });
});

describe("redactJsonBody", () => {
  const fields = toLowerSet(["password", "token"]);

  it("walks objects and arrays and records each path", () => {
    const redactions: string[] = [];
    const out = redactJsonBody(
      text('{"users":[{"password":"x"},{"token":"y"}]}'),
      fields,
      "request.body",
      redactions,
    );
    expect(JSON.parse((out as { data: string }).data)).toEqual({
      users: [{ password: REDACTED }, { token: REDACTED }],
    });
    expect(redactions).toEqual(["request.body.users[0].password", "request.body.users[1].token"]);
  });

  it("returns the original body object untouched when nothing matches (bytes preserved)", () => {
    const body = text('{ "keep": "my formatting" }');
    expect(redactJsonBody(body, fields, "request.body", [])).toBe(body);
  });

  it("leaves non-JSON, truncated and binary bodies alone", () => {
    const notJson = text("password=hunter2");
    const truncated = text('{"password":"x"', true);
    const binary: CapturedBody = { kind: "base64", data: "AAAA", sizeBytes: 3, truncated: false };
    for (const body of [notJson, truncated, binary]) {
      expect(redactJsonBody(body, fields, "request.body", [])).toBe(body);
    }
  });
});
