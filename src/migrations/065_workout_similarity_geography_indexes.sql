DROP INDEX IF EXISTS idx_workouts_track_start;
DROP INDEX IF EXISTS idx_workouts_track_end;

CREATE INDEX IF NOT EXISTS idx_workouts_track_start_geography
ON workouts
USING GIST ((track_start::geography));
