-- Active: 1776863449169@@127.0.0.1@5432@cwa24_prod
ALTER TABLE workouts
  ADD COLUMN IF NOT EXISTS stream_codec TEXT,
  ADD COLUMN IF NOT EXISTS gps_track_blob_codec TEXT;

ALTER TABLE workouts
  ALTER COLUMN stream_codec SET DEFAULT 'brotli',
  ALTER COLUMN gps_track_blob_codec SET DEFAULT 'brotli';

UPDATE workouts
SET
  stream_codec = COALESCE(stream_codec, 'brotli'),
  gps_track_blob_codec = COALESCE(gps_track_blob_codec, 'brotli');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'workouts_stream_codec_check'
  ) THEN
    ALTER TABLE workouts
      ADD CONSTRAINT workouts_stream_codec_check
      CHECK (stream_codec IS NULL OR stream_codec IN ('brotli', 'gzip'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'workouts_gps_track_blob_codec_check'
  ) THEN
    ALTER TABLE workouts
      ADD CONSTRAINT workouts_gps_track_blob_codec_check
      CHECK (gps_track_blob_codec IS NULL OR gps_track_blob_codec IN ('brotli', 'gzip'));
  END IF;
END $$;
