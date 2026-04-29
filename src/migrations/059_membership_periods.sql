-- Active: 1776861341281@@127.0.0.1@5432@cwa24_dev
BEGIN;

ALTER TABLE account_plans
  ADD COLUMN IF NOT EXISTS tier_code VARCHAR(40),
  ADD COLUMN IF NOT EXISTS duration_months INTEGER;

UPDATE account_plans
SET
  tier_code = CASE
    WHEN code LIKE 'plus%' THEN 'plus'
    WHEN code LIKE 'pro%' THEN 'pro'
    WHEN code LIKE 'premium%' THEN 'premium'
    ELSE COALESCE(tier_code, code)
  END,
  duration_months = COALESCE(duration_months, 12);

ALTER TABLE account_plans
  ALTER COLUMN tier_code SET NOT NULL,
  ALTER COLUMN duration_months SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_account_plans_duration_months'
  ) THEN
    ALTER TABLE account_plans
      ADD CONSTRAINT chk_account_plans_duration_months
      CHECK (duration_months IN (3, 12));
  END IF;
END $$;

ALTER TABLE user_memberships
  ADD COLUMN IF NOT EXISTS current_period_start TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS current_period_end TIMESTAMP WITH TIME ZONE;

UPDATE user_memberships
SET
  current_period_start = COALESCE(current_period_start, started_at),
  current_period_end = COALESCE(current_period_end, started_at + INTERVAL '12 months');

ALTER TABLE user_memberships
  ALTER COLUMN current_period_start SET NOT NULL,
  ALTER COLUMN current_period_end SET NOT NULL;

UPDATE account_plans
SET
  is_active = FALSE,
  description = COALESCE(description, '') || ' Legacy non-period membership plan.'
WHERE code IN ('plus', 'pro', 'premium');

INSERT INTO account_plans (code, tier_code, duration_months, name, description, price, currency, sort_order)
VALUES
  ('plus-quarterly', 'plus', 3, 'Plus · 3 Months', 'Extended limits and coaching for one quarter.', 9.99, 'EUR', 10),
  ('plus-yearly', 'plus', 12, 'Plus · 12 Months', 'Extended limits and coaching for one year.', 29.99, 'EUR', 11),
  ('pro-quarterly', 'pro', 3, 'Pro · 3 Months', 'Higher limits and deeper planning for one quarter.', 19.99, 'EUR', 20),
  ('pro-yearly', 'pro', 12, 'Pro · 12 Months', 'Higher limits and deeper planning for one year.', 59.99, 'EUR', 21),
  ('premium-quarterly', 'premium', 3, 'Premium · 3 Months', 'Full access and the highest limits for one quarter.', 39.99, 'EUR', 30),
  ('premium-yearly', 'premium', 12, 'Premium · 12 Months', 'Full access and the highest limits for one year.', 119.99, 'EUR', 31)
ON CONFLICT (code) DO UPDATE SET
  tier_code = EXCLUDED.tier_code,
  duration_months = EXCLUDED.duration_months,
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price = EXCLUDED.price,
  currency = EXCLUDED.currency,
  sort_order = EXCLUDED.sort_order,
  is_active = TRUE;

COMMIT;
