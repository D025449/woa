-- Active: 1793688551865@@127.0.0.1@5432@cwa24_prod_restore_20260805_144216@public
BEGIN;

ALTER TABLE workouts
  ADD COLUMN IF NOT EXISTS original_fit_s3_key TEXT;

COMMIT;
