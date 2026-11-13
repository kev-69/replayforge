-- Read models ("projections") are DERIVED from the events table. They can be
-- dropped and rebuilt from the events at any time, so they hold no data of their own.

-- How far each projection has read in the global event log.
CREATE TABLE projection_checkpoints (
  name     TEXT   PRIMARY KEY,
  position BIGINT NOT NULL
);

-- One row per recording, shaped for the queries the CLI runs ("list recordings").
CREATE TABLE recordings (
  recording_id    TEXT        PRIMARY KEY,
  status          TEXT        NOT NULL CHECK (status IN ('recording', 'sealed')),
  service         TEXT        NOT NULL,
  service_version TEXT        NOT NULL,
  hostname        TEXT        NOT NULL,
  location        TEXT        NOT NULL,
  sample_rate     DOUBLE PRECISION NOT NULL,
  started_at      TIMESTAMPTZ NOT NULL,
  sealed_at       TIMESTAMPTZ,
  seal_reason     TEXT,
  exchange_count  INTEGER,
  dropped_count   INTEGER,
  labels          TEXT[]      NOT NULL DEFAULT '{}',
  -- the stream_version of the last event applied: handy for debugging the projection
  stream_version  INTEGER     NOT NULL
);

CREATE INDEX recordings_started_at_idx ON recordings (started_at DESC);
