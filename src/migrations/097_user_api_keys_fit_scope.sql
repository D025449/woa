-- Active: 1793688551865@@127.0.0.1@5432@cwa24_prod_restore_20260805_144216@public
-- Prepare only. The user must review and execute this migration manually.
-- Existing key scopes and hashes are unchanged; FIT requires a newly issued key.
BEGIN;

ALTER TABLE user_api_keys DROP CONSTRAINT user_api_keys_scopes_check;
ALTER TABLE user_api_keys ADD CONSTRAINT user_api_keys_scopes_check CHECK (
  array_ndims(scopes) = 1
  AND array_position(scopes, NULL) IS NULL
  AND scopes <@ ARRAY['workouts:read', 'workouts:gps:read', 'workouts:fit:read']::text[]
  AND 'workouts:read' = ANY(scopes)
  AND (NOT ('workouts:fit:read' = ANY(scopes)) OR 'workouts:gps:read' = ANY(scopes))
  AND cardinality(scopes) = 1
    + CASE WHEN 'workouts:gps:read' = ANY(scopes) THEN 1 ELSE 0 END
    + CASE WHEN 'workouts:fit:read' = ANY(scopes) THEN 1 ELSE 0 END
);

COMMIT;
