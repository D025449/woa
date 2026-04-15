BEGIN;

ALTER TABLE workout_segments
  DROP COLUMN IF EXISTS bounds;

COMMIT;
