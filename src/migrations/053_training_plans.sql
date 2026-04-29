CREATE TABLE IF NOT EXISTS training_plans (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_name TEXT NOT NULL,
  plan_start_date DATE NULL,
  primary_goal TEXT NOT NULL,
  power_focus TEXT NULL,
  athlete_data_mode TEXT NOT NULL DEFAULT 'current',
  planning_style TEXT NOT NULL DEFAULT 'balanced',
  plan_horizon_weeks INTEGER NOT NULL,
  weekly_hours NUMERIC(6,2) NULL,
  entered_weekly_hours NUMERIC(6,2) NULL,
  event_date DATE NULL,
  event_distance_km NUMERIC(8,2) NULL,
  event_elevation_m NUMERIC(8,2) NULL,
  event_duration_h NUMERIC(8,2) NULL,
  terrain_profile TEXT NULL,
  available_days JSONB NOT NULL DEFAULT '[]'::jsonb,
  notes TEXT NULL,
  input_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  context_snapshot JSONB NULL,
  planning_signals JSONB NULL,
  summary_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_training_plans_user_created_at
  ON training_plans(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS training_plan_weeks (
  id BIGSERIAL PRIMARY KEY,
  training_plan_id BIGINT NOT NULL REFERENCES training_plans(id) ON DELETE CASCADE,
  week_number INTEGER NOT NULL,
  theme TEXT NOT NULL,
  target_hours NUMERIC(6,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (training_plan_id, week_number)
);

CREATE INDEX IF NOT EXISTS idx_training_plan_weeks_plan_week
  ON training_plan_weeks(training_plan_id, week_number);

CREATE TABLE IF NOT EXISTS training_plan_sessions (
  id BIGSERIAL PRIMARY KEY,
  training_plan_week_id BIGINT NOT NULL REFERENCES training_plan_weeks(id) ON DELETE CASCADE,
  planned_date DATE NULL,
  day_code TEXT NOT NULL,
  session_type TEXT NOT NULL,
  title TEXT NOT NULL,
  duration_hours NUMERIC(6,2) NOT NULL,
  notes TEXT NULL,
  objective TEXT NULL,
  intensity TEXT NULL,
  zone_label TEXT NULL,
  energy_system TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_training_plan_sessions_week
  ON training_plan_sessions(training_plan_week_id);
