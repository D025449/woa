BEGIN;
CREATE EXTENSION IF NOT EXISTS postgis;

DROP TABLE IF EXISTS workouts CASCADE;


DROP INDEX IF EXISTS idx_files_geom;

CREATE TABLE workouts (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    uid               BIGINT   NOT NULL,
    uploaded_at       TIMESTAMP      NOT NULL DEFAULT NOW(),

    start_time          TIMESTAMPTZ,
    end_time            TIMESTAMPTZ,

    year                INTEGER,
    month               INTEGER,
    week                INTEGER,
    year_quarter        INTEGER,
    year_month          INTEGER,
    year_week           INTEGER,

    total_elapsed_time   DOUBLE PRECISION,
    total_timer_time     DOUBLE PRECISION,

    total_distance       DOUBLE PRECISION,
    total_cycles         INTEGER,
    total_work           DOUBLE PRECISION,
    total_calories       DOUBLE PRECISION,
    total_ascent         DOUBLE PRECISION,
    total_descent        DOUBLE PRECISION,

    avg_speed            DOUBLE PRECISION,
    max_speed            DOUBLE PRECISION,
    avg_normalized_power DOUBLE PRECISION,

    avg_power            DOUBLE PRECISION,
    max_power            DOUBLE PRECISION,

    avg_heart_rate       DOUBLE PRECISION,
    max_heart_rate       DOUBLE PRECISION,

    avg_cadence          DOUBLE PRECISION,
    max_cadence          DOUBLE PRECISION,
    stream               BYTEA NOT NULL,
    validGps             BOOLEAN,
    gps_source           TEXT,
    manual_gps_lookup_points JSONB,
    segment_processing_status TEXT NOT NULL DEFAULT 'completed',
    segment_processing_error  TEXT,
    segment_processing_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    points_count         INTEGER,
    sampleRateGPS        DOUBLE PRECISION,
    gps_track_blob       BYTEA,

    bounds               geometry(POLYGON, 4326),
    track_start          geometry(POINT, 4326),
    track_end            geometry(POINT, 4326),

    CONSTRAINT uq_user_start_time2 UNIQUE (uid, start_time),
    CONSTRAINT fk_user2 FOREIGN KEY (uid)
        REFERENCES users(id)
        ON DELETE CASCADE,
    CONSTRAINT workouts_gps_source_check
        CHECK (gps_source IS NULL OR gps_source IN ('recorded', 'manual_lookup')),
    CONSTRAINT chk_workouts_segment_processing_status
        CHECK (segment_processing_status IN ('pending', 'processing', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_files_bounds
ON workouts
USING GIST (bounds);

CREATE INDEX IF NOT EXISTS idx_workouts_track_start
ON workouts
USING GIST (track_start);

CREATE INDEX IF NOT EXISTS idx_workouts_track_end
ON workouts
USING GIST (track_end);

-- CREATE INDEX IF NOT EXISTS idx_files_geom
-- ON workouts
-- USING GIST (geom);

CREATE INDEX IF NOT EXISTS idx_workouts_uid
ON workouts (uid);

-- CREATE INDEX IF NOT EXISTS idx_workouts_geom_geography
-- ON workouts
-- USING GIST ((geom::geography));

COMMIT;
