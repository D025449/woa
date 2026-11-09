-- Active: 1793688551865@@127.0.0.1@5432@cwa24_prod_restore_20260805_144216@public
-- Prepare only. The user must review and execute this migration manually.
BEGIN;

CREATE TABLE user_api_keys (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  key_prefix TEXT NOT NULL CHECK (char_length(key_prefix) = 17),
  key_hash TEXT NOT NULL UNIQUE CHECK (key_hash ~ '^[a-f0-9]{64}$'),
  scopes TEXT[] NOT NULL CHECK (
    cardinality(scopes) BETWEEN 1 AND 2
    AND array_position(scopes, NULL) IS NULL
    AND scopes <@ ARRAY['workouts:read', 'workouts:gps:read']::text[]
    AND 'workouts:read' = ANY(scopes)
    AND (cardinality(scopes) = 1 OR scopes @> ARRAY['workouts:gps:read']::text[])
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at > created_at),
  revoked_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ
);

CREATE INDEX user_api_keys_user_created_idx ON user_api_keys(user_id, created_at DESC, id DESC);
COMMENT ON COLUMN user_api_keys.key_hash IS 'SHA-256 of a 256-bit random personal key. Full keys are never stored.';

COMMIT;