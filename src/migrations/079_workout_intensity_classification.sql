-- Active: 1776863449169@@127.0.0.1@5432@cwa24_prod_restore_20260805_144216
BEGIN;

ALTER TABLE workouts
  ADD COLUMN IF NOT EXISTS intensity_profile TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS intensity_structure TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS intensity_dose TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS intensity_classifier_version SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS intensity_model_features BYTEA;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workouts_intensity_profile_check'
      AND conrelid = 'workouts'::regclass
  ) THEN
    ALTER TABLE workouts ADD CONSTRAINT workouts_intensity_profile_check
      CHECK (intensity_profile IN ('unknown', 'recovery', 'endurance', 'tempo', 'threshold', 'vo2max', 'anaerobic'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workouts_intensity_structure_check'
      AND conrelid = 'workouts'::regclass
  ) THEN
    ALTER TABLE workouts ADD CONSTRAINT workouts_intensity_structure_check
      CHECK (intensity_structure IN ('unknown', 'steady', 'variable', 'intervals'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workouts_intensity_dose_check'
      AND conrelid = 'workouts'::regclass
  ) THEN
    ALTER TABLE workouts ADD CONSTRAINT workouts_intensity_dose_check
      CHECK (intensity_dose IN ('unknown', 'low', 'moderate', 'high'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workouts_intensity_model_features_check'
      AND conrelid = 'workouts'::regclass
  ) THEN
    ALTER TABLE workouts ADD CONSTRAINT workouts_intensity_model_features_check
      CHECK (intensity_model_features IS NULL OR octet_length(intensity_model_features) = 18);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_workouts_uid_intensity_profile_start_time
  ON workouts (uid, intensity_profile, start_time DESC);

COMMIT;
