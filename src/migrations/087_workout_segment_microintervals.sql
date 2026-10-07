-- Active: 1776863449169@@127.0.0.1@5432@cwa24_prod_restore_20260805_144216
-- Additive migration; execute this file directly against an existing app schema.
-- No workout analysis or backfill is performed. Existing segments remain simple.
BEGIN;

ALTER TABLE workout_segments
  ADD COLUMN IF NOT EXISTS structure_kind TEXT NOT NULL DEFAULT 'simple',
  ADD COLUMN IF NOT EXISTS pattern_work_duration_seconds INTEGER,
  ADD COLUMN IF NOT EXISTS pattern_recovery_duration_seconds INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workout_segments_structure_kind_check'
      AND conrelid = 'workout_segments'::regclass
  ) THEN
    ALTER TABLE workout_segments
      ADD CONSTRAINT workout_segments_structure_kind_check
      CHECK (structure_kind IN ('simple', 'microintervals'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workout_segments_microinterval_type_check'
      AND conrelid = 'workout_segments'::regclass
  ) THEN
    ALTER TABLE workout_segments
      ADD CONSTRAINT workout_segments_microinterval_type_check
      CHECK (
        structure_kind <> 'microintervals'
        OR (segmenttype IS NOT NULL AND segmenttype IN ('manual', 'auto'))
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workout_segments_microinterval_pattern_check'
      AND conrelid = 'workout_segments'::regclass
  ) THEN
    ALTER TABLE workout_segments
      ADD CONSTRAINT workout_segments_microinterval_pattern_check
      CHECK (
        (pattern_work_duration_seconds IS NULL AND pattern_recovery_duration_seconds IS NULL)
        OR (
          structure_kind = 'microintervals'
          AND pattern_work_duration_seconds IS NOT NULL
          AND pattern_recovery_duration_seconds IS NOT NULL
          AND pattern_work_duration_seconds > 0
          AND pattern_recovery_duration_seconds > 0
        )
      );
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS workout_segment_phases (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  segment_id BIGINT NOT NULL,
  position INTEGER NOT NULL,
  phase_kind TEXT NOT NULL,
  repetition_index INTEGER NOT NULL,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  duration INTEGER NOT NULL,
  avg_power DOUBLE PRECISION,
  avg_heart_rate DOUBLE PRECISION,
  avg_cadence DOUBLE PRECISION,
  avg_speed DOUBLE PRECISION,
  altimeters DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT workout_segment_phases_segment_fk
    FOREIGN KEY (segment_id) REFERENCES workout_segments(id) ON DELETE CASCADE,
  CONSTRAINT workout_segment_phases_position_unique
    UNIQUE (segment_id, position),
  CONSTRAINT workout_segment_phases_repetition_kind_unique
    UNIQUE (segment_id, repetition_index, phase_kind),
  CONSTRAINT workout_segment_phases_position_check
    CHECK (position >= 0),
  CONSTRAINT workout_segment_phases_kind_check
    CHECK (phase_kind IN ('work', 'recovery')),
  CONSTRAINT workout_segment_phases_repetition_check
    CHECK (repetition_index >= 1),
  CONSTRAINT workout_segment_phases_offsets_check
    CHECK (start_offset >= 0 AND end_offset >= start_offset),
  CONSTRAINT workout_segment_phases_duration_check
    CHECK (duration > 0 AND duration::BIGINT = end_offset::BIGINT - start_offset::BIGINT + 1),
  CONSTRAINT workout_segment_phases_metrics_check
    CHECK (
      (avg_power IS NULL OR (avg_power >= 0 AND avg_power < 'Infinity'::DOUBLE PRECISION))
      AND (avg_heart_rate IS NULL OR (avg_heart_rate >= 0 AND avg_heart_rate < 'Infinity'::DOUBLE PRECISION))
      AND (avg_cadence IS NULL OR (avg_cadence >= 0 AND avg_cadence < 'Infinity'::DOUBLE PRECISION))
      AND (avg_speed IS NULL OR (avg_speed >= 0 AND avg_speed < 'Infinity'::DOUBLE PRECISION))
      AND (altimeters IS NULL OR (altimeters > '-Infinity'::DOUBLE PRECISION AND altimeters < 'Infinity'::DOUBLE PRECISION))
    )
);

-- The unique index on (segment_id, position) also serves ordered phase reads
-- and cascading deletes; no duplicate segment_id index is needed.
-- Cross-row rules are validated by the application when saving a complete block:
-- the parent must be a microinterval block, phases must lie inside that block,
-- positions/repetitions must be contiguous, and work/recovery phases must alternate
-- without overlaps or gaps. The final recovery is optional. Save parent and phases
-- together in one transaction. A block has no relationship to any other block.

COMMENT ON COLUMN workout_segments.structure_kind IS
  'Internal segment structure, independent of segmenttype (manual, auto, crit).';
COMMENT ON COLUMN workout_segments.pattern_work_duration_seconds IS
  'Optional nominal work duration for the pattern label, e.g. 40 for 40/20. Actual durations are stored in phases.';
COMMENT ON COLUMN workout_segments.pattern_recovery_duration_seconds IS
  'Optional nominal recovery duration for the pattern label, e.g. 20 for 40/20. Both pattern durations are set together or left null.';
COMMENT ON TABLE workout_segment_phases IS
  'Ordered work/recovery phases belonging to one independent workout segment. Workout and ownership are inherited through segment_id.';
COMMENT ON COLUMN workout_segment_phases.position IS
  'Zero-based chronological position within the parent segment.';
COMMENT ON COLUMN workout_segment_phases.repetition_index IS
  'One-based repetition number. A recovery belongs to the preceding work phase.';
COMMENT ON COLUMN workout_segment_phases.start_offset IS
  'Inclusive start in seconds from workout start, on the same timeline as workout_segments; not relative to the block.';
COMMENT ON COLUMN workout_segment_phases.end_offset IS
  'Inclusive end in seconds from workout start. Duration equals end_offset - start_offset + 1.';
COMMENT ON COLUMN workout_segment_phases.avg_speed IS
  'Average speed in km/h, matching workout_segments.avg_speed.';
COMMENT ON COLUMN workout_segment_phases.altimeters IS
  'Signed elevation difference in the same unit as workout_segments.altimeters (millimeters).';

-- Repetition count, total work/recovery time and trailing-recovery inclusion
-- are derived from the phases instead of persisted as duplicate summary fields.
COMMIT;
