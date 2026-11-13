import { ConcurrencyError, type EventStore, type StoredEvent } from "./event-store.js";

/**
 * Everything the command loop needs to know about one kind of aggregate.
 * @replayforge/core's RecordingAggregate matches this shape.
 */
export interface Aggregate<State, Command, Event extends DomainEvent> {
  initialState: State;
  evolve(state: State, event: Event): State;
  decide(command: Command, state: State): Event[];
  /** Turns a stored event back into a typed, validated domain event. */
  parse(stored: { type: string; schemaVersion: number; payload: unknown }): Event;
  /** Payload schema version to store for each event type. */
  versions: Record<Event["type"], number>;
}

export interface CommandResult<State> {
  /** Events this command appended. [] when the command had nothing to change. */
  appended: StoredEvent[];
  state: State;
  /** Stream version after the command. */
  version: number;
}

/** Every domain event is a type name plus a payload. */
export interface DomainEvent {
  type: string;
  payload: unknown;
}

type EventStoreLike = Pick<EventStore, "readStream" | "append">;

/**
 * The event-sourcing loop: load, decide, append, and retry on conflict.
 *
 *   history  = readStream(streamId)
 *   state    = history.reduce(evolve, initialState)
 *   newEvts  = decide(command, state)          // may throw a business error
 *   append(streamId, expectedVersion = version of the last event we read, newEvts)
 *
 * If another writer appended in between, append throws ConcurrencyError. We
 * then start over with fresh state. The retry is safe because `decide` is
 * pure: re-running it on the new state gives the right answer, which may now
 * be [] (e.g. "already sealed").
 */
export async function handleCommand<State, Command, Event extends DomainEvent>(
  store: EventStoreLike,
  aggregate: Aggregate<State, Command, Event>,
  streamId: string,
  command: Command,
  options: { maxAttempts?: number; metadata?: Record<string, unknown> } = {},
): Promise<CommandResult<State>> {
  const maxAttempts = options.maxAttempts ?? 3;

  for (let attempt = 1; ; attempt++) {
    const history = await store.readStream(streamId);
    const state = history
      .map((e) => aggregate.parse(e))
      .reduce(aggregate.evolve, aggregate.initialState);
    const version = history.at(-1)?.streamVersion ?? 0;

    const events = aggregate.decide(command, state);
    if (events.length === 0) return { appended: [], state, version };

    try {
      const appended = await store.append(
        streamId,
        version,
        events.map((event) => ({
          type: event.type,
          schemaVersion: aggregate.versions[event.type as Event["type"]],
          payload: event.payload,
          ...(options.metadata ? { metadata: options.metadata } : {}),
        })),
      );
      return {
        appended,
        state: events.reduce(aggregate.evolve, state),
        version: version + appended.length,
      };
    } catch (error) {
      if (error instanceof ConcurrencyError && attempt < maxAttempts) continue;
      throw error;
    }
  }
}
