-- Active: 1776863449169@@127.0.0.1@5432@cwa24_prod
ALTER TABLE workouts
  ADD COLUMN IF NOT EXISTS gps_track_blob BYTEA;
