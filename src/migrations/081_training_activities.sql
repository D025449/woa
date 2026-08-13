-- Active: 1776863449169@@127.0.0.1@5432@cwa24_prod_restore_20260805_144216
BEGIN;

ALTER TABLE workouts
  ADD COLUMN IF NOT EXISTS perceived_exertion SMALLINT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'workouts_perceived_exertion_check'
      AND conrelid = 'workouts'::regclass
  ) THEN
    ALTER TABLE workouts
      ADD CONSTRAINT workouts_perceived_exertion_check
      CHECK (perceived_exertion IS NULL OR perceived_exertion BETWEEN 1 AND 10);
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS training_activities (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  uid BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_time TIMESTAMPTZ NOT NULL,
  duration_seconds DOUBLE PRECISION NOT NULL,
  activity_type TEXT NOT NULL,
  workout_type TEXT,
  title VARCHAR(160),
  notes TEXT,
  perceived_exertion SMALLINT,
  average_power DOUBLE PRECISION,
  avg_normalized_power DOUBLE PRECISION,
  estimated_tss DOUBLE PRECISION,
  tss_source TEXT,
  ftp_used DOUBLE PRECISION,
  baseline_power_mode TEXT,
  baseline_power_value DOUBLE PRECISION,
  strength_focus TEXT,
  intensity_profile TEXT NOT NULL DEFAULT 'unknown',
  intensity_tags SMALLINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT training_activities_duration_check
    CHECK (duration_seconds > 0),
  CONSTRAINT training_activities_type_check
    CHECK (activity_type IN ('cycling', 'strength_training', 'mobility', 'other')),
  CONSTRAINT training_activities_workout_type_check
    CHECK (workout_type IS NULL OR workout_type IN ('indoor', 'road', 'mountain', 'unknown')),
  CONSTRAINT training_activities_workout_type_activity_check
    CHECK (
      (activity_type = 'cycling' AND workout_type IS NOT NULL)
      OR (activity_type <> 'cycling' AND workout_type IS NULL)
    ),
  CONSTRAINT training_activities_perceived_exertion_check
    CHECK (perceived_exertion IS NULL OR perceived_exertion BETWEEN 1 AND 10),
  CONSTRAINT training_activities_average_power_check
    CHECK (average_power IS NULL OR average_power >= 0),
  CONSTRAINT training_activities_normalized_power_check
    CHECK (avg_normalized_power IS NULL OR avg_normalized_power >= 0),
  CONSTRAINT training_activities_estimated_tss_check
    CHECK (estimated_tss IS NULL OR estimated_tss >= 0),
  CONSTRAINT training_activities_tss_source_check
    CHECK (tss_source IS NULL OR tss_source IN ('manual', 'power_model')),
  CONSTRAINT training_activities_ftp_used_check
    CHECK (ftp_used IS NULL OR ftp_used > 0),
  CONSTRAINT training_activities_baseline_power_check
    CHECK (
      (baseline_power_mode IS NULL AND baseline_power_value IS NULL)
      OR (
        activity_type = 'cycling'
        AND baseline_power_mode IN ('watts', 'ftp_percent')
        AND baseline_power_value > 0
      )
    ),
  CONSTRAINT training_activities_strength_focus_check
    CHECK (strength_focus IS NULL OR strength_focus IN ('upper_body', 'lower_body', 'full_body')),
  CONSTRAINT training_activities_strength_focus_type_check
    CHECK (strength_focus IS NULL OR activity_type = 'strength_training'),
  CONSTRAINT training_activities_intensity_profile_check
    CHECK (intensity_profile IN ('unknown', 'recovery', 'endurance', 'tempo', 'threshold', 'vo2max', 'anaerobic')),
  CONSTRAINT training_activities_intensity_tags_check
    CHECK (intensity_tags BETWEEN 0 AND 63)
);

CREATE INDEX IF NOT EXISTS idx_training_activities_uid_start_time
  ON training_activities (uid, start_time DESC, id DESC);

CREATE TABLE IF NOT EXISTS training_activity_intervals (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  training_activity_id BIGINT NOT NULL REFERENCES training_activities(id) ON DELETE CASCADE,
  sequence_no SMALLINT NOT NULL,
  repetitions SMALLINT NOT NULL,
  work_duration_seconds INTEGER NOT NULL,
  recovery_duration_seconds INTEGER NOT NULL DEFAULT 0,
  power_mode TEXT NOT NULL,
  work_power_value DOUBLE PRECISION NOT NULL,
  recovery_power_value DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT training_activity_intervals_sequence_unique
    UNIQUE (training_activity_id, sequence_no),
  CONSTRAINT training_activity_intervals_sequence_check
    CHECK (sequence_no >= 0),
  CONSTRAINT training_activity_intervals_repetitions_check
    CHECK (repetitions BETWEEN 1 AND 100),
  CONSTRAINT training_activity_intervals_work_duration_check
    CHECK (work_duration_seconds BETWEEN 1 AND 3600),
  CONSTRAINT training_activity_intervals_recovery_duration_check
    CHECK (recovery_duration_seconds BETWEEN 0 AND 3600),
  CONSTRAINT training_activity_intervals_power_mode_check
    CHECK (power_mode IN ('watts', 'ftp_percent')),
  CONSTRAINT training_activity_intervals_work_power_check
    CHECK (work_power_value > 0),
  CONSTRAINT training_activity_intervals_recovery_power_check
    CHECK (recovery_power_value IS NULL OR recovery_power_value >= 0)
);

CREATE INDEX IF NOT EXISTS idx_training_activity_intervals_activity
  ON training_activity_intervals (training_activity_id, sequence_no);

CREATE OR REPLACE TRIGGER trigger_training_activities_set_updated_at
BEFORE UPDATE ON training_activities
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

COMMIT;
