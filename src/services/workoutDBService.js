import pool from "./database.js";
import Workout from "../shared/Workout.js";
import S3Service from "./s3Service.js";
import pgPromise from "pg-promise";
import WorkoutSharingService from "./workoutSharingService.js";


export default class WorkoutDBService {
  static async getOwnGpsWorkoutIds(uid) {
    const result = await pool.query(
      `
        SELECT id
        FROM workouts
        WHERE uid = $1
          AND validgps = true
          AND geom IS NOT NULL
          AND bounds IS NOT NULL
          AND track_start IS NOT NULL
          AND track_end IS NOT NULL
        ORDER BY start_time DESC NULLS LAST, id DESC
      `,
      [uid]
    );

    return result.rows.map((row) => Number(row.id)).filter((value) => Number.isFinite(value));
  }

  static async getSimilarRouteCandidates(sourceWorkoutId, uid, options = {}) {
    const {
      distanceToleranceRatio = 0.04,
      ascentToleranceRatio = 0.05,
      endpointRadiusMeters = 200,
      startRadiusMeters = null,
      endRadiusMeters = null,
      minCandidateWorkoutId = null,
      skipExistingEdgeMatchType = null
    } = options;

    const hasMinCandidateWorkoutId = Number.isFinite(Number(minCandidateWorkoutId));
    const effectiveStartRadiusMeters = Number.isFinite(Number(startRadiusMeters))
      ? Number(startRadiusMeters)
      : Number(endpointRadiusMeters);
    const effectiveEndRadiusMeters = Number.isFinite(Number(endRadiusMeters))
      ? Number(endRadiusMeters)
      : Number(endpointRadiusMeters);
    const hasSkipExistingEdgeMatchType = typeof skipExistingEdgeMatchType === "string" && skipExistingEdgeMatchType.trim().length > 0;
    const skipExistingEdgeType = hasSkipExistingEdgeMatchType ? skipExistingEdgeMatchType.trim() : null;

    const sql = `
      WITH source AS (
        SELECT
          w.id,
          w.uid,
          w.total_distance,
          w.total_ascent,
          w.bounds,
          w.track_start,
          w.track_end
        FROM workouts w
        WHERE
          w.id = $1
          AND w.uid = $2
          AND w.validgps = true
          AND w.geom IS NOT NULL
          AND w.bounds IS NOT NULL
          AND w.track_start IS NOT NULL
          AND w.track_end IS NOT NULL
      )
      SELECT
        w.id,
        w.uid,
        w.total_distance,
        w.total_ascent,
        w.samplerategps,
        ST_AsGeoJSON(w.geom)::json AS track,
        ST_Distance(w.track_start::geography, s.track_start::geography) AS start_distance_m,
        ST_Distance(w.track_end::geography, s.track_end::geography) AS end_distance_m,
        ABS(w.total_distance - s.total_distance) / NULLIF(s.total_distance, 0) AS distance_delta_ratio,
        ABS(COALESCE(w.total_ascent, 0) - COALESCE(s.total_ascent, 0)) / NULLIF(GREATEST(COALESCE(s.total_ascent, 0), 1), 0) AS ascent_delta_ratio
      FROM workouts w
      CROSS JOIN source s
      WHERE
        w.uid = s.uid
        AND w.id <> s.id
        ${hasMinCandidateWorkoutId ? `AND w.id > $7` : ""}
        ${hasSkipExistingEdgeMatchType ? `AND NOT EXISTS (
          SELECT 1
          FROM workout_similarity_edges existing
          WHERE existing.uid = s.uid
            AND existing.match_type = $8
            AND existing.workout_id_a = LEAST(s.id, w.id)
            AND existing.workout_id_b = GREATEST(s.id, w.id)
        )` : ""}
        AND w.validgps = true
        AND w.geom IS NOT NULL
        AND w.bounds IS NOT NULL
        AND w.track_start IS NOT NULL
        AND w.track_end IS NOT NULL
        AND s.bounds && w.bounds
        AND w.total_distance BETWEEN s.total_distance * (1::double precision - $3::double precision) AND s.total_distance * (1::double precision + $3::double precision)
        AND COALESCE(w.total_ascent, 0) BETWEEN COALESCE(s.total_ascent, 0) * (1::double precision - $4::double precision) AND COALESCE(s.total_ascent, 0) * (1::double precision + $4::double precision)
        AND ST_DWithin(w.track_start::geography, s.track_start::geography, $5::double precision)
        AND ST_DWithin(w.track_end::geography, s.track_end::geography, $6::double precision)
      ORDER BY start_distance_m ASC, end_distance_m ASC, w.id ASC;
    `;

    const params = [
      sourceWorkoutId,
      uid,
      distanceToleranceRatio,
      ascentToleranceRatio,
      effectiveStartRadiusMeters,
      effectiveEndRadiusMeters,
      hasMinCandidateWorkoutId ? Number(minCandidateWorkoutId) : null
    ];
    if (hasSkipExistingEdgeMatchType) {
      params.push(skipExistingEdgeType);
    }

    const result = await pool.query(sql, params);

    return result.rows;
  }

