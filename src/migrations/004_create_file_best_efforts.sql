BEGIN;
CREATE EXTENSION IF NOT EXISTS "pgcrypto";  -- für gen_random_uuid()

DROP TABLE IF EXISTS file_best_efforts CASCADE;

CREATE TABLE file_best_efforts (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    file_id           UUID NOT NULL,

    start_offset      INTEGER NOT NULL,
    duration          INTEGER NOT NULL,
    end_offset        INTEGER NOT NULL,

    avg_power         DOUBLE PRECISION NOT NULL,
    avg_heart_rate    DOUBLE PRECISION,
    avg_cadence       DOUBLE PRECISION,
    avg_speed         DOUBLE PRECISION,

    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_file_best_efforts_file
        FOREIGN KEY (file_id)
        REFERENCES files(id)
        ON DELETE CASCADE,

    CONSTRAINT ck_file_best_efforts_offset
        CHECK (start_offset >= 0),

    CONSTRAINT ck_file_best_efforts_duration
        CHECK (duration > 0),

    CONSTRAINT ck_file_best_efforts_end_offset
        CHECK (end_offset >= start_offset),

    CONSTRAINT ck_file_best_efforts_window
        CHECK (end_offset = start_offset + duration - 1),

    CONSTRAINT uq_file_best_effort_duration
        UNIQUE (file_id, duration)
);

END;
