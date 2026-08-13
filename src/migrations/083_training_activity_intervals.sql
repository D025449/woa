-- Active: 1776863449169@@127.0.0.1@5432@cwa24_prod_restore_20260805_144216
BEGIN;

ALTER TABLE training_activities
  ADD COLUMN IF NOT EXISTS avg_normalized_power DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS tss_source TEXT,
  ADD COLUMN IF NOT EXISTS ftp_used DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS baseline_power_mode TEXT,
  ADD COLUMN IF NOT EXISTS baseline_power_value DOUBLE PRECISION;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'training_activities_normalized_power_check'
      AND conrelid = 'training_activities'::regclass
  ) THEN
    ALTER TABLE training_activities
      ADD CONSTRAINT training_activities_normalized_power_check
      CHECK (avg_normalized_power IS NULL OR avg_normalized_power >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'training_activities_tss_source_check'
      AND conrelid = 'training_activities'::regclass
  ) THEN
    ALTER TABLE training_activities
      ADD CONSTRAINT training_activities_tss_source_check
      CHECK (tss_source IS NULL OR tss_source IN ('manual', 'power_model'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'training_activities_ftp_used_check'
      AND conrelid = 'training_activities'::regclass
  ) THEN
    ALTER TABLE training_activities
      ADD CONSTRAINT training_activities_ftp_used_check
      CHECK (ftp_used IS NULL OR ftp_used > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'training_activities_baseline_power_check'
      AND conrelid = 'training_activities'::regclass
  ) THEN
    ALTER TABLE training_activities
      ADD CONSTRAINT training_activities_baseline_power_check
      CHECK (
        (baseline_power_mode IS NULL AND baseline_power_value IS NULL)
        OR (
          activity_type = 'cycling'
          AND baseline_power_mode IN ('watts', 'ftp_percent')
          AND baseline_power_value > 0
        )
      );
  END IF;
END
$$;

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

COMMIT;
