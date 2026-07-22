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
  points_count INTEGER,
  best_efforts_status TEXT NOT NULL DEFAULT 'completed',
  best_efforts_error TEXT,

  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  CONSTRAINT altitudes_is_array
    CHECK (jsonb_typeof(altitudes) = 'array'),
  CONSTRAINT gps_segments_track_blob_codec_check
    CHECK (track_blob_codec IN ('identity', 'brotli', 'gzip')),
  CONSTRAINT fk_user FOREIGN KEY (uid)
        REFERENCES users(id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_gps_segments_bounds
ON gps_segments
USING GIST (gps_bounds);

CREATE INDEX IF NOT EXISTS idx_gps_segments_uid
ON gps_segments (uid);
