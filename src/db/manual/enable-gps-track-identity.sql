-- Active: 1776863449169@@127.0.0.1@5432@cwa24_prod
BEGIN;

ALTER TABLE workouts
  DROP CONSTRAINT IF EXISTS workouts_gps_track_blob_codec_check;

ALTER TABLE workouts
  ADD CONSTRAINT workouts_gps_track_blob_codec_check
  CHECK (gps_track_blob_codec IS NULL OR gps_track_blob_codec IN ('identity', 'brotli', 'gzip'));

ALTER TABLE gps_segments
  DROP CONSTRAINT IF EXISTS gps_segments_track_blob_codec_check;

ALTER TABLE gps_segments
  ADD CONSTRAINT gps_segments_track_blob_codec_check
  CHECK (track_blob_codec IN ('identity', 'brotli', 'gzip'));

COMMIT;

SELECT
  conrelid::regclass AS table_name,
  conname AS constraint_name,
  pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conname IN (
  'workouts_gps_track_blob_codec_check',
  'gps_segments_track_blob_codec_check'
)
ORDER BY conrelid::regclass::text, conname;
