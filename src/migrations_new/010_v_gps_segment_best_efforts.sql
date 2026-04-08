DROP VIEW IF EXISTS v_gps_segment_best_efforts;
CREATE VIEW v_gps_segment_best_efforts AS
SELECT
    b.id AS id,
    b.sid as sid,
    b.wid AS wid,
    b.start_offset,
    b.duration,
    b.end_offset,
    b.avg_power AS avg_power,
    b.avg_heart_rate AS avg_heart_rate,
    b.avg_cadence AS avg_cadence,
    b.avg_speed AS avg_speed,
    f.uid as uid,
    f.start_time,
    f.id as fid,
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
INNER JOIN workouts f
    ON f.id = b.wid;