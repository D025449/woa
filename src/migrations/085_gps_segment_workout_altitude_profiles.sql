-- Active: 1776863449169@@127.0.0.1@5432@cwa24_prod_restore_20260805_144216@public
BEGIN;

ALTER TABLE gps_segments
  ADD COLUMN IF NOT EXISTS workout_altitudes JSONB,
  ADD COLUMN IF NOT EXISTS workout_start_altitude DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS workout_end_altitude DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS workout_ascent DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS workout_altitude_status TEXT NOT NULL DEFAULT 'unavailable',
  ADD COLUMN IF NOT EXISTS workout_altitude_source_wid BIGINT,
  ADD COLUMN IF NOT EXISTS workout_altitude_candidate_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS workout_altitude_cluster_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS workout_altitude_dispersion DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS workout_altitude_algorithm_version SMALLINT,
  ADD COLUMN IF NOT EXISTS workout_altitude_updated_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'gps_segments_workout_altitude_status_check'
      AND conrelid = 'gps_segments'::regclass
  ) THEN
    ALTER TABLE gps_segments
      ADD CONSTRAINT gps_segments_workout_altitude_status_check
      CHECK (
        workout_altitude_status IN ('unavailable', 'candidate', 'confirmed', 'stale')
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'gps_segments_workout_altitudes_check'
      AND conrelid = 'gps_segments'::regclass
  ) THEN
    ALTER TABLE gps_segments
      ADD CONSTRAINT gps_segments_workout_altitudes_check
      CHECK (
        workout_altitudes IS NULL
        OR CASE
          WHEN jsonb_typeof(workout_altitudes) = 'array'
            THEN points_count IS NOT NULL
              AND jsonb_array_length(workout_altitudes) = points_count
          ELSE FALSE
        END
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'gps_segments_workout_altitude_counts_check'
      AND conrelid = 'gps_segments'::regclass
  ) THEN
    ALTER TABLE gps_segments
      ADD CONSTRAINT gps_segments_workout_altitude_counts_check
      CHECK (
        workout_altitude_candidate_count >= 0
        AND workout_altitude_cluster_count >= 0
        AND workout_altitude_cluster_count <= workout_altitude_candidate_count
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'gps_segments_workout_altitude_metrics_check'
      AND conrelid = 'gps_segments'::regclass
  ) THEN
    ALTER TABLE gps_segments
      ADD CONSTRAINT gps_segments_workout_altitude_metrics_check
      CHECK (
        (workout_ascent IS NULL OR workout_ascent >= 0)
        AND (workout_altitude_dispersion IS NULL OR workout_altitude_dispersion >= 0)
        AND (
          workout_altitude_algorithm_version IS NULL
          OR workout_altitude_algorithm_version > 0
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'gps_segments_confirmed_workout_altitude_check'
      AND conrelid = 'gps_segments'::regclass
  ) THEN
    ALTER TABLE gps_segments
      ADD CONSTRAINT gps_segments_confirmed_workout_altitude_check
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
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'gps_segments_workout_altitude_source_fk'
      AND conrelid = 'gps_segments'::regclass
  ) THEN
    ALTER TABLE gps_segments
      ADD CONSTRAINT gps_segments_workout_altitude_source_fk
      FOREIGN KEY (workout_altitude_source_wid)
      REFERENCES workouts(id)
      ON DELETE SET NULL;
  END IF;
END
$$;

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

COMMIT;
