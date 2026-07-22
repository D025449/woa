BEGIN;

DROP TABLE IF EXISTS workouts CASCADE;

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
    stream_codec         TEXT,
    validGps             BOOLEAN,
    gps_source           TEXT,
    workout_type         TEXT NOT NULL DEFAULT 'unknown',
    manual_gps_lookup_points JSONB,
    segment_processing_status TEXT NOT NULL DEFAULT 'completed',
    segment_processing_error  TEXT,
    segment_processing_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    points_count         INTEGER,
    sampleRateGPS        DOUBLE PRECISION,
    gps_track_blob       BYTEA,
    gps_track_blob_codec TEXT,

    gps_bounds           box,
    track_start_lat      DOUBLE PRECISION,
    track_start_lng      DOUBLE PRECISION,
    track_end_lat        DOUBLE PRECISION,
    track_end_lng        DOUBLE PRECISION,

    CONSTRAINT uq_user_start_time2 UNIQUE (uid, start_time),
    CONSTRAINT fk_user2 FOREIGN KEY (uid)
        REFERENCES users(id)
        ON DELETE CASCADE,
    CONSTRAINT workouts_gps_source_check
        CHECK (gps_source IS NULL OR gps_source IN ('recorded', 'manual_lookup')),
    CONSTRAINT workouts_workout_type_check
        CHECK (workout_type IN ('indoor', 'road', 'mountain', 'unknown')),
    CONSTRAINT workouts_stream_codec_check
        CHECK (stream_codec IS NULL OR stream_codec IN ('brotli', 'gzip')),
    CONSTRAINT workouts_gps_track_blob_codec_check
        CHECK (gps_track_blob_codec IS NULL OR gps_track_blob_codec IN ('identity', 'brotli', 'gzip')),
    CONSTRAINT chk_workouts_segment_processing_status
        CHECK (segment_processing_status IN ('pending', 'processing', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_files_bounds
ON workouts
USING GIST (gps_bounds);

CREATE INDEX IF NOT EXISTS idx_workouts_track_start_coordinates
ON workouts
  (uid, track_start_lat, track_start_lng);

CREATE INDEX IF NOT EXISTS idx_workouts_uid
ON workouts (uid);

CREATE INDEX IF NOT EXISTS idx_workouts_uid_type_start_time
ON workouts (uid, workout_type, start_time DESC);

COMMIT;
