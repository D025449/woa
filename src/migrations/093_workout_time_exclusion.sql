-- Active: 1793688551865@@127.0.0.1@5432@cwa24_prod_restore_20260805_144216@public
BEGIN;

CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE workouts
  ADD CONSTRAINT workouts_no_time_overlap
  EXCLUDE USING gist (
    uid WITH =,
    tstzrange(start_time, end_time, '[)') WITH &&
  )
  WHERE (
    start_time IS NOT NULL
    AND end_time IS NOT NULL
    AND end_time > start_time
  );

COMMIT;