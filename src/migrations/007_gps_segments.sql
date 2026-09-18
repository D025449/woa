DROP TABLE IF EXISTS gps_segments cascade;

CREATE TABLE gps_segments (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    uid               BIGINT   NOT NULL,
  -- Meta
  distance DOUBLE PRECISION,
  duration DOUBLE PRECISION,

  -- Startpunkt
  start_lat DOUBLE PRECISION,
  start_lng DOUBLE PRECISION,
  start_name VARCHAR(100),

  -- Endpunkt
  end_lat DOUBLE PRECISION,
  end_lng DOUBLE PRECISION,
  end_name VARCHAR(100),

  gps_bounds box,
  track_blob BYTEA NOT NULL,
  track_blob_codec TEXT NOT NULL,

  altitudes JSONB,
  start_altitude DOUBLE PRECISION,
  end_altitude DOUBLE PRECISION,
  ascent DOUBLE PRECISION,

  workout_altitudes JSONB,
  workout_start_altitude DOUBLE PRECISION,
  workout_end_altitude DOUBLE PRECISION,
  workout_ascent DOUBLE PRECISION,
  workout_altitude_status TEXT NOT NULL DEFAULT 'unavailable',
  workout_altitude_source_wid BIGINT,
  workout_altitude_candidate_count INTEGER NOT NULL DEFAULT 0,
  workout_altitude_cluster_count INTEGER NOT NULL DEFAULT 0,
  workout_altitude_dispersion DOUBLE PRECISION,
  workout_altitude_algorithm_version SMALLINT,
  workout_altitude_updated_at TIMESTAMP WITH TIME ZONE,

  points_count INTEGER,
  best_efforts_status TEXT NOT NULL DEFAULT 'completed',
  best_efforts_error TEXT,

  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  CONSTRAINT altitudes_is_array
    CHECK (jsonb_typeof(altitudes) = 'array'),
  CONSTRAINT gps_segments_workout_altitude_status_check
    CHECK (
      workout_altitude_status IN ('unavailable', 'candidate', 'confirmed', 'stale')
    ),
  CONSTRAINT gps_segments_workout_altitudes_check
    CHECK (
      workout_altitudes IS NULL
      OR CASE
        WHEN jsonb_typeof(workout_altitudes) = 'array'
          THEN points_count IS NOT NULL
            AND jsonb_array_length(workout_altitudes) = points_count
        ELSE FALSE
      END
    ),
  CONSTRAINT gps_segments_workout_altitude_counts_check
    CHECK (
      workout_altitude_candidate_count >= 0
      AND workout_altitude_cluster_count >= 0
      AND workout_altitude_cluster_count <= workout_altitude_candidate_count
    ),
  CONSTRAINT gps_segments_workout_altitude_metrics_check
    CHECK (
      (workout_ascent IS NULL OR workout_ascent >= 0)
      AND (workout_altitude_dispersion IS NULL OR workout_altitude_dispersion >= 0)
      AND (
        workout_altitude_algorithm_version IS NULL
        OR workout_altitude_algorithm_version > 0
      )
    ),
  CONSTRAINT gps_segments_confirmed_workout_altitude_check
    CHECK (
      workout_altitude_status <> 'confirmed'
      OR (
        workout_altitudes IS NOT NULL
        AND workout_start_altitude IS NOT NULL
        AND workout_end_altitude IS NOT NULL
        AND workout_ascent IS NOT NULL
        AND workout_altitude_cluster_count > 0
        AND workout_altitude_algorithm_version IS NOT NULL
        AND workout_altitude_updated_at IS NOT NULL
      )
    ),
  CONSTRAINT gps_segments_track_blob_codec_check
    CHECK (track_blob_codec IN ('identity', 'brotli', 'gzip')),
  CONSTRAINT fk_user
    FOREIGN KEY (uid)
    REFERENCES users(id)
    ON DELETE CASCADE,
  CONSTRAINT gps_segments_workout_altitude_source_fk
    FOREIGN KEY (workout_altitude_source_wid)
    REFERENCES workouts(id)
    ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_gps_segments_bounds
ON gps_segments
USING GIST (gps_bounds);

CREATE INDEX IF NOT EXISTS idx_gps_segments_uid
ON gps_segments (uid);

COMMENT ON COLUMN gps_segments.altitudes IS
  'Elevation profile obtained from the external elevation lookup.';

COMMENT ON COLUMN gps_segments.workout_altitudes IS
  'Distance-aligned elevation profile derived from recorded workout matches.';

COMMENT ON COLUMN gps_segments.workout_altitude_status IS
  'Lifecycle state of the workout-derived profile: unavailable, candidate, confirmed, or stale.';

COMMENT ON COLUMN gps_segments.workout_altitude_source_wid IS
  'Workout selected as the medoid for the stored workout-derived elevation profile.';

COMMENT ON COLUMN gps_segments.workout_altitude_candidate_count IS
  'Number of valid workout profiles considered by the profile calculation.';

COMMENT ON COLUMN gps_segments.workout_altitude_cluster_count IS
  'Number of workout profiles supporting the selected dominant cluster.';

COMMENT ON COLUMN gps_segments.workout_altitude_dispersion IS
  'Robust profile dispersion within the selected cluster, in meters.';

COMMENT ON COLUMN gps_segments.workout_altitude_algorithm_version IS
  'Version of the algorithm that produced the stored workout-derived profile.';
