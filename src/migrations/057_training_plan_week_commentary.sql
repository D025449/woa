CREATE TABLE IF NOT EXISTS training_plan_week_commentary (
  id BIGSERIAL PRIMARY KEY,
  training_plan_id BIGINT NOT NULL REFERENCES training_plans(id) ON DELETE CASCADE,
  training_plan_week_id BIGINT NOT NULL REFERENCES training_plan_weeks(id) ON DELETE CASCADE,
  model_name TEXT NOT NULL,
  commentary_payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_training_plan_week_commentary_week UNIQUE (training_plan_week_id)
);

CREATE INDEX IF NOT EXISTS idx_training_plan_week_commentary_plan
  ON training_plan_week_commentary(training_plan_id, training_plan_week_id);
