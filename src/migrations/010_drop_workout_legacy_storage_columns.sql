BEGIN;

DROP VIEW IF EXISTS v_workouts_with_best_efforts CASCADE;

ALTER TABLE workouts
  DROP COLUMN IF EXISTS original_filename,
  DROP COLUMN IF EXISTS mime_type,
  DROP COLUMN IF EXISTS file_size,
  DROP COLUMN IF EXISTS s3_key,
  DROP COLUMN IF EXISTS minLat,
  DROP COLUMN IF EXISTS maxLat,
  DROP COLUMN IF EXISTS minLng,
  DROP COLUMN IF EXISTS maxLng;



CREATE VIEW v_workouts_with_best_efforts AS
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
INNER JOIN workout_segments b
    ON b.wid = f.id
WHERE b.segmenttype = 'crit';

COMMIT;
