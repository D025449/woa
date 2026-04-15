BEGIN;

ALTER TABLE gps_segments
  ADD COLUMN IF NOT EXISTS best_efforts_status TEXT NOT NULL DEFAULT 'completed',
  ADD COLUMN IF NOT EXISTS best_efforts_error TEXT;

UPDATE gps_segments
SET
  best_efforts_status = COALESCE(best_efforts_status, 'completed'),
  best_efforts_error = NULL
WHERE best_efforts_status IS NULL;

COMMIT;
