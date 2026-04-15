BEGIN;

CREATE INDEX IF NOT EXISTS idx_workouts_uid
ON workouts (uid);

CREATE INDEX IF NOT EXISTS idx_gps_segments_uid
ON gps_segments (uid);

CREATE INDEX IF NOT EXISTS idx_workouts_geom_geography
ON workouts
USING GIST ((geom::geography));

CREATE INDEX IF NOT EXISTS idx_gps_segments_geom_geography
ON gps_segments
USING GIST ((geom::geography));

COMMIT;
