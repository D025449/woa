DROP TABLE IF EXISTS workout_streams cascade;
CREATE TABLE workout_streams (
  wid BIGINT NOT NULL,
  idx INT NOT NULL, -- Sekundenindex

  -- Raw Werte
  power SMALLINT,
  hr SMALLINT,
  cadence SMALLINT,
  speed SMALLINT,      -- km/h * 10
  altitude SMALLINT,   -- Meter

  -- Prefix sums
  cum_power BIGINT,
  cum_hr BIGINT,
  cum_cadence BIGINT,
  cum_speed BIGINT,

  -- Optional (empfohlen)
  cum_elevation_gain BIGINT,

  PRIMARY KEY (wid, idx),

  FOREIGN KEY (wid)
    REFERENCES workouts(id)
    ON DELETE CASCADE
);