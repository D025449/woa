BEGIN;
CREATE EXTENSION IF NOT EXISTS "pgcrypto";  -- für gen_random_uuid()

DROP TABLE IF EXISTS files CASCADE;

CREATE TABLE files (
    id               UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
    auth_sub         VARCHAR(255)   NOT NULL,
    original_filename TEXT          NOT NULL,
    s3_key           TEXT           NOT NULL,
    mime_type        TEXT           NOT NULL,
    file_size        INTEGER        NOT NULL,
    uploaded_at      TIMESTAMP      NOT NULL DEFAULT NOW(),

    start_time           TIMESTAMPTZ,
    end_time             TIMESTAMPTZ,

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

    avg_power            DOUBLE PRECISION,
    max_power            DOUBLE PRECISION,

    avg_heart_rate       DOUBLE PRECISION,
    max_heart_rate       DOUBLE PRECISION,

    avg_cadence          DOUBLE PRECISION,
    max_cadence          DOUBLE PRECISION,

    nec_lat              DOUBLE PRECISION,
    nec_long             DOUBLE PRECISION,
    swc_lat              DOUBLE PRECISION,
    swc_long             DOUBLE PRECISION,


    CONSTRAINT uq_user_file UNIQUE (auth_sub, original_filename),
    CONSTRAINT fk_user FOREIGN KEY (auth_sub)
        REFERENCES users(auth_sub)
        ON DELETE CASCADE
);
COMMIT;