-- Active: 1793603949676@@127.0.0.1@5432@cwa24_dev
-- Prepare only; run manually after review.
BEGIN;
CREATE TABLE IF NOT EXISTS user_wahoo_connections (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tokens_encrypted TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON COLUMN user_wahoo_connections.tokens_encrypted IS
  'Versioned AES-256-GCM token envelope; encryption key held outside database.';
COMMIT;
