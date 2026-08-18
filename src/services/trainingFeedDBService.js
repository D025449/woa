import pool from "./database.js";
import { FileDBService } from "./fileDBService.js";

const FEED_COLUMNS = [
  ...FileDBService.allowedColumns,
  "activity_type",
  "estimated_tss"
];
const FEED_NUMERIC_COLUMNS = [
  ...FileDBService.numericFields,
  "estimated_tss"
];

function shiftParameters(sql, offset) {
  return String(sql || "").replace(/\$(\d+)/gu, (_, index) => `$${Number(index) + offset}`);
}

function normalizeFeedOrder(orderSQL) {
  return String(orderSQL || "ORDER BY id ASC").replace(
    /\b(total_distance|total_calories|total_work|avg_power|avg_normalized_power)\s+(ASC|DESC)(?!\s+NULLS\s+(?:FIRST|LAST))/giu,
    "$1 $2 NULLS LAST"
  );
}

function resolveProfilePower(mode, value, ftp) {
  if (value === null || value === undefined || value === "") return null;
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return null;
  if (mode !== "ftp_percent") return numericValue;
  const numericFtp = Number(ftp);
  return Number.isFinite(numericFtp) && numericFtp > 0
    ? numericFtp * numericValue / 100
    : null;
}

async function loadManualCyclingPowerProfiles(uid, rows, db) {
  const activityIds = [...new Set(rows
    .filter((row) => row.entity_type === "manual_activity" && row.activity_type === "cycling")
    .map((row) => String(row.id)))];
  if (activityIds.length === 0) return new Map();

  const result = await db.query(`
    SELECT
      activity.id AS activity_id,
      activity.duration_seconds,
      activity.baseline_power_mode,
      activity.baseline_power_value,
      activity.ftp_used,
      activity_interval.sequence_no,
      activity_interval.repetitions,
      activity_interval.work_duration_seconds,
      activity_interval.recovery_duration_seconds,
      activity_interval.power_mode,
      activity_interval.work_power_value,
      activity_interval.recovery_power_value
    FROM training_activities activity
    LEFT JOIN training_activity_intervals activity_interval
      ON activity_interval.training_activity_id = activity.id
    WHERE activity.uid = $1
      AND activity.activity_type = 'cycling'
      AND activity.id = ANY($2::bigint[])
    ORDER BY activity.id, activity_interval.sequence_no
  `, [uid, activityIds]);

  const profiles = new Map();
  for (const row of result.rows || []) {
    const key = String(row.activity_id);
    if (!profiles.has(key)) {
      const baselinePower = resolveProfilePower(
        row.baseline_power_mode,
        row.baseline_power_value,
        row.ftp_used
      );
      if (!Number.isFinite(baselinePower)) continue;
      profiles.set(key, {
        duration_seconds: Number(row.duration_seconds),
        baseline_power: Math.round(baselinePower),
        intervals: []
      });
    }

    const profile = profiles.get(key);
    if (!profile || row.sequence_no == null) continue;
    const workPower = resolveProfilePower(row.power_mode, row.work_power_value, row.ftp_used);
    const recoveryPower = row.recovery_power_value == null
      ? profile.baseline_power
      : resolveProfilePower(row.power_mode, row.recovery_power_value, row.ftp_used);
    if (!Number.isFinite(workPower) || !Number.isFinite(recoveryPower)) continue;
    profile.intervals.push({
      sequence_no: Number(row.sequence_no),
      repetitions: Number(row.repetitions),
      work_duration_seconds: Number(row.work_duration_seconds),
      recovery_duration_seconds: Number(row.recovery_duration_seconds),
      work_power: Math.round(workPower),
      recovery_power: Math.round(recoveryPower)
    });
  }

  return profiles;
}

function workoutAccessPredicate(scope) {
  if (scope === "shared") {
    return `workouts.uid <> $1
      AND EXISTS (
        SELECT 1
        FROM workout_group_shares wgs
        INNER JOIN group_members gm ON gm.group_id = wgs.group_id
        WHERE wgs.workout_id = workouts.id AND gm.user_id = $1
      )`;
  }
  if (scope === "all") {
    return `(workouts.uid = $1 OR EXISTS (
      SELECT 1
      FROM workout_group_shares wgs
      INNER JOIN group_members gm ON gm.group_id = wgs.group_id
      WHERE wgs.workout_id = workouts.id AND gm.user_id = $1
    ))`;
  }
  return "workouts.uid = $1";
}

