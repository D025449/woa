-- Active: 1793688551865@@127.0.0.1@5432@cwa24_prod_restore_20260805_144216@public
BEGIN;

ALTER TABLE workout_segments
  DROP CONSTRAINT workout_segments_structure_kind_check,
  DROP CONSTRAINT workout_segments_microinterval_type_check,
  DROP CONSTRAINT workout_segments_microinterval_pattern_check;

ALTER TABLE workout_segments
  ADD CONSTRAINT workout_segments_structure_kind_check
    CHECK (structure_kind IN ('simple', 'microintervals', 'intervals')),
  ADD CONSTRAINT workout_segments_microinterval_type_check
    CHECK (structure_kind = 'simple' OR (segmenttype IS NOT NULL AND segmenttype IN ('manual', 'auto'))),
  ADD CONSTRAINT workout_segments_microinterval_pattern_check
    CHECK (
      (pattern_work_duration_seconds IS NULL AND pattern_recovery_duration_seconds IS NULL)
      OR (
        structure_kind IN ('microintervals', 'intervals')
        AND pattern_work_duration_seconds IS NOT NULL
        AND pattern_recovery_duration_seconds IS NOT NULL
        AND pattern_work_duration_seconds > 0
        AND pattern_recovery_duration_seconds > 0
      )
    );

COMMENT ON TABLE workout_segment_phases IS
  'Ordered work/recovery phases of a microinterval or longer interval block. Workout and ownership are inherited through segment_id.';

COMMIT;