CREATE TABLE IF NOT EXISTS group_feed_events (
    id BIGSERIAL PRIMARY KEY,
    group_id BIGINT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    actor_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event_type VARCHAR(50) NOT NULL,
    entity_type VARCHAR(50),
    entity_id BIGINT,
    payload_json JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_group_feed_events_group_created_at
    ON group_feed_events (group_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_group_feed_events_actor_created_at
    ON group_feed_events (actor_user_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_group_feed_events_workout_uploaded
    ON group_feed_events (group_id, event_type, entity_type, entity_id)
    WHERE event_type = 'workout_uploaded'
      AND entity_type = 'workout';
