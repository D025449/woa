BEGIN;
CREATE EXTENSION IF NOT EXISTS "pgcrypto";  -- für gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS postgis;

DROP TABLE IF EXISTS workouts CASCADE;


DROP INDEX idx_files_geom;

CREATE TABLE workouts (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    uid               BIGINT   NOT NULL,
    original_filename TEXT          NOT NULL,
    s3_key            TEXT           NOT NULL,
    mime_type         TEXT           NOT NULL,
    file_size         INTEGER        NOT NULL,
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

    minLat               DOUBLE PRECISION,
    maxLat               DOUBLE PRECISION,
    minLng               DOUBLE PRECISION,
    maxLng               DOUBLE PRECISION,
    validGPS             BOOLEAN,
    points_count         INTEGER,
    sampleRateGPS        DOUBLE PRECISION,

    bounds               geometry(POLYGON, 4326),
    geom                 geometry(LINESTRING, 4326),

    CONSTRAINT uq_user_start_time2 UNIQUE (uid, start_time),
    CONSTRAINT fk_user2 FOREIGN KEY (uid)
        REFERENCES users(id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_files_bounds
ON workouts
USING GIST (bounds);

CREATE INDEX IF NOT EXISTS idx_files_geom
ON workouts
USING GIST (geom);

COMMIT;
