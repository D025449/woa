-- Active: 1776863449169@@127.0.0.1@5432@cwa24_prod
BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS account_status VARCHAR(32) NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS deletion_requested_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS deletion_scheduled_for TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'users_account_status_check'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_account_status_check
      CHECK (account_status IN ('active', 'pending_deletion', 'deleted'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_users_account_status
  ON users(account_status);

CREATE INDEX IF NOT EXISTS idx_users_deletion_scheduled_for
  ON users(deletion_scheduled_for)
  WHERE account_status = 'pending_deletion';

COMMIT;
