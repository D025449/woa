-- Active: 1776863449169@@127.0.0.1@5432@cwa24_prod
BEGIN;

CREATE TABLE IF NOT EXISTS woa_bundle_uploads (
  uid BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  upload_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'processing', 'retry_queued', 'completed', 'failed')),
  phase TEXT NOT NULL DEFAULT 'received'
    CHECK (phase IN ('received', 'workouts_completed', 'wpp_completed', 'gbe_completed', 'completed')),
  workouts_path TEXT NOT NULL,
  workout_postprocess_path TEXT NOT NULL,
  gps_best_efforts_path TEXT NOT NULL,
  workouts_original_name TEXT NOT NULL,
  workouts_codec TEXT NOT NULL CHECK (workouts_codec IN ('gzip', 'brotli')),
  overwrite_existing BOOLEAN NOT NULL DEFAULT FALSE,
  workouts_bytes BIGINT NOT NULL DEFAULT 0,
  workout_postprocess_bytes BIGINT NOT NULL DEFAULT 0,
  gps_best_efforts_bytes BIGINT NOT NULL DEFAULT 0,
  import_result JSONB,
  workout_postprocess_result JSONB,
  gps_best_efforts_result JSONB,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (uid, upload_id)
);

CREATE INDEX IF NOT EXISTS idx_woa_bundle_uploads_recovery
ON woa_bundle_uploads (status, updated_at)
WHERE status <> 'completed';

COMMIT;
