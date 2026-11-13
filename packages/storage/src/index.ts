export { createPgDatabase, isUniqueViolation, type Database, type SqlClient } from "./db.js";
export { migrate, MIGRATIONS_DIR } from "./migrate.js";
export { EventStore, ConcurrencyError, type NewEvent, type StoredEvent } from "./event-store.js";
export {
  handleCommand,
  type Aggregate,
  type CommandResult,
  type DomainEvent,
} from "./command-handler.js";
export { catchUp, rebuild, type Projection } from "./projector.js";
export {
  Recordings,
  recordingsProjection,
  type RecordingSummary,
  type StartRecordingInput,
} from "./recordings.js";
