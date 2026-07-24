-- Active: 1776863449169@@127.0.0.1@5432@cwa24_prod
BEGIN;

CREATE TABLE IF NOT EXISTS user_view_preferences (
  uid BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  view_key VARCHAR(80) NOT NULL,
  state JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(state) = 'object'),
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (uid, view_key)
);

COMMIT;
