-- Active: 1793688551865@@127.0.0.1@5432@cwa24_prod_restore_20260805_144216@public
-- Prepare only: the user must review and execute this migration manually.
BEGIN;
ALTER TABLE user_mcp_grants DROP CONSTRAINT user_mcp_grants_scopes_check;
ALTER TABLE user_mcp_grants ADD CONSTRAINT user_mcp_grants_scopes_check CHECK (
  cardinality(scopes) BETWEEN 1 AND 4 AND array_position(scopes, NULL) IS NULL
  AND scopes <@ ARRAY['workouts:read', 'analytics:read', 'activities:write', 'offline_access']::text[]
  AND scopes && ARRAY['workouts:read', 'analytics:read']::text[]
);
COMMIT;
