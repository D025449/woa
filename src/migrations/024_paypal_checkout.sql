BEGIN;

CREATE TABLE IF NOT EXISTS account_plans (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code VARCHAR(40) NOT NULL UNIQUE,
    name VARCHAR(80) NOT NULL,
    description TEXT,
    price NUMERIC(10,2) NOT NULL,
    currency CHAR(3) NOT NULL DEFAULT 'EUR',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TRIGGER trigger_set_updated_at_account_plans
BEFORE UPDATE ON account_plans
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS payment_orders (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan_id BIGINT NOT NULL REFERENCES account_plans(id) ON DELETE RESTRICT,
    provider VARCHAR(30) NOT NULL DEFAULT 'paypal',
    provider_order_id VARCHAR(120) NOT NULL UNIQUE,
    status VARCHAR(30) NOT NULL DEFAULT 'created',
    amount NUMERIC(10,2) NOT NULL,
    currency CHAR(3) NOT NULL,
    approval_url TEXT,
    capture_id VARCHAR(120),
    raw_create_response JSONB,
    raw_capture_response JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT chk_payment_orders_status
      CHECK (status IN ('created', 'approved', 'captured', 'failed', 'canceled'))
);

CREATE INDEX IF NOT EXISTS idx_payment_orders_user_created
    ON payment_orders (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payment_orders_plan_id
    ON payment_orders (plan_id);

CREATE TRIGGER trigger_set_updated_at_payment_orders
BEFORE UPDATE ON payment_orders
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS payment_webhook_events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    provider VARCHAR(30) NOT NULL DEFAULT 'paypal',
    provider_event_id VARCHAR(120) NOT NULL UNIQUE,
    event_type VARCHAR(120),
    payload JSONB NOT NULL,
    processing_status VARCHAR(30) NOT NULL DEFAULT 'received',
    processed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT chk_payment_webhook_processing_status
      CHECK (processing_status IN ('received', 'processed', 'ignored', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_payment_webhook_events_created
    ON payment_webhook_events (created_at DESC);

CREATE TABLE IF NOT EXISTS user_memberships (
    user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    plan_id BIGINT NOT NULL REFERENCES account_plans(id) ON DELETE RESTRICT,
    status VARCHAR(30) NOT NULL DEFAULT 'active',
    source_payment_order_id BIGINT REFERENCES payment_orders(id) ON DELETE SET NULL,
    started_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT chk_user_memberships_status
      CHECK (status IN ('active', 'inactive', 'canceled'))
);

CREATE TRIGGER trigger_set_updated_at_user_memberships
BEFORE UPDATE ON user_memberships
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

INSERT INTO account_plans (code, name, description, price, currency, sort_order)
VALUES
  ('plus', 'Plus', 'Erweiterte Features für ambitionierte Nutzer.', 9.99, 'EUR', 10),
  ('pro', 'Pro', 'Mehr Analyse-Tiefe und höhere Limits.', 19.99, 'EUR', 20),
  ('premium', 'Premium', 'Voller Funktionsumfang inklusive Collaboration Plus.', 39.99, 'EUR', 30)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price = EXCLUDED.price,
  currency = EXCLUDED.currency,
  sort_order = EXCLUDED.sort_order,
  is_active = TRUE;

COMMIT;
