BEGIN;

CREATE TABLE groups (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    description TEXT,
    owner_user_id BIGINT NOT NULL,
    visibility VARCHAR(20) NOT NULL DEFAULT 'private',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    CONSTRAINT groups_visibility_check
        CHECK (visibility IN ('private', 'discoverable')),
    CONSTRAINT groups_owner_user_fk
        FOREIGN KEY (owner_user_id)
        REFERENCES users(id)
        ON DELETE CASCADE
);

CREATE TRIGGER trigger_groups_set_updated_at
BEFORE UPDATE ON groups
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_groups_owner_user_id
ON groups (owner_user_id);


CREATE TABLE group_members (
    group_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'member',
    joined_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    CONSTRAINT group_members_pk
        PRIMARY KEY (group_id, user_id),
    CONSTRAINT group_members_role_check
        CHECK (role IN ('owner', 'admin', 'member')),
    CONSTRAINT group_members_group_fk
        FOREIGN KEY (group_id)
        REFERENCES groups(id)
        ON DELETE CASCADE,
    CONSTRAINT group_members_user_fk
        FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE CASCADE
);

CREATE INDEX idx_group_members_user_id
ON group_members (user_id);


CREATE TABLE group_invites (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    group_id BIGINT NOT NULL,
    invited_user_id BIGINT NOT NULL,
    invited_by_user_id BIGINT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    message TEXT,
    expires_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    responded_at TIMESTAMP WITH TIME ZONE,
    CONSTRAINT group_invites_status_check
        CHECK (status IN ('pending', 'accepted', 'declined', 'revoked', 'expired')),
    CONSTRAINT group_invites_group_fk
        FOREIGN KEY (group_id)
        REFERENCES groups(id)
        ON DELETE CASCADE,
    CONSTRAINT group_invites_invited_user_fk
        FOREIGN KEY (invited_user_id)
        REFERENCES users(id)
        ON DELETE CASCADE,
    CONSTRAINT group_invites_invited_by_user_fk
        FOREIGN KEY (invited_by_user_id)
        REFERENCES users(id)
        ON DELETE CASCADE
);

CREATE INDEX idx_group_invites_invited_user_status
ON group_invites (invited_user_id, status);

CREATE UNIQUE INDEX uq_group_invites_pending
ON group_invites (group_id, invited_user_id)
WHERE status = 'pending';

COMMIT;
