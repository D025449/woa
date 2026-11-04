-- Active: 1793688551865@@127.0.0.1@5432@cwa24_prod_restore_20260805_144216@public
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

LOCK TABLE public.workouts IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMP TABLE workout_end_time_repairs ON COMMIT DROP AS
SELECT id, uid, start_time,
       start_time + make_interval(secs => total_elapsed_time) AS repaired_end_time
FROM public.workouts
WHERE start_time IS NOT NULL
  AND (end_time IS NULL OR end_time <= start_time)
  AND total_elapsed_time > 0
  AND total_elapsed_time < 'Infinity'::double precision;

DO $$
DECLARE
  conflict_count bigint;
BEGIN
  SELECT count(*) INTO conflict_count
  FROM (
    SELECT DISTINCT LEAST(candidate.id, other.id), GREATEST(candidate.id, other.id)
    FROM pg_temp.workout_end_time_repairs candidate
    JOIN public.workouts other ON other.uid = candidate.uid AND other.id <> candidate.id
    LEFT JOIN pg_temp.workout_end_time_repairs other_repair ON other_repair.id = other.id
    WHERE other.start_time IS NOT NULL
      AND COALESCE(other_repair.repaired_end_time, other.end_time) > other.start_time
      AND candidate.start_time < COALESCE(other_repair.repaired_end_time, other.end_time)
      AND other.start_time < candidate.repaired_end_time
  ) conflicts;

  IF conflict_count > 0 THEN
    RAISE EXCEPTION 'End-time repair aborted: % overlapping workout pairs. Run the documented read-only audit and resolve conflicts manually.', conflict_count;
  END IF;
END;
$$;

UPDATE public.workouts workout
SET end_time = repair.repaired_end_time
FROM pg_temp.workout_end_time_repairs repair
WHERE workout.id = repair.id;

COMMIT;