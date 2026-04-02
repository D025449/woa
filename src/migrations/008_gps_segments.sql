DROP TABLE IF EXISTS gps_segments;

CREATE TABLE gps_segments (
  id UUID PRIMARY KEY,

  auth_sub TEXT NOT NULL,

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

  -- PostGIS Bounding Box
  bounds geometry(POLYGON, 4326),
  geom geometry(LINESTRING, 4326) NOT NULL,

  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS INDEX idx_gps_segments_bounds
ON gps_segments
USING GIST (bounds);

CREATE INDEX IF NOT EXISTS idx_gps_segments_geom
ON gps_segments
USING GIST (geom);