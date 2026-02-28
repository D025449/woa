BEGIN;

-- 1️⃣ UUID Extension sicherstellen (für gen_random_uuid)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 2️⃣ Alte Tabelle entfernen (ACHTUNG: CASCADE löscht abhängige Tabellen!)
DROP TABLE IF EXISTS users CASCADE;

-- 3️⃣ Neue Users-Tabelle
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Auth0 / Cognito / OIDC Sub
    auth_sub VARCHAR(255) NOT NULL UNIQUE,

    email VARCHAR(255) NOT NULL UNIQUE,
    email_verified BOOLEAN DEFAULT FALSE,

    display_name VARCHAR(100),

    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4️⃣ Optionaler Index für schnellere Suche per Email
CREATE INDEX idx_users_email ON users(email);

-- 5️⃣ Updated_at automatisch pflegen
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_set_updated_at
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

COMMIT;