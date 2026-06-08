-- Active: 1776863449169@@127.0.0.1@5432@cwa24_prod
BEGIN;

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS show_sudoku BOOLEAN;

UPDATE user_profiles
SET show_sudoku = COALESCE(show_sudoku, FALSE)
WHERE show_sudoku IS NULL;

ALTER TABLE user_profiles
  ALTER COLUMN show_sudoku SET DEFAULT FALSE;

COMMIT;
