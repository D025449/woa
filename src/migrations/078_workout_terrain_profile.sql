-- Active: 1776863449169@@127.0.0.1@5432@cwa24_prod_restore_20260805_144216
BEGIN;

ALTER TABLE workouts
  ADD COLUMN IF NOT EXISTS terrain_profile TEXT NOT NULL DEFAULT 'altitude_missing';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'workouts_terrain_profile_check'
      AND conrelid = 'workouts'::regclass
  ) THEN
    ALTER TABLE workouts
      ADD CONSTRAINT workouts_terrain_profile_check
      CHECK (terrain_profile IN ('flat', 'rolling', 'mountainous', 'altitude_missing', 'altitude_invalid'));
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_workouts_uid_terrain_profile_start_time
  ON workouts (uid, terrain_profile, start_time DESC);

COMMIT;
