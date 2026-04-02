
BEGIN;
CREATE EXTENSION IF NOT EXISTS "pgcrypto";  -- für gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS postgis;

 -- DROP TABLE IF EXISTS import_jobs CASCADE;
CREATE TABLE IF NOT EXISTS import_jobs (
  id uuid PRIMARY KEY,
  s3_key text NOT NULL,
  original_file_name text NOT NULL,
  size_bytes bigint NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
  stage text NOT NULL CHECK (
    stage IN (
      'waiting_for_worker',
      'downloading_zip',
      'reading_zip',
      'parsing_fit_files',
      'saving_results',
      'completed',
      'failed'
    )
  ),
  auth_sub varchar(255) NOT NULL,
  progress_percent numeric(5,2) NOT NULL DEFAULT 0,
  total_files integer,
  processed_files integer NOT NULL DEFAULT 0,
  failed_files integer NOT NULL DEFAULT 0,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMIT;

-- users ---

BEGIN;


-- 2️⃣ Alte Tabelle entfernen (ACHTUNG: CASCADE löscht abhängige Tabellen!)
-- DROP TABLE IF EXISTS users CASCADE;

-- 3️⃣ Neue Users-Tabelle
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Auth0 / Cognito / OIDC Sub
    auth_sub VARCHAR(255) NOT NULL UNIQUE,

    email VARCHAR(255) NOT NULL UNIQUE,
    email_verified BOOLEAN DEFAULT FALSE,

    display_name VARCHAR(100),

    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4️⃣ Optionaler Index für schnellere Suche per Email
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- 5️⃣ Updated_at automatisch pflegen
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trigger_set_updated_at
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

COMMIT;



-- files ----

BEGIN;


DROP TABLE IF EXISTS files CASCADE;

CREATE TABLE files (
    id               UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
    auth_sub         VARCHAR(255)   NOT NULL,
    original_filename TEXT          NOT NULL,
    s3_key           TEXT           NOT NULL,
    mime_type        TEXT           NOT NULL,
    file_size        INTEGER        NOT NULL,
    uploaded_at      TIMESTAMP      NOT NULL DEFAULT NOW(),

    start_time          TIMESTAMPTZ,
    end_time            TIMESTAMPTZ,

    year                INTEGER,
    month               INTEGER,
    week                INTEGER,
    year_quarter        INTEGER,
    year_month          INTEGER,
    year_week           INTEGER,

    total_elapsed_time   DOUBLE PRECISION,
    total_timer_time     DOUBLE PRECISION,

    total_distance       DOUBLE PRECISION,
    total_cycles         INTEGER,
    total_work           DOUBLE PRECISION,
    total_calories       DOUBLE PRECISION,
    total_ascent         DOUBLE PRECISION,
    total_descent        DOUBLE PRECISION,

    avg_speed            DOUBLE PRECISION,
    max_speed            DOUBLE PRECISION,
    avg_normalized_power DOUBLE PRECISION,

    avg_power            DOUBLE PRECISION,
    max_power            DOUBLE PRECISION,

    avg_heart_rate       DOUBLE PRECISION,
    max_heart_rate       DOUBLE PRECISION,

    avg_cadence          DOUBLE PRECISION,
    max_cadence          DOUBLE PRECISION,

    minLat               DOUBLE PRECISION,
    maxLat               DOUBLE PRECISION,
    minLng               DOUBLE PRECISION,
    maxLng               DOUBLE PRECISION,
    validGPS             BOOLEAN,

    CONSTRAINT uq_user_start_time UNIQUE (auth_sub, start_time),
    CONSTRAINT fk_user FOREIGN KEY (auth_sub)
        REFERENCES users(auth_sub)
        ON DELETE CASCADE
);
COMMIT;

--------------------
-- file segemts ---
--------------------
BEGIN;

DROP VIEW IF EXISTS v_files_with_best_efforts;
DROP TABLE IF EXISTS file_segments;
CREATE TABLE file_segments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    file_id         UUID NOT NULL,
    auth_sub        VARCHAR(255) NOT NULL,
    segmenttype     VARCHAR(10) DEFAULT 'manual',
    segmentname     VARCHAR(100),
    start_offset    INTEGER NOT NULL,
    end_offset      INTEGER NOT NULL,
    duration        INTEGER NOT NULL,
    avg_power       DOUBLE PRECISION NOT NULL,
    avg_heart_rate  DOUBLE PRECISION,
    avg_cadence     DOUBLE PRECISION,
    avg_speed       DOUBLE PRECISION,    
    altimeters      DOUBLE PRECISION,
    position        INTEGER,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_segmenttype
        CHECK (segmenttype IN ('manual', 'auto', 'crit')),

    CONSTRAINT ck_file_best_efforts_offset
        CHECK (start_offset >= 0),

    CONSTRAINT ck_file_best_efforts_duration
        CHECK (duration > 0),

    CONSTRAINT ck_file_best_efforts_end_offset
        CHECK (end_offset >= start_offset),


    CONSTRAINT uq_file_best_effort_start_offet_duration
        UNIQUE (file_id, segmenttype, start_offset, duration),


    CONSTRAINT fk_file
        FOREIGN KEY (file_id)
        REFERENCES files(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_user
        FOREIGN KEY (auth_sub)
        REFERENCES users(auth_sub)
        ON DELETE CASCADE
);
--------------------------------
-- v_files_with_best_efforts --
--------------------------------

CREATE VIEW v_files_with_best_efforts AS
SELECT
    f.id,
    f.auth_sub,
    f.original_filename,
    f.s3_key,
    f.mime_type,
    f.file_size,
    f.uploaded_at,

    f.start_time,
    f.end_time,

    f.year,
    f.month,
    f.week,
    f.year_quarter,
    f.year_month,
    f.year_week,

    f.total_elapsed_time,
    f.total_timer_time,

    f.total_distance,
    f.total_cycles,
    f.total_work,
    f.total_calories,
    f.total_ascent,
    f.total_descent,

    f.avg_speed,
    f.max_speed,
    f.avg_normalized_power,

    f.avg_power,
    f.max_power,

    f.avg_heart_rate,
    f.max_heart_rate,

    f.avg_cadence,
    f.max_cadence,

    f.minLat,
    f.maxLat,
    f.minLng,
    f.maxLng,
    f.validGPS,
    
    b.id AS best_effort_id,
    b.file_id AS best_effort_file_id,
    b.start_offset,
    b.duration,
    b.end_offset,
    b.avg_power AS best_effort_avg_power,
    b.avg_heart_rate AS best_effort_avg_heart_rate,
    b.avg_cadence AS best_effort_avg_cadence,
    b.avg_speed AS best_effort_avg_speed,
    b.created_at AS best_effort_created_at

FROM files f
INNER JOIN file_segments b
    ON b.file_id = f.id
where b.segmenttype = 'crit';
END;

-- function get_ftp_by_period2 ---
CREATE OR REPLACE FUNCTION get_ftp_by_period2(
  p_auth_sub TEXT,
  p_period_type TEXT DEFAULT 'quarter'
)
RETURNS TABLE (
  auth_sub VARCHAR,
  period INTEGER,
  cp8 DOUBLE PRECISION,
  cp15 DOUBLE PRECISION,
  ftp DOUBLE PRECISION,
  confidence INTEGER
)
AS $$
BEGIN
  RETURN QUERY
  WITH efforts AS (
    SELECT
      v.auth_sub,
      (
      CASE
        WHEN p_period_type = 'year' THEN v.year
        WHEN p_period_type = 'month' THEN v.year_month
        WHEN p_period_type = 'week' THEN v.year_week
        ELSE v.year_quarter
      END ) ::INTEGER  AS period,
      v.duration,
      v.best_effort_avg_power AS power
    FROM v_files_with_best_efforts v
    WHERE v.auth_sub = p_auth_sub
      AND v.duration IN (480, 900)
      AND v.best_effort_avg_power IS NOT NULL
  ),

  aggregated AS (
    SELECT
      e.auth_sub,
      e.period,

      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY e.power)
        FILTER (WHERE e.duration = 480) ::DOUBLE PRECISION AS cp8,

      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY e.power)
        FILTER (WHERE e.duration = 900) ::DOUBLE PRECISION AS cp15,

      COUNT(*) FILTER (WHERE e.duration = 480) AS n_cp8,
      COUNT(*) FILTER (WHERE e.duration = 900) AS n_cp15

    FROM efforts e
    GROUP BY e.auth_sub, e.period
  )

  SELECT
    a.auth_sub,
    a.period,
    a.cp8,
    a.cp15,

    (
      a.cp8 +
      (
        (LN(1200) - LN(480)) / (LN(900) - LN(480))
      ) * (a.cp15 - a.cp8)
    ) * 0.95 ::DOUBLE PRECISION AS ftp,

    LEAST(a.n_cp8, a.n_cp15) ::INTEGER AS confidence

  FROM aggregated a
  ORDER BY a.period;

