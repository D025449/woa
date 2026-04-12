BEGIN;
DROP TABLE IF EXISTS workout_segments CASCADE;
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


END;