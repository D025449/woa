BEGIN;
CREATE EXTENSION IF NOT EXISTS "pgcrypto";  -- für gen_random_uuid()

CREATE TABLE files (
    id               UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
    auth_sub         VARCHAR(255)   NOT NULL,
    original_filename TEXT          NOT NULL,
    s3_key           TEXT           NOT NULL,
    mime_type        TEXT           NOT NULL,
    file_size        INTEGER        NOT NULL,
    uploaded_at      TIMESTAMP      NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_user_file UNIQUE (auth_sub, original_filename),
    CONSTRAINT fk_user FOREIGN KEY (auth_sub)
        REFERENCES users(auth_sub)
        ON DELETE CASCADE
);
COMMIT;