function workoutProjection() {
  return `
    SELECT
      'workout'::text AS entity_type,
      workouts.id AS entity_id,
      workouts.id,
      workouts.uid,
      workouts.uploaded_at,
      workouts.start_time,
      workouts.end_time,
      workouts.year,
      workouts.month,
      workouts.week,
      workouts.year_quarter,
      workouts.year_month,
      workouts.year_week,
      workouts.total_elapsed_time,
      workouts.total_timer_time,
      workouts.total_distance,
      workouts.total_cycles,
      workouts.total_work,
      workouts.total_calories,
      workouts.total_ascent,
      workouts.total_descent,
      workouts.avg_speed,
      workouts.max_speed,
      workouts.avg_normalized_power,
      workouts.avg_power,
      workouts.max_power,
      workouts.avg_heart_rate,
      workouts.max_heart_rate,
      workouts.avg_cadence,
      workouts.max_cadence,
      workouts.validgps,
      workouts.workout_type,
      CASE WHEN workouts.workout_type = 'motorsport' THEN 'other' ELSE 'cycling' END::text AS activity_type,
      workouts.terrain_profile,
      workouts.intensity_profile,
      workouts.intensity_tags,
      workouts.intensity_structure,
      workouts.intensity_dose,
      workouts.intensity_classifier_version,
      workouts.perceived_exertion,
      NULL::double precision AS estimated_tss,
      NULL::text AS tss_source,
      NULL::text AS strength_focus,
      NULL::text AS title,
      NULL::text AS notes,
      workouts.segment_processing_status,
      workouts.segment_processing_error,
      workouts.segment_processing_updated_at,
      owner.display_name AS owner_display_name,
      owner.email AS owner_email,
      (workouts.uid = $1)::boolean AS is_owned,
      EXISTS (
        SELECT 1 FROM workout_favorites wf
        WHERE wf.uid = $1 AND wf.workout_id = workouts.id
      ) AS is_favorite,
      CASE
        WHEN ${FileDBService.thumbnailsOnDemand ? "TRUE" : "FALSE"} THEN TRUE
        ELSE EXISTS (SELECT 1 FROM workout_thumbnails wt WHERE wt.workout_id = workouts.id)
      END AS has_thumbnail,
      (SELECT wt.updated_at FROM workout_thumbnails wt WHERE wt.workout_id = workouts.id) AS thumbnail_updated_at,
      (SELECT COUNT(*) FROM workout_group_shares wgs WHERE wgs.workout_id = workouts.id)::int AS share_group_count
    FROM workouts
    INNER JOIN users owner ON owner.id = workouts.uid`;
}

function manualProjection() {
  return `
    SELECT
      'manual_activity'::text AS entity_type,
      activity.id AS entity_id,
      activity.id,
      activity.uid,
      activity.created_at AS uploaded_at,
      activity.start_time,
      activity.start_time + activity.duration_seconds * INTERVAL '1 second' AS end_time,
      EXTRACT(YEAR FROM activity.start_time)::int AS year,
      EXTRACT(MONTH FROM activity.start_time)::int AS month,
      EXTRACT(WEEK FROM activity.start_time)::int AS week,
      NULL::int AS year_quarter,
      NULL::int AS year_month,
      NULL::int AS year_week,
      activity.duration_seconds AS total_elapsed_time,
      activity.duration_seconds AS total_timer_time,
      NULL::double precision AS total_distance,
      NULL::int AS total_cycles,
      NULL::double precision AS total_work,
      NULL::double precision AS total_calories,
      NULL::double precision AS total_ascent,
      NULL::double precision AS total_descent,
      NULL::double precision AS avg_speed,
      NULL::double precision AS max_speed,
      activity.avg_normalized_power,
      activity.average_power AS avg_power,
      NULL::double precision AS max_power,
      NULL::double precision AS avg_heart_rate,
      NULL::double precision AS max_heart_rate,
      NULL::double precision AS avg_cadence,
      NULL::double precision AS max_cadence,
      CASE WHEN activity.activity_type = 'cycling' THEN FALSE ELSE NULL END::boolean AS validgps,
      activity.workout_type,
      activity.activity_type,
      CASE WHEN activity.activity_type = 'cycling' THEN 'altitude_missing' ELSE NULL END::text AS terrain_profile,
      activity.intensity_profile,
      activity.intensity_tags,
      'unknown'::text AS intensity_structure,
      'unknown'::text AS intensity_dose,
      0::smallint AS intensity_classifier_version,
      activity.perceived_exertion,
      activity.estimated_tss,
      activity.tss_source,
      activity.strength_focus,
      activity.title,
      activity.notes,
      'completed'::text AS segment_processing_status,
      NULL::text AS segment_processing_error,
      activity.updated_at AS segment_processing_updated_at,
      owner.display_name AS owner_display_name,
      owner.email AS owner_email,
      TRUE AS is_owned,
      FALSE AS is_favorite,
      FALSE AS has_thumbnail,
      NULL::timestamptz AS thumbnail_updated_at,
      0::int AS share_group_count
    FROM training_activities activity
    INNER JOIN users owner ON owner.id = activity.uid`;
}

