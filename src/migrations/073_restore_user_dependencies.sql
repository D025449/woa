BEGIN;

DO $$
DECLARE
  dependency RECORD;
  relation_oid REGCLASS;
  column_number SMALLINT;
  has_user_fk BOOLEAN;
BEGIN
  FOR dependency IN
    SELECT *
    FROM (VALUES
      ('groups', 'owner_user_id', 'groups_owner_user_fk'),
      ('group_members', 'user_id', 'group_members_user_fk'),
      ('group_invites', 'invited_user_id', 'group_invites_invited_user_fk'),
      ('group_invites', 'invited_by_user_id', 'group_invites_invited_by_user_fk'),
      ('workout_group_shares', 'shared_by_user_id', 'workout_group_shares_shared_by_user_id_fkey'),
      ('group_feed_events', 'actor_user_id', 'group_feed_events_actor_user_id_fkey'),
      ('group_feed_event_dismissals', 'user_id', 'group_feed_event_dismissals_user_id_fkey'),
      ('gps_segment_group_shares', 'shared_by_user_id', 'gps_segment_group_shares_shared_by_user_id_fkey'),
      ('group_invite_sender_dismissals', 'user_id', 'group_invite_sender_dismissals_user_id_fkey'),
      ('user_profiles', 'user_id', 'user_profiles_user_id_fkey'),
      ('payment_orders', 'user_id', 'payment_orders_user_id_fkey'),
      ('user_memberships', 'user_id', 'user_memberships_user_id_fkey'),
      ('training_plans', 'user_id', 'training_plans_user_id_fkey'),
      ('feature_usage_events', 'user_id', 'feature_usage_events_user_id_fkey'),
      ('workout_similarity_edges', 'uid', 'workout_similarity_edges_uid_fkey'),
      ('woa_bundle_uploads', 'uid', 'woa_bundle_uploads_uid_fkey'),
      ('workout_favorites', 'uid', 'workout_favorites_uid_fkey'),
      ('segment_favorites', 'uid', 'segment_favorites_uid_fkey'),
      ('user_view_preferences', 'uid', 'user_view_preferences_uid_fkey')
    ) AS dependencies(table_name, column_name, constraint_name)
  LOOP
    relation_oid := TO_REGCLASS('public.' || dependency.table_name);
    IF relation_oid IS NULL THEN
      CONTINUE;
    END IF;

    SELECT attribute.attnum
      INTO column_number
      FROM pg_attribute attribute
     WHERE attribute.attrelid = relation_oid
       AND attribute.attname = dependency.column_name
       AND NOT attribute.attisdropped;

    IF column_number IS NULL THEN
      CONTINUE;
    END IF;

    SELECT EXISTS (
      SELECT 1
        FROM pg_constraint constraint_definition
       WHERE constraint_definition.contype = 'f'
         AND constraint_definition.conrelid = relation_oid
         AND constraint_definition.confrelid = 'users'::REGCLASS
         AND constraint_definition.conkey = ARRAY[column_number]::SMALLINT[]
    ) INTO has_user_fk;

    IF has_user_fk THEN
      CONTINUE;
    END IF;

    -- Rows whose parent user no longer exists cannot satisfy the restored FK.
    EXECUTE FORMAT(
      'DELETE FROM %I child WHERE child.%I IS NOT NULL AND NOT EXISTS '
      || '(SELECT 1 FROM users parent WHERE parent.id = child.%I)',
      dependency.table_name,
      dependency.column_name,
      dependency.column_name
    );

    EXECUTE FORMAT(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) '
      || 'REFERENCES users(id) ON DELETE CASCADE',
      dependency.table_name,
      dependency.constraint_name,
      dependency.column_name
    );
  END LOOP;
END
$$;

COMMIT;
