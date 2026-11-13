import { describe, expect, it } from "vitest";
import {
  RecordingError,
  decideRecording,
  evolveRecording,
  initialRecordingState,
  parseRecordingEvent,
  type RecordingCommand,
  type RecordingEvent,
  type RecordingState,
} from "./recording.js";

/**
 * Because decide/evolve are pure, every business rule can be tested as
 *   GIVEN these past events, WHEN this command, THEN these new events (or this error).
 * No database, no mocks, no clock.
 */

const T0 = "2026-11-12T10:00:00.000Z";
const T1 = "2026-11-12T10:05:00.000Z";

const started: RecordingEvent = {
  type: "RecordingStarted",
  payload: {
    recordingId: "rec_1",
    service: { name: "demo-api", version: "0.1.0", hostname: "box" },
    location: "/data/rec_1/events.jsonl",
    startedAt: T0,
    settings: {
      sampleRate: 1,
      maxBodyBytes: 1024,
      redactHeaders: ["cookie"],
      redactBodyFields: [],
    },
  },
};
const labeled = (label: string): RecordingEvent => ({
  type: "RecordingLabelAdded",
  payload: { label, at: T1 },
});
const sealed: RecordingEvent = {
  type: "RecordingSealed",
  payload: { sealedAt: T1, reason: "shutdown", exchangeCount: 10, droppedCount: 0 },
};

const stateFrom = (events: RecordingEvent[]): RecordingState =>
  events.reduce(evolveRecording, initialRecordingState);

const given = (events: RecordingEvent[]) => ({
  when: (command: RecordingCommand) => decideRecording(command, stateFrom(events)),
});

const seal: RecordingCommand = {
  type: "SealRecording",
  at: T1,
  reason: "manual",
  exchangeCount: null,
  droppedCount: null,
};

describe("evolve: state is a fold over the events", () => {
  it("starts empty", () => {
    expect(stateFrom([])).toEqual({ status: "none" });
  });

  it("tracks status and labels through the lifecycle", () => {
    expect(stateFrom([started, labeled("baseline"), labeled("v1"), sealed])).toEqual({
      status: "sealed",
      recordingId: "rec_1",
      labels: ["baseline", "v1"],
    });
  });

  it("applies a removal after an add", () => {
    const removed: RecordingEvent = {
      type: "RecordingLabelRemoved",
      payload: { label: "baseline", at: T1 },
    };
    expect(stateFrom([started, labeled("baseline"), removed])).toMatchObject({ labels: [] });
  });
});

describe("decide: the business rules", () => {
  it("starts a recording that doesn't exist yet", () => {
    expect(given([]).when({ type: "StartRecording", payload: started.payload })).toEqual([started]);
  });

  it("refuses to start the same recording twice", () => {
    expect(() =>
      given([started]).when({ type: "StartRecording", payload: started.payload }),
    ).toThrow(RecordingError);
  });

  it("refuses commands on a recording that doesn't exist", () => {
    try {
      given([]).when(seal);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RecordingError);
      expect((error as RecordingError).code).toBe("not_found");
    }
  });

  it("adds a trimmed label", () => {
    expect(given([started]).when({ type: "AddLabel", label: "  baseline ", at: T1 })).toEqual([
      labeled("baseline"),
    ]);
  });

  it("rejects empty and overly long labels", () => {
    for (const label of ["   ", "x".repeat(51)]) {
      expect(() => given([started]).when({ type: "AddLabel", label, at: T1 })).toThrow(
        /labels must be/,
      );
    }
  });

  it("allows labels on a sealed recording (labels are metadata, not data)", () => {
    expect(given([started, sealed]).when({ type: "AddLabel", label: "keep", at: T1 })).toHaveLength(
      1,
    );
  });

  describe("idempotency: repeating a command changes nothing", () => {
    it("adding an existing label produces no events", () => {
      expect(given([started, labeled("a")]).when({ type: "AddLabel", label: "a", at: T1 })).toEqual(
        [],
      );
    });

    it("removing a missing label produces no events", () => {
      expect(given([started]).when({ type: "RemoveLabel", label: "a", at: T1 })).toEqual([]);
    });

    it("sealing twice produces no events", () => {
      expect(given([started, sealed]).when(seal)).toEqual([]);
    });
  });
});

describe("parseRecordingEvent", () => {
  it("validates the payload of a stored event", () => {
    expect(
      parseRecordingEvent({ type: "RecordingSealed", schemaVersion: 1, payload: sealed.payload }),
    ).toEqual(sealed);
    expect(() =>
      parseRecordingEvent({
        type: "RecordingSealed",
        schemaVersion: 1,
        payload: { reason: "nope" },
      }),
    ).toThrow();
  });

  it("refuses a schema version it has no upcaster for", () => {
    expect(() =>
      parseRecordingEvent({ type: "RecordingSealed", schemaVersion: 2, payload: sealed.payload }),
    ).toThrow(/no upcaster for RecordingSealed v2/);
  });

  it("refuses unknown event types", () => {
    expect(() =>
      parseRecordingEvent({ type: "RecordingDeleted", schemaVersion: 1, payload: {} }),
    ).toThrow(/unknown recording event type/);
  });
});