export default class TrainingFeedDBService {
  static async getEntriesByUser(
    uid,
    page,
    size,
    sort,
    filter,
    scope = "mine",
    favoritesOnly = false,
    db = pool
  ) {
    const normalizedScope = ["mine", "shared", "all"].includes(String(scope).toLowerCase())
      ? String(scope).toLowerCase()
      : "mine";
    const safePage = Math.max(1, Number(page) || 1);
    const safeSize = Math.max(1, Math.min(100, Number(size) || 20));
    const offset = (safePage - 1) * safeSize;
    const { whereSQL, orderSQL, params } = FileDBService.buildQueryParts(
      FEED_COLUMNS,
      FEED_NUMERIC_COLUMNS,
      sort,
      filter
    );
    const feedWhere = shiftParameters(whereSQL, 1);
    const feedOrderSQL = normalizeFeedOrder(orderSQL);
    const workoutConditions = [workoutAccessPredicate(normalizedScope)];
    if (favoritesOnly) {
      workoutConditions.push(`EXISTS (
        SELECT 1 FROM workout_favorites wf_filter
        WHERE wf_filter.uid = $1 AND wf_filter.workout_id = workouts.id
      )`);
    }
    const includeManual = normalizedScope !== "shared" && !favoritesOnly;
    const manualConditions = includeManual ? "activity.uid = $1" : "FALSE";
    const filteredWorkout = `SELECT * FROM (${workoutProjection()} WHERE ${workoutConditions.join(" AND ")}) workout_entry ${feedWhere}`;
    const filteredManual = `SELECT * FROM (${manualProjection()} WHERE ${manualConditions}) manual_entry ${feedWhere}`;
    const baseCte = `WITH training_feed AS (${filteredWorkout} UNION ALL ${filteredManual})`;
    const sqlParams = [uid, ...params];
    const dataResult = await db.query(
      `${baseCte}
       SELECT * FROM training_feed
       ${feedOrderSQL}
       , entity_type ASC, entity_id DESC
       LIMIT $${sqlParams.length + 1} OFFSET $${sqlParams.length + 2}`,
      [...sqlParams, safeSize, offset]
    );
    const countResult = await db.query(
      `${baseCte}
       SELECT
         COUNT(*) AS total,
         COALESCE(SUM(total_timer_time), 0) AS total_timer_time,
         COALESCE(SUM(total_distance), 0) AS total_distance
       FROM training_feed`,
      sqlParams
    );
    const rows = dataResult.rows;
    const manualPowerProfiles = await loadManualCyclingPowerProfiles(uid, rows, db);
    const cyclingRows = rows.filter((row) => (
      row.entity_type === "workout" || row.activity_type === "cycling"
    ));
    const enrichedCycling = cyclingRows.length > 0
      ? await FileDBService.post_calculations(uid, cyclingRows, "year")
      : [];
    const enrichedByKey = new Map(enrichedCycling.map((row) => [
      `${row.entity_type}:${row.id}`,
      row
    ]));
    const data = rows.map((row) => {
      const enriched = enrichedByKey.get(`${row.entity_type}:${row.id}`) || {
        ...row,
        ftp: null,
        IF: null,
        TSS: row.estimated_tss == null ? null : Number(row.estimated_tss)
      };
      const powerProfile = row.entity_type === "manual_activity"
        ? manualPowerProfiles.get(String(row.id)) || null
        : null;
      return powerProfile ? { ...enriched, power_profile: powerProfile } : enriched;
    });
    const filteredSummary = countResult.rows[0] || {};
    const totalRecords = Number(filteredSummary.total) || 0;

    const [summaryResult, favoritesResult] = await Promise.all([
      db.query(`
        SELECT
          (SELECT COUNT(*) FROM workouts WHERE uid = $1)::int AS workout_count,
          (SELECT COUNT(*) FROM training_activities WHERE uid = $1)::int AS manual_activity_count,
          COALESCE((SELECT SUM(total_timer_time) FROM workouts WHERE uid = $1 AND workout_type <> 'motorsport'), 0)
            + COALESCE((SELECT SUM(duration_seconds) FROM training_activities WHERE uid = $1), 0) AS total_timer_time,
          COALESCE((SELECT SUM(total_distance) FROM workouts WHERE uid = $1 AND workout_type <> 'motorsport'), 0) AS total_distance
      `, [uid]),
      db.query(`
        SELECT wf.workout_id
        FROM workout_favorites wf
        INNER JOIN workouts w ON w.id = wf.workout_id
        WHERE wf.uid = $1
          AND (w.uid = $1 OR EXISTS (
            SELECT 1 FROM workout_group_shares wgs
            INNER JOIN group_members gm ON gm.group_id = wgs.group_id
            WHERE wgs.workout_id = w.id AND gm.user_id = $1
          ))
        ORDER BY wf.created_at DESC
      `, [uid])
    ]);
    const summary = summaryResult.rows[0] || {};

    return {
      data,
      last_page: Math.max(1, Math.ceil(totalRecords / safeSize)),
      total_records: totalRecords,
      filtered_summary: {
        activity_count: totalRecords,
        total_timer_time: Number(filteredSummary.total_timer_time) || 0,
        total_distance: Number(filteredSummary.total_distance) || 0
      },
      favorite_workout_ids: favoritesResult.rows.map((row) => String(row.workout_id)),
      own_summary: {
        workout_count: Number(summary.workout_count) || 0,
        manual_activity_count: Number(summary.manual_activity_count) || 0,
        total_timer_time: Number(summary.total_timer_time) || 0,
        total_distance: Number(summary.total_distance) || 0
      }
    };
  }
}