  static async upsertSimilarityEdge(edge) {
    const workoutIdA = Number(edge?.workoutIdA);
    const workoutIdB = Number(edge?.workoutIdB);
    const uid = Number(edge?.uid);
    const matchType = String(edge?.matchType || "").trim();

    if (!Number.isFinite(uid) || !Number.isFinite(workoutIdA) || !Number.isFinite(workoutIdB) || !matchType) {
      throw new Error("Invalid similarity edge payload");
    }

    if (workoutIdA === workoutIdB) {
      throw new Error("Similarity edge requires two different workout ids");
    }

    const a = Math.min(workoutIdA, workoutIdB);
    const b = Math.max(workoutIdA, workoutIdB);

    const sql = `
      INSERT INTO workout_similarity_edges (
        uid,
        workout_id_a,
        workout_id_b,
        match_type,
        score,
        distance_delta_ratio,
        ascent_delta_ratio,
        start_distance_m,
        end_distance_m,
        point_match_ratio_ab,
        point_match_ratio_ba
      )
      VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10, $11
      )
      ON CONFLICT (uid, workout_id_a, workout_id_b, match_type)
      DO UPDATE SET
        score = EXCLUDED.score,
        distance_delta_ratio = EXCLUDED.distance_delta_ratio,
        ascent_delta_ratio = EXCLUDED.ascent_delta_ratio,
        start_distance_m = EXCLUDED.start_distance_m,
        end_distance_m = EXCLUDED.end_distance_m,
        point_match_ratio_ab = EXCLUDED.point_match_ratio_ab,
        point_match_ratio_ba = EXCLUDED.point_match_ratio_ba,
        updated_at = NOW()
      RETURNING *;
    `;

    const values = [
      uid,
      a,
      b,
      matchType,
      Number(edge.score ?? 0),
      edge.distanceDeltaRatio ?? null,
      edge.ascentDeltaRatio ?? null,
      edge.startDistanceM ?? null,
      edge.endDistanceM ?? null,
      edge.pointMatchRatioAB ?? null,
      edge.pointMatchRatioBA ?? null
    ];

    const result = await pool.query(sql, values);
    return result.rows[0] || null;
  }

  static async getSimilarityEdgesForWorkout(workoutId, uid, matchType = null) {
    const values = [uid, workoutId];
    let typeClause = "";

    if (matchType) {
      values.push(matchType);
      typeClause = ` AND e.match_type = $3`;
    }

    const sql = `
      SELECT
        e.*,
        CASE
          WHEN e.workout_id_a = $2 THEN e.workout_id_b
          ELSE e.workout_id_a
        END AS other_workout_id,
        w.start_time AS other_start_time,
        w.total_distance AS other_total_distance,
        w.total_ascent AS other_total_ascent,
        w.avg_power AS other_avg_power,
        w.avg_normalized_power AS other_avg_normalized_power,
        w.avg_heart_rate AS other_avg_heart_rate,
        w.validgps AS other_valid_gps
      FROM workout_similarity_edges e
      JOIN workouts w
        ON w.id = CASE
          WHEN e.workout_id_a = $2 THEN e.workout_id_b
          ELSE e.workout_id_a
        END
      WHERE
        e.uid = $1
        AND (e.workout_id_a = $2 OR e.workout_id_b = $2)
        ${typeClause}
      ORDER BY e.score DESC, e.updated_at DESC;
    `;

    const result = await pool.query(sql, values);
    return result.rows;
  }

