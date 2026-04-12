BEGIN;

-- 1️⃣ Alte Tabelle entfernen (ACHTUNG!)
DROP TABLE IF EXISTS users CASCADE;

-- 2️⃣ Neue Users-Tabelle
CREATE TABLE users (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    -- Auth0 / Cognito / OIDC Sub
    auth_sub VARCHAR(255) NOT NULL UNIQUE,

    email VARCHAR(255) NOT NULL UNIQUE,
    email_verified BOOLEAN DEFAULT FALSE,

    display_name VARCHAR(100),

    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3️⃣ Index für Email
CREATE INDEX idx_users_email ON users(email);

-- 4️⃣ Updated_at automatisch pflegen
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