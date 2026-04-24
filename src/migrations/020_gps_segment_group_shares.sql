CREATE TABLE IF NOT EXISTS gps_segment_group_shares (
    segment_id BIGINT NOT NULL REFERENCES gps_segments(id) ON DELETE CASCADE,
    group_id BIGINT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    shared_by_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (segment_id, group_id)
);

CREATE INDEX IF NOT EXISTS idx_gps_segment_group_shares_group_id
    ON gps_segment_group_shares (group_id);

CREATE INDEX IF NOT EXISTS idx_gps_segment_group_shares_shared_by_user_id
    ON gps_segment_group_shares (shared_by_user_id);