  static async getSimilarityClusterForWorkout(workoutId, uid, matchType) {
    if (!matchType) {
      throw new Error("Similarity cluster lookup requires matchType");
    }

    const sql = `
      WITH RECURSIVE component(workout_id) AS (
        SELECT $2::bigint
        UNION
        SELECT
          CASE
            WHEN e.workout_id_a = c.workout_id THEN e.workout_id_b
            ELSE e.workout_id_a
          END AS workout_id
        FROM workout_similarity_edges e
        JOIN component c
          ON e.workout_id_a = c.workout_id OR e.workout_id_b = c.workout_id
        WHERE
          e.uid = $1
          AND e.match_type = $3
      ),
      members AS (
        SELECT DISTINCT workout_id
        FROM component
        WHERE workout_id <> $2
      ),
      direct_edges AS (
        SELECT
          CASE
            WHEN e.workout_id_a = $2 THEN e.workout_id_b
            ELSE e.workout_id_a
          END AS other_workout_id,
          e.score,
          e.distance_delta_ratio,
          e.ascent_delta_ratio,
          e.start_distance_m,
          e.end_distance_m,
          e.point_match_ratio_ab,
          e.point_match_ratio_ba,
          e.updated_at
        FROM workout_similarity_edges e
        WHERE
          e.uid = $1
          AND e.match_type = $3
          AND (e.workout_id_a = $2 OR e.workout_id_b = $2)
      )
      SELECT
        m.workout_id AS other_workout_id,
        w.start_time AS other_start_time,
        w.total_distance AS other_total_distance,
        w.total_ascent AS other_total_ascent,
        w.avg_power AS other_avg_power,
        w.avg_normalized_power AS other_avg_normalized_power,
        w.avg_heart_rate AS other_avg_heart_rate,
        w.validgps AS other_valid_gps,
        d.score,
        d.distance_delta_ratio,
        d.ascent_delta_ratio,
        d.start_distance_m,
        d.end_distance_m,
        d.point_match_ratio_ab,
        d.point_match_ratio_ba,
        (d.other_workout_id IS NOT NULL) AS is_direct_match,
        d.updated_at
      FROM members m
      JOIN workouts w
        ON w.id = m.workout_id
      LEFT JOIN direct_edges d
        ON d.other_workout_id = m.workout_id
      ORDER BY
        (d.other_workout_id IS NOT NULL) DESC,
        d.score DESC NULLS LAST,
        w.start_time DESC NULLS LAST,
        m.workout_id DESC;
    `;

    const result = await pool.query(sql, [uid, workoutId, matchType]);
    return result.rows;
  }

  static async deleteSimilarityEdgesForWorkout(workoutId, uid, matchType = null) {
    const values = [uid, workoutId];
    let typeClause = "";

    if (matchType) {
      values.push(matchType);
      typeClause = ` AND match_type = $3`;
    }

    const sql = `
      DELETE FROM workout_similarity_edges
      WHERE uid = $1
        AND (workout_id_a = $2 OR workout_id_b = $2)
        ${typeClause};
    `;

    await pool.query(sql, values);
  }

  static async deleteSimilarityEdgesForUser(uid, matchType = null) {
    const values = [uid];
    let typeClause = "";

    if (matchType) {
      values.push(matchType);
      typeClause = " AND match_type = $2";
    }

    const sql = `
      DELETE FROM workout_similarity_edges
      WHERE uid = $1
      ${typeClause};
    `;

    await pool.query(sql, values);
  }


  /*static allowedColumns = [
    "start_time",
    "uid",
    "id",
    "total_distance",
    "avg_speed",
    "avg_power",
    "avg_cadence",
    "avg_speed",
    "avg_normalized_power",
    "total_timer_time"
  ];

  static numericFields = [
    "id",
    "total_distance",
    "avg_speed",
    "avg_power",
    "avg_cadence",
    "avg_speed",
    "avg_normalized_power",
    "total_timer_time"
  ];*/

  static async getTrack(id, uid) {
    await WorkoutSharingService.getAccessibleWorkout(uid, id);

    const result = await pool.query(
      `SELECT 
        id,
        sampleRateGPS, 
        ST_AsGeoJSON(geom)::json AS track 
        FROM workouts 
        WHERE id = $1`,
      [id]
    );

    if (result.rowCount === 0) {
      throw new Error(`Workout with ID ${id} not found`);
    }

    return result.rows[0];
  }


  static async getStream(id, uid) {
    await WorkoutSharingService.getAccessibleWorkout(uid, id);

    const result = await pool.query(
      `SELECT
        stream,
        uploaded_at,
        octet_length(stream) AS stream_size
       FROM workouts
       WHERE id = $1`,
      [id]
    );

    if (result.rowCount === 0) {
      throw new Error(`Workout with ID ${id} not found`);
    }

    return result.rows[0];
  }

  static async getWorkout(id) {
    const result = await pool.query(
      `SELECT stream FROM workouts WHERE id = $1`,
      [id]
    );

    if (result.rowCount === 0) {
      throw new Error(`Workout with ID ${id} not found`);
    }

    const stream = result.rows[0].stream;

    const workoutObject = await Workout.fromCompressed(stream);

    return workoutObject;
  }

  static async getWorkouts(ids) {
    const result = await pool.query(
      `SELECT id, stream FROM workouts WHERE id = ANY($1::bigint[]);`,
      [ids]
    );

    if (result.rowCount === 0) {
      throw new Error(`Workout with ID ${id} not found`);
    }

    const workoutMap = new Map();

    for (const w of result.rows) {
      const workoutObject = await Workout.fromCompressed(w.stream);
      workoutMap.set(w.id, workoutObject);
    };

    return workoutMap;

  }


} // class
