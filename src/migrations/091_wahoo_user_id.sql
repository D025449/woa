-- Active: 1793267108229@@127.0.0.1@5432@cwa24_prod_restore_20260805_144216@public
-- Prepare only; run manually after review, after migration 090.
BEGIN;

-- Existing connections remain valid; a later application change fills this ID.
ALTER TABLE user_wahoo_connections
  ADD COLUMN wahoo_user_id BIGINT;

-- NULL is permitted for existing connections. A Wahoo account may be linked
-- to only one WOA account at a time.
ALTER TABLE user_wahoo_connections
  ADD CONSTRAINT user_wahoo_connections_wahoo_user_id_key UNIQUE (wahoo_user_id),
  ADD CONSTRAINT user_wahoo_connections_wahoo_user_id_positive
    CHECK (wahoo_user_id > 0);

COMMENT ON COLUMN user_wahoo_connections.wahoo_user_id IS
  'Wahoo user ID for webhook routing; NULL until populated by the application.';

COMMIT;
