-- Active: 1776863449169@@127.0.0.1@5432@cwa24_prod
BEGIN;

CREATE TABLE IF NOT EXISTS workout_similarity_edges (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  uid BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workout_id_a BIGINT NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
  workout_id_b BIGINT NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
  match_type TEXT NOT NULL,
  score DOUBLE PRECISION NOT NULL,
  distance_delta_ratio DOUBLE PRECISION,
  ascent_delta_ratio DOUBLE PRECISION,
  start_distance_m DOUBLE PRECISION,
  end_distance_m DOUBLE PRECISION,
  point_match_ratio_ab DOUBLE PRECISION,
  point_match_ratio_ba DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_similarity_edge_order CHECK (workout_id_a < workout_id_b),
  CONSTRAINT uq_similarity_edge UNIQUE (uid, workout_id_a, workout_id_b, match_type)
);

CREATE INDEX IF NOT EXISTS idx_similarity_edges_uid
ON workout_similarity_edges (uid);

CREATE INDEX IF NOT EXISTS idx_similarity_edges_workout_a
ON workout_similarity_edges (workout_id_a);

CREATE INDEX IF NOT EXISTS idx_similarity_edges_workout_b
ON workout_similarity_edges (workout_id_b);

CREATE INDEX IF NOT EXISTS idx_similarity_edges_score
ON workout_similarity_edges (score DESC);

COMMIT;
