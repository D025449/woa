CREATE TABLE IF NOT EXISTS group_invite_sender_dismissals (
    invite_id BIGINT NOT NULL REFERENCES group_invites(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    dismissed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (invite_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_group_invite_sender_dismissals_user_id
    ON group_invite_sender_dismissals (user_id, dismissed_at DESC);
