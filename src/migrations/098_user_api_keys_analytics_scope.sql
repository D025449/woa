-- Active: 1793688551865@@127.0.0.1@5432@cwa24_prod_restore_20260805_144216@public
-- Prepare only; the user must review and execute this migration manually.
-- Analytics may be issued independently. Existing keys retain their scopes.
BEGIN;

ALTER TABLE user_api_keys DROP CONSTRAINT user_api_keys_scopes_check;
ALTER TABLE user_api_keys ADD CONSTRAINT user_api_keys_scopes_check CHECK (
  array_ndims(scopes) = 1
  AND array_position(scopes, NULL) IS NULL
  AND cardinality(scopes) >= 1
  AND scopes <@ ARRAY['workouts:read', 'workouts:gps:read', 'workouts:fit:read', 'analytics:read']::text[]
  AND (NOT ('workouts:gps:read' = ANY(scopes)) OR 'workouts:read' = ANY(scopes))
  AND (NOT ('workouts:fit:read' = ANY(scopes)) OR 'workouts:gps:read' = ANY(scopes))
  AND cardinality(scopes) =
    CASE WHEN 'workouts:read' = ANY(scopes) THEN 1 ELSE 0 END
    + CASE WHEN 'workouts:gps:read' = ANY(scopes) THEN 1 ELSE 0 END
    + CASE WHEN 'workouts:fit:read' = ANY(scopes) THEN 1 ELSE 0 END
    + CASE WHEN 'analytics:read' = ANY(scopes) THEN 1 ELSE 0 END
);

COMMIT;
