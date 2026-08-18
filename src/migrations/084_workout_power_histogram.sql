-- Active: 1776863449169@@127.0.0.1@5432@cwa24_prod_restore_20260805_144216
BEGIN;

ALTER TABLE workouts
  ADD COLUMN IF NOT EXISTS power_histogram BYTEA;

COMMENT ON COLUMN workouts.power_histogram IS
  'Sparse, FTP-independent PHD1 power-duration histogram generated during workout import.';

COMMIT;
