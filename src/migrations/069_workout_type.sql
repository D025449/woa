-- Active: 1776863449169@@127.0.0.1@5432@cwa24_prod
BEGIN;

ALTER TABLE workouts
  ADD COLUMN IF NOT EXISTS workout_type TEXT NOT NULL DEFAULT 'unknown';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'workouts_workout_type_check'
      AND conrelid = 'workouts'::regclass
  ) THEN
    ALTER TABLE workouts
      ADD CONSTRAINT workouts_workout_type_check
      CHECK (workout_type IN ('indoor', 'road', 'mountain', 'unknown'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_workouts_uid_type_start_time
  ON workouts (uid, workout_type, start_time DESC);

COMMIT;
