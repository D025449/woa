BEGIN;

CREATE TABLE IF NOT EXISTS user_roles (
  uid BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(32) NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  granted_by_uid BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (uid, role),
  CONSTRAINT user_roles_role_check
    CHECK (role IN ('admin'))
);

CREATE INDEX IF NOT EXISTS idx_user_roles_role_uid
  ON user_roles (role, uid);

CREATE INDEX IF NOT EXISTS idx_user_roles_granted_by_uid
  ON user_roles (granted_by_uid)
  WHERE granted_by_uid IS NOT NULL;

COMMIT;
