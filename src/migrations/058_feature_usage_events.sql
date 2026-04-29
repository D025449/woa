CREATE TABLE IF NOT EXISTS feature_usage_events (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tier_code TEXT NOT NULL,
  feature_key TEXT NOT NULL,
  amount INTEGER NOT NULL DEFAULT 1,
  period_key TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_feature_usage_events_amount CHECK (amount > 0)
);

CREATE INDEX IF NOT EXISTS idx_feature_usage_events_user_feature_period
  ON feature_usage_events(user_id, feature_key, period_key);

CREATE INDEX IF NOT EXISTS idx_feature_usage_events_user_created
  ON feature_usage_events(user_id, created_at DESC);
