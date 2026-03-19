BEGIN;


DROP TABLE IF EXISTS import_jobs CASCADE;
CREATE TABLE import_jobs (
  id uuid PRIMARY KEY,
  s3_key text NOT NULL,
  original_file_name text NOT NULL,
  size_bytes bigint NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
  stage text NOT NULL CHECK (
    stage IN (
      'waiting_for_worker',
      'downloading_zip',
      'reading_zip',
      'parsing_fit_files',
      'saving_results',
      'completed',
      'failed'
    )
  ),
  auth_sub varchar(255) NOT NULL,
  progress_percent numeric(5,2) NOT NULL DEFAULT 0,
  total_files integer,
  processed_files integer NOT NULL DEFAULT 0,
  failed_files integer NOT NULL DEFAULT 0,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMIT;