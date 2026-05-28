-- Active: 1776863449169@@127.0.0.1@5432@cwa24_prod
BEGIN;

ALTER TABLE workouts
ADD COLUMN IF NOT EXISTS gps_source TEXT;

ALTER TABLE workouts
ADD COLUMN IF NOT EXISTS manual_gps_lookup_points JSONB;

UPDATE workouts
SET gps_source = CASE
  WHEN validgps = true THEN 'recorded'
  ELSE NULL
END
WHERE gps_source IS NULL;

ALTER TABLE workouts
DROP CONSTRAINT IF EXISTS workouts_gps_source_check;

ALTER TABLE workouts
ADD CONSTRAINT workouts_gps_source_check
CHECK (
  gps_source IS NULL
  OR gps_source IN ('recorded', 'manual_lookup')
);

COMMIT;
