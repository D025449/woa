DROP FUNCTION get_ftp_by_period2;
CREATE OR REPLACE FUNCTION get_ftp_by_period2(
  p_uid BIGINT,
  p_period_type TEXT DEFAULT 'quarter'
)
RETURNS TABLE (
  uid BIGINT,
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
      v.uid,
      (
      CASE
        WHEN p_period_type = 'year' THEN v.year
        WHEN p_period_type = 'month' THEN v.year_month
        WHEN p_period_type = 'week' THEN v.year_week
        ELSE v.year_quarter
      END ) ::INTEGER  AS period,
      v.duration,
      v.best_effort_avg_power AS power
    FROM v_workouts_with_best_efforts v
    WHERE v.uid = p_uid
      AND v.duration IN (480, 900)
      AND v.best_effort_avg_power IS NOT NULL
  ),

  aggregated AS (
    SELECT
      e.uid,
      e.period,

      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY e.power)
        FILTER (WHERE e.duration = 480) ::DOUBLE PRECISION AS cp8,

      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY e.power)
        FILTER (WHERE e.duration = 900) ::DOUBLE PRECISION AS cp15,

      COUNT(*) FILTER (WHERE e.duration = 480) AS n_cp8,
      COUNT(*) FILTER (WHERE e.duration = 900) AS n_cp15

    FROM efforts e
    GROUP BY e.uid, e.period
  )

  SELECT
    a.uid,
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