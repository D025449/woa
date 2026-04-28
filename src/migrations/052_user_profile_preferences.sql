BEGIN;

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS language VARCHAR(10),
  ADD COLUMN IF NOT EXISTS distance_unit VARCHAR(10),
  ADD COLUMN IF NOT EXISTS speed_unit VARCHAR(10),
  ADD COLUMN IF NOT EXISTS default_workout_scope VARCHAR(10);

UPDATE user_profiles
SET
  language = COALESCE(NULLIF(language, ''), 'en'),
  distance_unit = COALESCE(NULLIF(distance_unit, ''), 'km'),
  speed_unit = COALESCE(NULLIF(speed_unit, ''), 'kmh'),
  default_workout_scope = COALESCE(NULLIF(default_workout_scope, ''), 'mine')
WHERE
  language IS NULL
  OR distance_unit IS NULL
  OR speed_unit IS NULL
  OR default_workout_scope IS NULL;

ALTER TABLE user_profiles
  ALTER COLUMN language SET DEFAULT 'en',
  ALTER COLUMN distance_unit SET DEFAULT 'km',
  ALTER COLUMN speed_unit SET DEFAULT 'kmh',
  ALTER COLUMN default_workout_scope SET DEFAULT 'mine';

COMMIT;
