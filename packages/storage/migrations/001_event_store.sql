-- The event store: one append-only table for every event of every stream.
--
--   stream_id       which aggregate the event belongs to, e.g. 'recording-rec_2026...'
--   stream_version  1, 2, 3... within that stream. (stream_id, stream_version) is unique, so two
--                   writers can never both write "event #3" of the same stream.
--   global_position order across ALL streams. Projections read the log in this order.
--   schema_version  version of the payload's shape, for upcasting old events.

CREATE TABLE events (
  global_position BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id        UUID        NOT NULL UNIQUE,
  stream_id       TEXT        NOT NULL,
  stream_version  INTEGER     NOT NULL CHECK (stream_version > 0),
  type            TEXT        NOT NULL,
  schema_version  INTEGER     NOT NULL,
  payload         JSONB       NOT NULL,
  metadata        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT events_stream_version_unique UNIQUE (stream_id, stream_version)
);

-- Events are facts: once written they never change. The database enforces
-- that, so a bug (or a tired human with psql) can't rewrite history.
CREATE FUNCTION events_are_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'events are append-only: % is not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER events_append_only
  BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION events_are_append_only();
