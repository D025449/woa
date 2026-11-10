-- Active: 1793688551865@@127.0.0.1@5432@cwa24_prod_restore_20260805_144216@public
-- Prepare only: the user must review and execute this migration manually.
BEGIN;
CREATE TABLE user_mcp_grants (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL CHECK (char_length(client_name) BETWEEN 1 AND 80),
  consent_hash TEXT NOT NULL UNIQUE CHECK (consent_hash ~ '^[a-f0-9]{64}$'),
  resource TEXT NOT NULL,
  scopes TEXT[] NOT NULL CHECK (
    cardinality(scopes) BETWEEN 1 AND 3 AND array_position(scopes, NULL) IS NULL
    AND scopes <@ ARRAY['workouts:read', 'analytics:read', 'offline_access']::text[]
    AND scopes && ARRAY['workouts:read', 'analytics:read']::text[]
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '90 days',
  CHECK (expires_at > created_at),
  revoked_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ
);
CREATE INDEX user_mcp_grants_owner_idx ON user_mcp_grants(user_id, created_at DESC, id DESC);
CREATE TABLE mcp_oauth_tokens (
  token_hash TEXT PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  grant_id BIGINT NOT NULL REFERENCES user_mcp_grants(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('code', 'access', 'refresh')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  redirect_uri TEXT,
  code_challenge TEXT,
  CHECK (expires_at > created_at),
  CHECK ((kind = 'code' AND redirect_uri IS NOT NULL AND code_challenge IS NOT NULL AND code_challenge ~ '^[A-Za-z0-9_-]{43}$')
    OR (kind <> 'code' AND redirect_uri IS NULL AND code_challenge IS NULL))
);
CREATE INDEX mcp_oauth_tokens_grant_idx ON mcp_oauth_tokens(grant_id);
COMMENT ON TABLE mcp_oauth_tokens IS 'Only SHA-256 hashes of high entropy secrets. Consumed refresh tokens detect replay until grant expiry.';
COMMIT;
