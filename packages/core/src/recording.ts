import { z } from "zod";

/**
 * The Recording aggregate, event-sourced.
 *
 * A "recording" is one capture session: an API process that wrote exchanges to
 * one JSONL file. We don't store its CURRENT STATE anywhere. We store the
 * FACTS that happened to it, in order:
 *
 *   RecordingStarted -> RecordingLabelAdded -> RecordingLabelRemoved -> RecordingSealed
 *
 * and the current state is computed by folding over those facts (`evolve`).
 *
 * Changing a recording follows one fixed loop (implemented in
 * @replayforge/storage's handleCommand):
 *
 *   1. load the stream's events   ──▶ fold with `evolve` ──▶ current state
 *   2. `decide(command, state)`   ──▶ new events (or an error, or [] = nothing to do)
 *   3. append the new events, but only if nobody else appended in the meantime
 *
 * `decide` and `evolve` are PURE FUNCTIONS: no database, no clock, no
 * randomness. The caller passes in timestamps. This makes the business rules
 * trivially testable (see recording.test.ts) and lets the same rules run
 * anywhere.
 */

// ---------------------------------------------------------------------------
// Events: facts, named in the past tense. Once written they never change.
// ---------------------------------------------------------------------------

export const CaptureSettings = z.object({
  sampleRate: z.number().min(0).max(1),
  maxBodyBytes: z.int().nonnegative(),
  redactHeaders: z.array(z.string()),
  redactBodyFields: z.array(z.string()),
});
export type CaptureSettings = z.infer<typeof CaptureSettings>;

export const RecordingStarted = z.object({
  type: z.literal("RecordingStarted"),
  payload: z.object({
    recordingId: z.string().min(1),
    service: z.object({ name: z.string(), version: z.string(), hostname: z.string() }),
    /** Where the exchanges are written, e.g. "recordings/rec_.../events.jsonl". */
    location: z.string(),
    startedAt: z.iso.datetime(),
    /** The capture settings in force. Needed later to interpret the data (e.g. was it sampled?). */
    settings: CaptureSettings,
  }),
});

export type RecordingStartedPayload = z.infer<typeof RecordingStarted>["payload"];

export const RecordingLabelAdded = z.object({
  type: z.literal("RecordingLabelAdded"),
  payload: z.object({ label: z.string(), at: z.iso.datetime() }),
});

/**
 * Events are never deleted, so "undo" is a new event that compensates for an
 * old one. The label's history stays visible: who added it and when it was removed.
 */
export const RecordingLabelRemoved = z.object({
  type: z.literal("RecordingLabelRemoved"),
  payload: z.object({ label: z.string(), at: z.iso.datetime() }),
});

export const RecordingSealed = z.object({
  type: z.literal("RecordingSealed"),
  payload: z.object({
    sealedAt: z.iso.datetime(),
    /** "shutdown": the API closed cleanly. "manual": someone sealed it from the CLI (e.g. after a crash). */
    reason: z.enum(["shutdown", "manual"]),
    /** Null when unknown, e.g. a manual seal after a crash. */
    exchangeCount: z.int().nonnegative().nullable(),
    droppedCount: z.int().nonnegative().nullable(),
  }),
});

export const RecordingEvent = z.discriminatedUnion("type", [
  RecordingStarted,
  RecordingLabelAdded,
  RecordingLabelRemoved,
  RecordingSealed,
]);
export type RecordingEvent = z.infer<typeof RecordingEvent>;
export type RecordingEventType = RecordingEvent["type"];

/**
 * The payload schema version of each event type. Stored next to every event,
 * so a future v2 payload can be told apart from v1 (see docs/event-schema.md).
 */
export const RECORDING_EVENT_VERSIONS: Record<RecordingEventType, number> = {
  RecordingStarted: 1,
  RecordingLabelAdded: 1,
  RecordingLabelRemoved: 1,
  RecordingSealed: 1,
};

/** Validates a stored event (type + version + payload) and returns it in the current shape. */
export function parseRecordingEvent(stored: {
  type: string;
  schemaVersion: number;
  payload: unknown;
}): RecordingEvent {
  const expected = RECORDING_EVENT_VERSIONS[stored.type as RecordingEventType];
  if (expected === undefined) throw new Error(`unknown recording event type "${stored.type}"`);
  if (stored.schemaVersion !== expected) {
    // An upcaster for (type, oldVersion) would go here.
    throw new Error(
      `no upcaster for ${stored.type} v${stored.schemaVersion} (current is v${expected})`,
    );
  }
  return RecordingEvent.parse({ type: stored.type, payload: stored.payload });
}

