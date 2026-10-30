-- Active: 1793267108229@@127.0.0.1@5432@cwa24_prod_restore_20260805_144216@public
-- Additive migration: stores encrypted personal Garmin API keys only.
BEGIN;
CREATE TABLE IF NOT EXISTS user_garmin_connections (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  api_key_encrypted TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON COLUMN user_garmin_connections.api_key_encrypted IS
  'Versioned AES-256-GCM envelope; encryption key is held outside the database.';
COMMIT;
