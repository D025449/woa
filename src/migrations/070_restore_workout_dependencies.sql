BEGIN;

-- Re-running the destructive workouts base migration drops dependent views and
-- foreign keys. Remove references that can no longer resolve after a re-import.
DELETE FROM workout_group_shares x
WHERE NOT EXISTS (SELECT 1 FROM workouts w WHERE w.id = x.workout_id);

DELETE FROM workout_thumbnails x
WHERE NOT EXISTS (SELECT 1 FROM workouts w WHERE w.id = x.workout_id);

UPDATE training_plan_session_matches x
SET workout_id = NULL
WHERE workout_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM workouts w WHERE w.id = x.workout_id);

DELETE FROM workout_similarity_edges x
WHERE NOT EXISTS (SELECT 1 FROM workouts w WHERE w.id = x.workout_id_a)
   OR NOT EXISTS (SELECT 1 FROM workouts w WHERE w.id = x.workout_id_b);

DELETE FROM workout_favorites x
WHERE NOT EXISTS (SELECT 1 FROM workouts w WHERE w.id = x.workout_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'workout_group_shares'::regclass
      AND confrelid = 'workouts'::regclass
      AND contype = 'f'
  ) THEN
    ALTER TABLE workout_group_shares
      ADD CONSTRAINT workout_group_shares_workout_id_fkey
      FOREIGN KEY (workout_id) REFERENCES workouts(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'workout_thumbnails'::regclass
      AND confrelid = 'workouts'::regclass
      AND contype = 'f'
  ) THEN
    ALTER TABLE workout_thumbnails
      ADD CONSTRAINT workout_thumbnails_workout_id_fkey
      FOREIGN KEY (workout_id) REFERENCES workouts(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'training_plan_session_matches'::regclass
      AND confrelid = 'workouts'::regclass
      AND contype = 'f'
  ) THEN
    ALTER TABLE training_plan_session_matches
      ADD CONSTRAINT training_plan_session_matches_workout_id_fkey
      FOREIGN KEY (workout_id) REFERENCES workouts(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'workout_similarity_edges'::regclass
      AND confrelid = 'workouts'::regclass
      AND contype = 'f'
      AND pg_get_constraintdef(oid) LIKE 'FOREIGN KEY (workout_id_a)%'
  ) THEN
    ALTER TABLE workout_similarity_edges
      ADD CONSTRAINT workout_similarity_edges_workout_id_a_fkey
      FOREIGN KEY (workout_id_a) REFERENCES workouts(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'workout_similarity_edges'::regclass
      AND confrelid = 'workouts'::regclass
      AND contype = 'f'
      AND pg_get_constraintdef(oid) LIKE 'FOREIGN KEY (workout_id_b)%'
  ) THEN
    ALTER TABLE workout_similarity_edges
      ADD CONSTRAINT workout_similarity_edges_workout_id_b_fkey
      FOREIGN KEY (workout_id_b) REFERENCES workouts(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'workout_favorites'::regclass
      AND confrelid = 'workouts'::regclass
      AND contype = 'f'
  ) THEN
    ALTER TABLE workout_favorites
      ADD CONSTRAINT workout_favorites_workout_id_fkey
      FOREIGN KEY (workout_id) REFERENCES workouts(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE OR REPLACE VIEW v_gps_segment_best_efforts AS
SELECT
  b.id,
  b.sid,
  b.wid,
  b.start_offset,
  b.duration,
  b.end_offset,
  b.avg_power,
  b.avg_heart_rate,
  b.avg_cadence,
  b.avg_speed,
  f.uid,
  f.start_time,
  f.id AS fid,
  f.end_time,
  f.year,
  f.month,
  f.week,
  f.year_quarter,
  f.year_month,
  f.year_week,
  f.total_elapsed_time,
  f.total_timer_time
FROM gps_segment_best_efforts b
INNER JOIN workouts f ON f.id = b.wid;

CREATE OR REPLACE VIEW v_workouts_with_best_efforts AS
SELECT
  f.id,
  f.uid,
  f.uploaded_at,
  f.start_time,
  f.end_time,
  f.year,
  f.month,
  f.week,
  f.year_quarter,
  f.year_month,
  f.year_week,
  f.total_elapsed_time,
  f.total_timer_time,
  f.total_distance,
  f.total_cycles,
  f.total_work,
  f.total_calories,
  f.total_ascent,
  f.total_descent,
  f.avg_speed,
  f.max_speed,
  f.avg_normalized_power,
  f.avg_power,
  f.max_power,
  f.avg_heart_rate,
  f.max_heart_rate,
  f.avg_cadence,
  f.max_cadence,
  f.validGps,
  b.id AS best_effort_id,
  b.wid AS best_effort_file_id,
  b.start_offset,
  b.duration,
  b.end_offset,
  b.avg_power AS best_effort_avg_power,
  b.avg_heart_rate AS best_effort_avg_heart_rate,
  b.avg_cadence AS best_effort_avg_cadence,
  b.avg_speed AS best_effort_avg_speed,
  b.created_at AS best_effort_created_at
FROM workouts f
INNER JOIN workout_segments b ON b.wid = f.id
WHERE b.segmenttype = 'crit';

COMMIT;