/** One stream per recording. Stream ids are namespaced so other aggregates can share the store. */
export function recordingStreamId(recordingId: string): string {
  return `recording-${recordingId}`;
}

// ---------------------------------------------------------------------------
// State: whatever `decide` needs to enforce the rules. Nothing more.
// ---------------------------------------------------------------------------

export type RecordingState =
  | { status: "none" }
  | { status: "recording" | "sealed"; recordingId: string; labels: readonly string[] };

export const initialRecordingState: RecordingState = { status: "none" };

/** Applies ONE event to the state. Folding all events from the start gives the current state. */
export function evolveRecording(state: RecordingState, event: RecordingEvent): RecordingState {
  switch (event.type) {
    case "RecordingStarted":
      return { status: "recording", recordingId: event.payload.recordingId, labels: [] };
    case "RecordingLabelAdded":
      if (state.status === "none") return state;
      return { ...state, labels: [...state.labels, event.payload.label] };
    case "RecordingLabelRemoved":
      if (state.status === "none") return state;
      return { ...state, labels: state.labels.filter((l) => l !== event.payload.label) };
    case "RecordingSealed":
      if (state.status === "none") return state;
      return { ...state, status: "sealed" };
  }
}

// ---------------------------------------------------------------------------
// Commands: requests to change something. They can be rejected; events can't.
// ---------------------------------------------------------------------------

export type RecordingCommand =
  | { type: "StartRecording"; payload: RecordingStartedPayload }
  | { type: "AddLabel"; label: string; at: string }
  | { type: "RemoveLabel"; label: string; at: string }
  | {
      type: "SealRecording";
      at: string;
      reason: "shutdown" | "manual";
      exchangeCount: number | null;
      droppedCount: number | null;
    };

export type RecordingErrorCode = "already_started" | "not_found" | "invalid_label";

export class RecordingError extends Error {
  constructor(
    readonly code: RecordingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RecordingError";
  }
}

const MAX_LABEL_LENGTH = 50;

/**
 * The business rules. Returns the events that the command produces.
 *
 * Returning [] means "already done, nothing to change". That makes commands
 * IDEMPOTENT: adding the same label twice or sealing twice is harmless. That
 * matters because commands get retried (after a timeout, or a concurrency conflict).
 */
export function decideRecording(
  command: RecordingCommand,
  state: RecordingState,
): RecordingEvent[] {
  if (command.type === "StartRecording") {
    if (state.status !== "none") {
      throw new RecordingError(
        "already_started",
        `recording ${command.payload.recordingId} already exists`,
      );
    }
    return [{ type: "RecordingStarted", payload: command.payload }];
  }

  if (state.status === "none") {
    throw new RecordingError("not_found", "recording does not exist");
  }

  switch (command.type) {
    case "AddLabel": {
      const label = command.label.trim();
      if (label.length === 0 || label.length > MAX_LABEL_LENGTH) {
        throw new RecordingError(
          "invalid_label",
          `labels must be 1-${MAX_LABEL_LENGTH} characters`,
        );
      }
      if (state.labels.includes(label)) return [];
      return [{ type: "RecordingLabelAdded", payload: { label, at: command.at } }];
    }
    case "RemoveLabel": {
      const label = command.label.trim();
      if (!state.labels.includes(label)) return [];
      return [{ type: "RecordingLabelRemoved", payload: { label, at: command.at } }];
    }
    case "SealRecording": {
      if (state.status === "sealed") return [];
      return [
        {
          type: "RecordingSealed",
          payload: {
            sealedAt: command.at,
            reason: command.reason,
            exchangeCount: command.exchangeCount,
            droppedCount: command.droppedCount,
          },
        },
      ];
    }
  }
}

/** Everything handleCommand needs to know about this aggregate, in one object. */
export const RecordingAggregate = {
  initialState: initialRecordingState,
  evolve: evolveRecording,
  decide: decideRecording,
  parse: parseRecordingEvent,
  versions: RECORDING_EVENT_VERSIONS,
} as const;
