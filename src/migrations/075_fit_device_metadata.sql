-- Active: 1776863449169@@127.0.0.1@5432@cwa24_prod@public
BEGIN;

ALTER TABLE workouts
  ADD COLUMN IF NOT EXISTS fit_device_metadata JSONB NOT NULL
  DEFAULT '{"version":1,"fileId":null,"devices":[]}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'workouts_fit_device_metadata_check'
      AND conrelid = 'workouts'::regclass
  ) THEN
    ALTER TABLE workouts
      ADD CONSTRAINT workouts_fit_device_metadata_check
      CHECK (
        jsonb_typeof(fit_device_metadata) = 'object'
        AND (
          NOT (fit_device_metadata ? 'fileId')
          OR fit_device_metadata->'fileId' = 'null'::jsonb
          OR jsonb_typeof(fit_device_metadata->'fileId') = 'object'
        )
        AND (
          NOT (fit_device_metadata ? 'devices')
          OR jsonb_typeof(fit_device_metadata->'devices') = 'array'
        )
      );
  END IF;
END $$;

COMMIT;
