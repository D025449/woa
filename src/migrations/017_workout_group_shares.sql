-- Active: 1776863449169@@127.0.0.1@5432@cwa24_prod
CREATE TABLE IF NOT EXISTS workout_group_shares (
    workout_id BIGINT NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
    group_id BIGINT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    shared_by_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (workout_id, group_id)
);

CREATE INDEX IF NOT EXISTS idx_workout_group_shares_group_id
    ON workout_group_shares (group_id);

CREATE INDEX IF NOT EXISTS idx_workout_group_shares_shared_by_user_id
    ON workout_group_shares (shared_by_user_id);


    CREATE INDEX IF NOT EXISTS idx_workout_group_shares_wid
    ON workout_group_shares (workout_id);
