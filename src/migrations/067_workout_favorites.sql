-- Active: 1776863449169@@127.0.0.1@5432@cwa24_prod
BEGIN;

CREATE TABLE IF NOT EXISTS workout_favorites (
  uid BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workout_id BIGINT NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (uid, workout_id)
);

CREATE INDEX IF NOT EXISTS idx_workout_favorites_workout_id
  ON workout_favorites (workout_id);

COMMIT;
