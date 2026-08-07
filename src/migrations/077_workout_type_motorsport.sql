-- Active: 1776863449169@@127.0.0.1@5432@cwa24_prod_restore_20260805_144216
BEGIN;

ALTER TABLE workouts
  DROP CONSTRAINT IF EXISTS workouts_workout_type_check;

ALTER TABLE workouts
  ADD CONSTRAINT workouts_workout_type_check
  CHECK (workout_type IN ('indoor', 'road', 'mountain', 'motorsport', 'unknown'));

CREATE OR REPLACE VIEW v_gps_segment_best_efforts AS
SELECT
    b.id AS id,
    b.sid AS sid,
    b.wid AS wid,
    b.start_offset,
    b.duration,
    b.end_offset,
    b.avg_power AS avg_power,
    b.avg_heart_rate AS avg_heart_rate,
    b.avg_cadence AS avg_cadence,
    b.avg_speed AS avg_speed,
    f.uid AS uid,
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
INNER JOIN workouts f ON f.id = b.wid
WHERE f.workout_type <> 'motorsport';

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
    f.validgps,
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
WHERE b.segmenttype = 'crit'
  AND f.workout_type <> 'motorsport';

COMMIT;
