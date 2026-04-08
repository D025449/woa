DROP FUNCTION IF EXISTS get_cp_best_efforts;

CREATE OR REPLACE FUNCTION get_cp_best_efforts(
    p_grouping TEXT,
    p_durations INT[],
    p_uid BIGINT
)
RETURNS TABLE (
    grp TEXT,
    duration INT,
    best_effort_avg_power DOUBLE PRECISION,
    best_effort_avg_heart_rate DOUBLE PRECISION,
    best_effort_avg_cadence DOUBLE PRECISION,
    best_effort_avg_speed DOUBLE PRECISION,
    best_effort_file_id BIGINT,
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
            FROM v_workouts_with_best_efforts
            WHERE duration = ANY($1)
              AND uid = $2
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
    USING p_durations, p_uid;
END;
$$ LANGUAGE plpgsql;