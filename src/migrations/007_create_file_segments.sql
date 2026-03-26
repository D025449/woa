DROP TABLE file_segments;
CREATE TABLE file_segments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    file_id         UUID NOT NULL,
    auth_sub        VARCHAR(255) NOT NULL,
    start_index     INTEGER NOT NULL,
    end_index       INTEGER NOT NULL,

    segmenttype    TEXT DEFAULT 'manual',
    duration        DOUBLE PRECISION,
    power       DOUBLE PRECISION,
    heartrate  DOUBLE PRECISION,

    position        INTEGER,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_file
        FOREIGN KEY (file_id)
        REFERENCES files(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_user
        FOREIGN KEY (auth_sub)
        REFERENCES users(auth_sub)
        ON DELETE CASCADE
);