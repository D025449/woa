BEGIN;

ALTER TABLE import_jobs
  ADD COLUMN IF NOT EXISTS local_paths jsonb,
  ADD COLUMN IF NOT EXISTS original_file_names jsonb;

COMMIT;
