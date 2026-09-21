-- Active: 1776863449169@@127.0.0.1@5432@cwa24_prod_restore_20260805_144216@public
BEGIN;

ALTER TABLE gps_segments
  ADD COLUMN IF NOT EXISTS workout_altitude_manual BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN gps_segments.workout_altitude_manual IS
  'True when the workout-derived elevation profile was explicitly selected by the segment owner.';

COMMIT;
