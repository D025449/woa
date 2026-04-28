CREATE TABLE IF NOT EXISTS training_plan_session_matches (
  id BIGSERIAL PRIMARY KEY,
  training_plan_id BIGINT NOT NULL REFERENCES training_plans(id) ON DELETE CASCADE,
  training_plan_week_id BIGINT NOT NULL REFERENCES training_plan_weeks(id) ON DELETE CASCADE,
  training_plan_session_id BIGINT NULL REFERENCES training_plan_sessions(id) ON DELETE CASCADE,
  workout_id BIGINT NULL REFERENCES workouts(id) ON DELETE CASCADE,
  match_status TEXT NOT NULL,
  match_score NUMERIC(5,4) NULL,
  duration_compliance NUMERIC(5,4) NULL,
  intensity_compliance NUMERIC(5,4) NULL,
  objective_compliance NUMERIC(5,4) NULL,
  matched_by TEXT NOT NULL DEFAULT 'rule_engine',
  match_reason TEXT NULL,
  matched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_training_plan_session_matches_status
    CHECK (match_status IN ('completed', 'mostly_completed', 'substituted', 'missed', 'extra_unplanned')),
  CONSTRAINT chk_training_plan_session_matches_matched_by
    CHECK (matched_by IN ('rule_engine', 'ai_assist', 'manual'))
);

CREATE INDEX IF NOT EXISTS idx_training_plan_session_matches_plan
  ON training_plan_session_matches(training_plan_id, training_plan_week_id);

CREATE INDEX IF NOT EXISTS idx_training_plan_session_matches_session
  ON training_plan_session_matches(training_plan_session_id);

CREATE INDEX IF NOT EXISTS idx_training_plan_session_matches_workout
  ON training_plan_session_matches(workout_id);

CREATE TABLE IF NOT EXISTS training_plan_week_reviews (
  id BIGSERIAL PRIMARY KEY,
  training_plan_id BIGINT NOT NULL REFERENCES training_plans(id) ON DELETE CASCADE,
  training_plan_week_id BIGINT NOT NULL REFERENCES training_plan_weeks(id) ON DELETE CASCADE,
  completion_rate NUMERIC(5,4) NULL,
  volume_compliance NUMERIC(5,4) NULL,
  intensity_compliance NUMERIC(5,4) NULL,
  objective_compliance NUMERIC(5,4) NULL,
  completed_count INTEGER NOT NULL DEFAULT 0,
  mostly_completed_count INTEGER NOT NULL DEFAULT 0,
  substituted_count INTEGER NOT NULL DEFAULT 0,
  missed_count INTEGER NOT NULL DEFAULT 0,
  extra_unplanned_count INTEGER NOT NULL DEFAULT 0,
  review_status TEXT NOT NULL DEFAULT 'on_track',
  review_summary TEXT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_training_plan_week_reviews_week UNIQUE (training_plan_week_id),
  CONSTRAINT chk_training_plan_week_reviews_status
    CHECK (review_status IN ('on_track', 'slightly_off', 'off_track'))
);

CREATE INDEX IF NOT EXISTS idx_training_plan_week_reviews_plan
  ON training_plan_week_reviews(training_plan_id, training_plan_week_id);
