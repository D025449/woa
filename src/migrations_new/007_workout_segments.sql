BEGIN;
CREATE EXTENSION IF NOT EXISTS "pgcrypto";  -- für gen_random_uuid()
DROP VIEW IF EXISTS v_workouts_with_best_efforts;
DROP TABLE IF EXISTS workout_segments;
CREATE TABLE workout_segments (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    wid             BIGINT NOT NULL,
    UID             BIGINT NOT NULL,
    segmenttype     VARCHAR(10) DEFAULT 'manual',
    segmentname     VARCHAR(100),
    start_offset    INTEGER NOT NULL,
    end_offset      INTEGER NOT NULL,
    duration        INTEGER NOT NULL,
    avg_power       DOUBLE PRECISION NOT NULL,
    avg_heart_rate  DOUBLE PRECISION,
    avg_cadence     DOUBLE PRECISION,
    avg_speed       DOUBLE PRECISION,    
    altimeters      DOUBLE PRECISION,
    position        INTEGER,
    bounds          geometry(POLYGON, 4326),

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_segmenttype
        CHECK (segmenttype IN ('manual', 'auto', 'crit')),

    CONSTRAINT ck_file_best_efforts_offset
        CHECK (start_offset >= 0),

    CONSTRAINT ck_file_best_efforts_duration
        CHECK (duration > 0),

    CONSTRAINT ck_file_best_efforts_end_offset
        CHECK (end_offset >= start_offset),


    CONSTRAINT uq_file_best_effort_start_offet_duration2
        UNIQUE (wid, segmenttype, start_offset, duration),


    CONSTRAINT fk_workout
        FOREIGN KEY (wid)
        REFERENCES workouts(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_user
        FOREIGN KEY (uid)
        REFERENCES users(id)
        ON DELETE CASCADE
);


CREATE VIEW v_workouts_with_best_efforts AS
SELECT
    f.id,
    f.uid,
    f.original_filename,
    f.s3_key,
    f.mime_type,
    f.file_size,
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

    f.minLat,
    f.maxLat,
    f.minLng,
    f.maxLng,
    f.validGPS,
    
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
where b.segmenttype = 'crit';
END;