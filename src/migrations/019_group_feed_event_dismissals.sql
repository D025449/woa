CREATE TABLE IF NOT EXISTS group_feed_event_dismissals (
    feed_event_id BIGINT NOT NULL REFERENCES group_feed_events(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    dismissed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (feed_event_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_group_feed_event_dismissals_user_id
    ON group_feed_event_dismissals (user_id, dismissed_at DESC);
