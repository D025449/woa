BEGIN;

DELETE FROM gps_segment_group_shares child
WHERE NOT EXISTS (
  SELECT 1
  FROM gps_segments parent
  WHERE parent.id = child.segment_id
);

DELETE FROM segment_favorites child
WHERE NOT EXISTS (
  SELECT 1
  FROM gps_segments parent
  WHERE parent.id = child.segment_id
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint constraint_definition
    WHERE constraint_definition.contype = 'f'
      AND constraint_definition.conrelid = 'gps_segment_group_shares'::REGCLASS
      AND constraint_definition.confrelid = 'gps_segments'::REGCLASS
      AND PG_GET_CONSTRAINTDEF(constraint_definition.oid)
        LIKE 'FOREIGN KEY (segment_id)%'
  ) THEN
    ALTER TABLE gps_segment_group_shares
      ADD CONSTRAINT gps_segment_group_shares_segment_id_fkey
      FOREIGN KEY (segment_id)
      REFERENCES gps_segments(id)
      ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint constraint_definition
    WHERE constraint_definition.contype = 'f'
      AND constraint_definition.conrelid = 'segment_favorites'::REGCLASS
      AND constraint_definition.confrelid = 'gps_segments'::REGCLASS
      AND PG_GET_CONSTRAINTDEF(constraint_definition.oid)
        LIKE 'FOREIGN KEY (segment_id)%'
  ) THEN
    ALTER TABLE segment_favorites
      ADD CONSTRAINT segment_favorites_segment_id_fkey
      FOREIGN KEY (segment_id)
      REFERENCES gps_segments(id)
      ON DELETE CASCADE;
  END IF;
END
$$;

COMMIT;
