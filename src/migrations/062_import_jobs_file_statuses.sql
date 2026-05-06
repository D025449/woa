-- Active: 1776863449169@@127.0.0.1@5432@cwa24_prod
BEGIN;

ALTER TABLE import_jobs
ADD COLUMN IF NOT EXISTS file_statuses jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMIT;
