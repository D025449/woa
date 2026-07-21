-- Active: 1776863449169@@127.0.0.1@5432@cwa24_prod
BEGIN;

CREATE TABLE IF NOT EXISTS segment_favorites (
  uid BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  segment_id BIGINT NOT NULL REFERENCES gps_segments(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (uid, segment_id)
);

CREATE INDEX IF NOT EXISTS idx_segment_favorites_segment_id
  ON segment_favorites (segment_id);

COMMIT;
