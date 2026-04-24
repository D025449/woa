CREATE TABLE IF NOT EXISTS group_feed_event_groups (
    feed_event_id BIGINT NOT NULL REFERENCES group_feed_events(id) ON DELETE CASCADE,
    group_id BIGINT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (feed_event_id, group_id)
);

CREATE INDEX IF NOT EXISTS idx_group_feed_event_groups_group_id
    ON group_feed_event_groups (group_id, created_at DESC);

INSERT INTO group_feed_event_groups (feed_event_id, group_id)
SELECT gfe.id, gfe.group_id
FROM group_feed_events gfe
LEFT JOIN group_feed_event_groups gfeg
  ON gfeg.feed_event_id = gfe.id
 AND gfeg.group_id = gfe.group_id
WHERE gfeg.feed_event_id IS NULL;

WITH duplicate_events AS (
    SELECT
        actor_user_id,
        event_type,
        entity_type,
        entity_id,
        MIN(id) AS canonical_id,
        ARRAY_AGG(id ORDER BY id) AS all_ids
    FROM group_feed_events
    WHERE event_type IN ('workout_uploaded', 'segment_published')
      AND entity_id IS NOT NULL
    GROUP BY actor_user_id, event_type, entity_type, entity_id
    HAVING COUNT(*) > 1
),
duplicate_rows AS (
    SELECT
        de.canonical_id,
        unnest(de.all_ids[2:array_length(de.all_ids, 1)]) AS duplicate_id
    FROM duplicate_events de
)
INSERT INTO group_feed_event_groups (feed_event_id, group_id)
SELECT DISTINCT dr.canonical_id, gfeg.group_id
FROM duplicate_rows dr
INNER JOIN group_feed_event_groups gfeg
  ON gfeg.feed_event_id = dr.duplicate_id
ON CONFLICT (feed_event_id, group_id) DO NOTHING;

WITH duplicate_events AS (
    SELECT
        actor_user_id,
        event_type,
        entity_type,
        entity_id,
        MIN(id) AS canonical_id,
        ARRAY_AGG(id ORDER BY id) AS all_ids
    FROM group_feed_events
    WHERE event_type IN ('workout_uploaded', 'segment_published')
      AND entity_id IS NOT NULL
    GROUP BY actor_user_id, event_type, entity_type, entity_id
    HAVING COUNT(*) > 1
),
duplicate_rows AS (
    SELECT
        de.canonical_id,
        unnest(de.all_ids[2:array_length(de.all_ids, 1)]) AS duplicate_id
    FROM duplicate_events de
)
INSERT INTO group_feed_event_dismissals (feed_event_id, user_id, dismissed_at)
SELECT
    dr.canonical_id,
    gfed.user_id,
    gfed.dismissed_at
FROM duplicate_rows dr
INNER JOIN group_feed_event_dismissals gfed
  ON gfed.feed_event_id = dr.duplicate_id
ON CONFLICT (feed_event_id, user_id) DO NOTHING;

WITH duplicate_events AS (
    SELECT
        actor_user_id,
        event_type,
        entity_type,
        entity_id,
        MIN(id) AS canonical_id,
        ARRAY_AGG(id ORDER BY id) AS all_ids
    FROM group_feed_events
    WHERE event_type IN ('workout_uploaded', 'segment_published')
      AND entity_id IS NOT NULL
    GROUP BY actor_user_id, event_type, entity_type, entity_id
    HAVING COUNT(*) > 1
)
DELETE FROM group_feed_events gfe
USING duplicate_events de
WHERE gfe.id = ANY(de.all_ids[2:array_length(de.all_ids, 1)]);

CREATE UNIQUE INDEX IF NOT EXISTS uq_group_feed_events_entity_actor
    ON group_feed_events (actor_user_id, event_type, entity_type, entity_id)
    WHERE event_type IN ('workout_uploaded', 'segment_published')
      AND entity_id IS NOT NULL;
