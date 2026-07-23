-- Active: 1776863449169@@127.0.0.1@5432@cwa24_prod
BEGIN;

-- PostgreSQL does not create indexes for referencing foreign-key columns.
-- This index avoids repeated table scans during cascaded workout deletes.
CREATE INDEX IF NOT EXISTS idx_gps_segment_best_efforts_wid
  ON gps_segment_best_efforts (wid);

COMMIT;
