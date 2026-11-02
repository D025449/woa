-- Active: 1793603949676@@127.0.0.1@5432@cwa24_dev@public
-- Prepare only; run manually after review, after migrations 090 and 091.
BEGIN;

ALTER TABLE user_wahoo_connections
  ADD COLUMN auto_import_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN offline_data_granted BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN user_wahoo_connections.auto_import_enabled IS
  'Explicit user preference for automatic import of new Wahoo workouts.';
COMMENT ON COLUMN user_wahoo_connections.offline_data_granted IS
  'Connection authorized for offline_data; existing connections require renewed authorization.';

-- Store identifiers and processing state only, never webhook tokens,
-- OAuth credentials, complete webhook payloads or signed download URLs.
CREATE TABLE wahoo_webhook_imports (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES user_wahoo_connections(user_id) ON DELETE CASCADE,
  wahoo_user_id BIGINT NOT NULL CHECK (wahoo_user_id > 0),
  workout_summary_id BIGINT NOT NULL CHECK (workout_summary_id > 0),
  workout_id BIGINT NOT NULL CHECK (workout_id > 0),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'skipped', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at TIMESTAMPTZ,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT wahoo_webhook_imports_summary_key
    UNIQUE (user_id, wahoo_user_id, workout_summary_id)
);

CREATE INDEX wahoo_webhook_imports_pending_idx
  ON wahoo_webhook_imports (available_at, id) WHERE status = 'pending';
CREATE INDEX wahoo_webhook_imports_processing_idx
  ON wahoo_webhook_imports (locked_at, id) WHERE status = 'processing';

COMMENT ON TABLE wahoo_webhook_imports IS
  'Durable Wahoo webhook inbox with deduplication; removed when the connection is deleted.';

COMMIT;
