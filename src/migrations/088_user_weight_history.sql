-- Active: 1793267108229@@127.0.0.1@5432@cwa24_prod_restore_20260805_144216@public
-- Additive migration; execute this file directly against an existing app schema.
-- No profile weights are copied and no dependent data is recalculated.
BEGIN;

CREATE TABLE IF NOT EXISTS user_weight_history (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  valid_from DATE NOT NULL,
  weight_kg NUMERIC(5,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT user_weight_history_user_date_unique
    UNIQUE (user_id, valid_from),
  CONSTRAINT user_weight_history_date_check
    CHECK (isfinite(valid_from)),
  CONSTRAINT user_weight_history_weight_check
    CHECK (weight_kg > 0 AND weight_kg <= 500)
);

-- The unique index supports date lookups (including backward scans),
-- ordered history reads and cascading deletes without an additional index.
DROP TRIGGER IF EXISTS trigger_set_updated_at_user_weight_history
  ON user_weight_history;

CREATE TRIGGER trigger_set_updated_at_user_weight_history
BEFORE UPDATE ON user_weight_history
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE user_weight_history IS
  'User body weight history. Each entry applies from valid_from until the next entry for the same user.';
COMMENT ON COLUMN user_weight_history.valid_from IS
  'Inclusive calendar date without time of day. Resolve weight using the latest entry with valid_from <= the requested date.';
COMMENT ON COLUMN user_weight_history.weight_kg IS
  'Body weight in kilograms, greater than zero and at most 500 kg.';

-- If no entry applies to the requested date, the application falls back to
-- user_profiles.weight_kg. If that is also NULL, no weight is available.
-- The existing profile weight remains independent of this history.
COMMIT;
