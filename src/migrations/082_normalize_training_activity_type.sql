-- Active: 1776863449169@@127.0.0.1@5432@cwa24_prod_restore_20260805_144216
BEGIN;

ALTER TABLE training_activities
  ADD COLUMN IF NOT EXISTS workout_type TEXT;

ALTER TABLE training_activities
  DROP CONSTRAINT IF EXISTS training_activities_type_check,
  DROP CONSTRAINT IF EXISTS training_activities_workout_type_check,
  DROP CONSTRAINT IF EXISTS training_activities_workout_type_activity_check;

UPDATE training_activities
SET
  activity_type = 'cycling',
  workout_type = COALESCE(workout_type, 'indoor')
WHERE activity_type = 'indoor_cycling';

ALTER TABLE training_activities
  ADD CONSTRAINT training_activities_type_check
    CHECK (activity_type IN ('cycling', 'strength_training', 'mobility', 'other')),
  ADD CONSTRAINT training_activities_workout_type_check
    CHECK (workout_type IS NULL OR workout_type IN ('indoor', 'road', 'mountain', 'unknown')),
  ADD CONSTRAINT training_activities_workout_type_activity_check
    CHECK (
      (activity_type = 'cycling' AND workout_type IS NOT NULL)
      OR (activity_type <> 'cycling' AND workout_type IS NULL)
    );

COMMIT;
