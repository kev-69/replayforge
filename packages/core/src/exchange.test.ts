import { describe, expect, it } from "vitest";
import {
  CAPTURE_SCHEMA_VERSION,
  UnsupportedSchemaVersionError,
  parseExchange,
} from "./exchange.js";

const v1 = {
  schemaVersion: 1,
  id: "c25296c8-24b3-4dc3-aefb-765188408029",
  recordingId: "rec_1",
  sequence: 0,
  sessionKey: null,
  capturedAt: "2026-11-12T10:00:00.000Z",
  offsetMs: 0,
  source: { service: "demo-api", version: "0.1.0", hostname: "box" },
  request: { method: "GET", url: "/", route: "/", headers: {}, body: { kind: "empty" } },
  response: { status: 200, headers: {}, body: { kind: "empty" }, latencyMs: 1 },
  redactions: [],
};

describe("parseExchange", () => {
  it("reads the current version", () => {
    expect(CAPTURE_SCHEMA_VERSION).toBe(1);
    expect(parseExchange(v1)).toEqual(v1);
  });

  it("rejects versions newer than this build instead of guessing", () => {
    expect(() => parseExchange({ ...v1, schemaVersion: 2 })).toThrow(UnsupportedSchemaVersionError);
  });

  it("rejects data without a schemaVersion", () => {
    const { schemaVersion: _, ...unversioned } = v1;
    expect(() => parseExchange(unversioned)).toThrow(
      /unsupported exchange schemaVersion undefined/,
    );
  });

  it("still validates the shape of a known version", () => {
    expect(() => parseExchange({ ...v1, sequence: -1 })).toThrow();
  });
});
