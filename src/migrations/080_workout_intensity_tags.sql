-- Active: 1776863449169@@127.0.0.1@5432@cwa24_prod_restore_20260805_144216
BEGIN;

ALTER TABLE workouts
  ADD COLUMN IF NOT EXISTS intensity_tags SMALLINT NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workouts_intensity_tags_check'
      AND conrelid = 'workouts'::regclass
  ) THEN
    ALTER TABLE workouts ADD CONSTRAINT workouts_intensity_tags_check
      CHECK (intensity_tags BETWEEN 0 AND 63);
  END IF;
END
$$;

COMMIT;