END;
$$ LANGUAGE plpgsql;


----------------------------
-- get_cp_best_efforts ----
----------------------------
CREATE OR REPLACE FUNCTION get_cp_best_efforts(
    p_grouping TEXT,
    p_durations INT[],
    p_auth_sub TEXT
)
RETURNS TABLE (
    grp TEXT,
    duration INT,
    best_effort_avg_power DOUBLE PRECISION,
    best_effort_avg_heart_rate DOUBLE PRECISION,
    best_effort_avg_cadence DOUBLE PRECISION,
    best_effort_avg_speed DOUBLE PRECISION,
    best_effort_file_id UUID,
    start_offset INT,
    end_offset INT,
    start_time TIMESTAMPTZ
)
AS $$
BEGIN
    IF p_grouping NOT IN ('year', 'year_quarter', 'year_month', 'year_week') THEN
        RAISE EXCEPTION 'Invalid grouping: %', p_grouping;
    END IF;

    RETURN QUERY EXECUTE format(
        $f$
        WITH ranked AS (
            SELECT
                (%I)::text AS grp,   -- 🔥 FIX
                duration,
                best_effort_file_id,
                start_time,
                start_offset,
                end_offset,
                best_effort_avg_power,
                best_effort_avg_heart_rate,
                best_effort_avg_cadence,
                best_effort_avg_speed,
                ROW_NUMBER() OVER (
                    PARTITION BY %I, duration
                    ORDER BY best_effort_avg_power DESC
                ) AS rn
            FROM v_files_with_best_efforts
            WHERE duration = ANY($1)
              AND auth_sub = $2
        )
        SELECT
            grp,
            duration,
            best_effort_avg_power,
            best_effort_avg_heart_rate,
            best_effort_avg_cadence,
            best_effort_avg_speed,
            best_effort_file_id,
            start_offset,
            end_offset,
            start_time
        FROM ranked
        WHERE rn = 1
        ORDER BY grp, duration
        $f$,
        p_grouping, p_grouping
    )
    USING p_durations, p_auth_sub;
END;
$$ LANGUAGE plpgsql;


ALTER TABLE files
ADD COLUMN IF NOT EXISTS bounds geometry(POLYGON, 4326);
CREATE INDEX IF NOT EXISTS idx_files_bounds
ON files
USING GIST (bounds);

ALTER TABLE file_segments
ADD COLUMN IF NOT EXISTS bounds geometry(POLYGON, 4326);
CREATE INDEX IF NOT EXISTS idx_file_segments_bounds
ON file_segments
USING GIST (bounds);
