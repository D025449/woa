import pool from "./database.js";
import Workout from "../shared/Workout.js";
import S3Service from "./s3Service.js";
import pgPromise from "pg-promise";
import WorkoutSharingService from "./workoutSharingService.js";
import ElevationService from "./ElevationService.js";

function haversineMeters(a, b) {
  const toRad = (value) => (value * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad((b.lat ?? 0) - (a.lat ?? 0));
  const dLng = toRad((b.lng ?? 0) - (a.lng ?? 0));
  const lat1 = toRad(a.lat ?? 0);
  const lat2 = toRad(b.lat ?? 0);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const x = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
  return 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function computeTrackDistanceMeters(track) {
  if (!Array.isArray(track) || track.length < 2) {
    return 0;
  }

  let total = 0;
  for (let i = 1; i < track.length; i++) {
    total += haversineMeters(track[i - 1], track[i]);
  }
  return total;
}

function buildTrackDistanceIndex(track) {
  const cumulativeMeters = new Float64Array(track.length);
  let total = 0;

  for (let i = 1; i < track.length; i++) {
    total += haversineMeters(track[i - 1], track[i]);
    cumulativeMeters[i] = total;
  }

  return {
    totalMeters: total,
    cumulativeMeters
  };
}

function interpolateTrackPointAtDistance(track, cumulativeMeters, distanceMeters) {
  if (!Array.isArray(track) || track.length === 0) {
    return null;
  }

  if (track.length === 1 || distanceMeters <= 0) {
    return { lat: Number(track[0].lat), lng: Number(track[0].lng) };
  }

  const totalMeters = cumulativeMeters[cumulativeMeters.length - 1];
  if (distanceMeters >= totalMeters) {
    const lastPoint = track[track.length - 1];
    return { lat: Number(lastPoint.lat), lng: Number(lastPoint.lng) };
  }

  for (let i = 1; i < track.length; i++) {
    const segmentEndMeters = cumulativeMeters[i];
    if (distanceMeters > segmentEndMeters) {
      continue;
    }

    const segmentStartMeters = cumulativeMeters[i - 1];
    const segmentMeters = segmentEndMeters - segmentStartMeters;
    const ratio = segmentMeters > 0
      ? (distanceMeters - segmentStartMeters) / segmentMeters
      : 0;
    const from = track[i - 1];
    const to = track[i];
    return {
      lat: Number(from.lat) + (Number(to.lat) - Number(from.lat)) * ratio,
      lng: Number(from.lng) + (Number(to.lng) - Number(from.lng)) * ratio
    };
  }

  const fallback = track[track.length - 1];
  return { lat: Number(fallback.lat), lng: Number(fallback.lng) };
}

function computeBBox(track) {
  if (!Array.isArray(track) || track.length === 0) {
    return null;
  }

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;

  for (const point of track) {
    const lat = Number(point?.lat);
    const lng = Number(point?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      continue;
    }
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }

  if (!Number.isFinite(minLat) || !Number.isFinite(minLng) || !Number.isFinite(maxLat) || !Number.isFinite(maxLng)) {
    return null;
  }

  return { minLat, maxLat, minLng, maxLng };
}

function buildLinestringWkt(track) {
  return `LINESTRING(${track.map((point) => `${point.lng} ${point.lat}`).join(", ")})`;
}

function interpolateScalarAtDistance(track, cumulativeMeters, distanceMeters, fieldName) {
  if (!Array.isArray(track) || track.length === 0) {
    return null;
  }

  if (track.length === 1 || distanceMeters <= 0) {
    const value = Number(track[0]?.[fieldName]);
    return Number.isFinite(value) ? value : null;
  }

  const totalMeters = cumulativeMeters[cumulativeMeters.length - 1];
  if (distanceMeters >= totalMeters) {
    const value = Number(track[track.length - 1]?.[fieldName]);
    return Number.isFinite(value) ? value : null;
  }

  for (let i = 1; i < track.length; i++) {
    const segmentEndMeters = cumulativeMeters[i];
    if (distanceMeters > segmentEndMeters) {
      continue;
    }

    const from = track[i - 1];
    const to = track[i];
    const fromValue = Number(from?.[fieldName]);
    const toValue = Number(to?.[fieldName]);

    if (!Number.isFinite(fromValue) && !Number.isFinite(toValue)) {
      return null;
    }
    if (!Number.isFinite(fromValue)) {
      return toValue;
    }
    if (!Number.isFinite(toValue)) {
      return fromValue;
    }

    const segmentStartMeters = cumulativeMeters[i - 1];
    const segmentMeters = segmentEndMeters - segmentStartMeters;
    const ratio = segmentMeters > 0
      ? (distanceMeters - segmentStartMeters) / segmentMeters
      : 0;

    return fromValue + (toValue - fromValue) * ratio;
  }

  const fallbackValue = Number(track[track.length - 1]?.[fieldName]);
  return Number.isFinite(fallbackValue) ? fallbackValue : null;
}

function computeTotalDescentMeters(altitudes = []) {
  let total = 0;

  for (let i = 1; i < altitudes.length; i++) {
    const prev = Number(altitudes[i - 1]);
    const current = Number(altitudes[i]);

    if (!Number.isFinite(prev) || !Number.isFinite(current)) {
      continue;
    }

    const delta = current - prev;
    if (delta < 0) {
      total += Math.abs(delta);
    }
  }

  return Math.round(total);
}

function parseGeoJsonTrack(geoJsonTrack) {
  const coordinates = Array.isArray(geoJsonTrack?.coordinates)
    ? geoJsonTrack.coordinates
    : [];

  return coordinates
    .map((point) => ({
      lat: Number(Array.isArray(point) ? point[1] : null),
      lng: Number(Array.isArray(point) ? point[0] : null)
    }))
    .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));
}

function buildDistanceAxisIndex(values = []) {
  const axis = [];
  let lastValue = 0;

  for (let i = 0; i < values.length; i++) {
    const value = Number(values[i]);
    if (!Number.isFinite(value)) {
      axis.push(lastValue);
      continue;
    }
    lastValue = Math.max(lastValue, value);
    axis.push(lastValue);
  }

  return axis;
}

function interpolateTrackPointAtDistanceAxis(track, distanceAxis, distanceMeters) {
  if (!Array.isArray(track) || track.length === 0) {
    return null;
  }

  if (track.length === 1 || distanceMeters <= 0) {
    return {
      lat: Number(track[0]?.lat),
      lng: Number(track[0]?.lng),
      ele: Number(track[0]?.ele)
    };
  }

  const totalMeters = Number(distanceAxis[distanceAxis.length - 1]) || 0;
  if (distanceMeters >= totalMeters) {
    const lastPoint = track[track.length - 1];
    return {
      lat: Number(lastPoint?.lat),
      lng: Number(lastPoint?.lng),
      ele: Number(lastPoint?.ele)
    };
  }

  for (let i = 1; i < track.length; i++) {
    const segmentEndMeters = Number(distanceAxis[i]) || 0;
    if (distanceMeters > segmentEndMeters) {
      continue;
    }

    const segmentStartMeters = Number(distanceAxis[i - 1]) || 0;
    const segmentMeters = segmentEndMeters - segmentStartMeters;
    const ratio = segmentMeters > 0
      ? (distanceMeters - segmentStartMeters) / segmentMeters
      : 0;

    const from = track[i - 1];
    const to = track[i];
    const eleFrom = Number(from?.ele);
    const eleTo = Number(to?.ele);

    return {
      lat: Number(from?.lat) + (Number(to?.lat) - Number(from?.lat)) * ratio,
      lng: Number(from?.lng) + (Number(to?.lng) - Number(from?.lng)) * ratio,
      ele: Number.isFinite(eleFrom) && Number.isFinite(eleTo)
        ? eleFrom + (eleTo - eleFrom) * ratio
        : (Number.isFinite(eleFrom) ? eleFrom : (Number.isFinite(eleTo) ? eleTo : null))
    };
  }

  const fallback = track[track.length - 1];
  return {
    lat: Number(fallback?.lat),
    lng: Number(fallback?.lng),
    ele: Number(fallback?.ele)
  };
}


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
        validgps,
        sampleRateGPS,
        gps_source,
        manual_gps_lookup_points,
        ST_AsGeoJSON(geom)::json AS track
        FROM workouts 
        WHERE id = $1`,
      [id]
    );

    if (result.rowCount === 0) {
      throw new Error("no workouts found");
    }

    return result.rows[0];
  }

  static async getManualGpsContext(id, uid) {
    const accessInfo = await WorkoutSharingService.getAccessibleWorkout(uid, id);
    if (!accessInfo?.is_owner) {
      const error = new Error("Only workout owners can modify manual GPS.");
      error.statusCode = 403;
      throw error;
    }

    const result = await pool.query(
      `SELECT
        id,
        uid,
        total_distance,
        total_timer_time,
        total_elapsed_time,
        validgps,
        gps_source,
        manual_gps_lookup_points,
        stream
       FROM workouts
       WHERE id = $1
         AND uid = $2`,
      [id, uid]
    );

    if (result.rowCount === 0) {
      throw new Error("no workouts found");
    }

    const row = result.rows[0];
    row.workoutObject = await Workout.fromCompressed(row.stream);
    return row;
  }

  static async getGpsCopyCandidates(id, uid, distanceToleranceRatio = 0.05) {
    const accessInfo = await WorkoutSharingService.getAccessibleWorkout(uid, id);
    if (!accessInfo?.is_owner) {
      const error = new Error("Only workout owners can copy GPS.");
      error.statusCode = 403;
      throw error;
    }

    const targetResult = await pool.query(
      `SELECT id, uid, total_distance
       FROM workouts
       WHERE id = $1
         AND uid = $2`,
      [id, uid]
    );

    if (targetResult.rowCount === 0) {
      throw new Error("no workouts found");
    }

    const targetDistance = Number(targetResult.rows[0]?.total_distance);
    if (!Number.isFinite(targetDistance) || targetDistance <= 0) {
      const error = new Error("Workout has no usable distance for GPS copy candidates.");
      error.statusCode = 422;
      throw error;
    }

    const minDistance = targetDistance * (1 - distanceToleranceRatio);
    const maxDistance = targetDistance * (1 + distanceToleranceRatio);

    const result = await pool.query(
      `SELECT
        w.id,
        w.start_time,
        w.total_distance,
        w.total_timer_time,
        w.total_ascent,
        w.validgps,
        CASE
          WHEN ${FEATURE_THUMBNAILS_ON_DEMAND ? "TRUE" : "FALSE"}
          THEN TRUE
          ELSE wt.workout_id IS NOT NULL
        END AS has_thumbnail,
        wt.updated_at AS thumbnail_updated_at
       FROM workouts w
       LEFT JOIN workout_thumbnails wt
         ON wt.workout_id = w.id
       WHERE w.uid = $1
         AND w.id <> $2
         AND w.validgps = true
         AND w.geom IS NOT NULL
         AND w.total_distance BETWEEN $3 AND $4
       ORDER BY ABS(COALESCE(w.total_distance, 0) - $5) ASC, w.start_time DESC NULLS LAST, w.id DESC
       LIMIT 60`,
      [uid, id, minDistance, maxDistance, targetDistance]
    );

    return result.rows.map((row) => ({
      ...row,
      distance_delta_meters: Math.abs(Number(row.total_distance || 0) - targetDistance)
    }));
  }

  static async getGpsCopySourceContext(id, uid) {
    const result = await pool.query(
      `SELECT
        id,
        uid,
        total_distance,
        samplerategps,
        gps_source,
        stream,
        ST_AsGeoJSON(geom)::json AS track
       FROM workouts
       WHERE id = $1
         AND uid = $2
         AND validgps = true
         AND geom IS NOT NULL`,
      [id, uid]
    );

    if (result.rowCount === 0) {
      throw new Error("no workouts found");
    }

    const row = result.rows[0];
    row.workoutObject = await Workout.fromCompressed(row.stream);
    row.trackPoints = parseGeoJsonTrack(row.track);
    return row;
  }

  static buildManualGpsTrackFromLookup(workoutObject, lookupTrack, totalWorkoutDistanceMeters) {
    if (!workoutObject?.hasDistanceSeries?.()) {
      throw new Error("Workout has no distance series for manual GPS mapping.");
    }

    if (!Array.isArray(lookupTrack) || lookupTrack.length < 2) {
      throw new Error("Lookup track needs at least two points.");
    }

    const trackIndex = buildTrackDistanceIndex(lookupTrack);
    if (trackIndex.totalMeters <= 0) {
      throw new Error("Lookup track distance is invalid.");
    }

    const effectiveWorkoutDistanceMeters = Number(totalWorkoutDistanceMeters);
    if (!Number.isFinite(effectiveWorkoutDistanceMeters) || effectiveWorkoutDistanceMeters <= 0) {
      throw new Error("Workout distance is invalid for manual GPS mapping.");
    }

    const sampledTrack = [];
    const seenKeys = new Set();
    const pushPoint = (point) => {
      if (!point) {
        return;
      }
      const lat = Number(point.lat);
      const lng = Number(point.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return;
      }
      const key = `${lat.toFixed(7)}:${lng.toFixed(7)}`;
      if (seenKeys.has(key) && sampledTrack.length > 0) {
        const last = sampledTrack[sampledTrack.length - 1];
        if (last.lat === lat && last.lng === lng) {
          return;
        }
      }
      seenKeys.add(key);
      sampledTrack.push({ lat, lng });
    };

    for (let index = 0; index < workoutObject.length; index += 5) {
      const distanceMeters = workoutObject.getDistanceAt(index);
      if (!Number.isFinite(distanceMeters)) {
        continue;
      }
      const progress = Math.max(0, Math.min(1, distanceMeters / effectiveWorkoutDistanceMeters));
      const lookupDistanceMeters = progress * trackIndex.totalMeters;
      pushPoint(interpolateTrackPointAtDistance(lookupTrack, trackIndex.cumulativeMeters, lookupDistanceMeters));
    }

    const lastDistanceMeters = workoutObject.getDistanceAt(workoutObject.length - 1);
    const lastProgress = Number.isFinite(lastDistanceMeters)
      ? Math.max(0, Math.min(1, lastDistanceMeters / effectiveWorkoutDistanceMeters))
      : 1;
    pushPoint(interpolateTrackPointAtDistance(
      lookupTrack,
      trackIndex.cumulativeMeters,
      lastProgress * trackIndex.totalMeters
    ));

    if (sampledTrack.length < 2) {
      throw new Error("Manual GPS track generation produced too few points.");
    }

    return {
      track: sampledTrack,
      sampleRateSeconds: 5,
      mappedDistanceMeters: computeTrackDistanceMeters(sampledTrack),
      lookupDistanceMeters: trackIndex.totalMeters
    };
  }

  static buildGpsTrackFromSourceWorkout(targetWorkoutObject, targetTotalDistanceMeters, sourceWorkoutObject, sourceTrackPoints, sourceSampleRateSeconds = 5, sourceTotalDistanceMeters = null) {
    if (!targetWorkoutObject?.hasDistanceSeries?.()) {
      throw new Error("Target workout has no distance series for GPS copy.");
    }
    if (!sourceWorkoutObject?.hasDistanceSeries?.()) {
      throw new Error("Source workout has no distance series for GPS copy.");
    }
    if (!Array.isArray(sourceTrackPoints) || sourceTrackPoints.length < 2) {
      throw new Error("Source workout has no usable GPS track.");
    }

    const effectiveTargetDistanceMeters = Number(targetTotalDistanceMeters);
    if (!Number.isFinite(effectiveTargetDistanceMeters) || effectiveTargetDistanceMeters <= 0) {
      throw new Error("Target workout distance is invalid for GPS copy.");
    }

    const sourceDistanceFallback = Number(sourceTotalDistanceMeters)
      || Number(sourceWorkoutObject.getDistanceAt(sourceWorkoutObject.length - 1))
      || 0;
    if (!Number.isFinite(sourceDistanceFallback) || sourceDistanceFallback <= 0) {
      throw new Error("Source workout distance is invalid for GPS copy.");
    }

    const sourceDistanceAxis = buildDistanceAxisIndex(
      sourceTrackPoints.map((_, trackIndex) => {
        const sourceSampleIndex = Math.min(
          sourceWorkoutObject.length - 1,
          Math.round(trackIndex * Math.max(1, Number(sourceSampleRateSeconds) || 1))
        );
        const distanceMeters = sourceWorkoutObject.getDistanceAt(sourceSampleIndex);
        return Number.isFinite(distanceMeters)
          ? distanceMeters
          : ((trackIndex / Math.max(1, sourceTrackPoints.length - 1)) * sourceDistanceFallback);
      })
    );

    const enrichedSourceTrack = sourceTrackPoints.map((point, trackIndex) => {
      const sourceSampleIndex = Math.min(
        sourceWorkoutObject.length - 1,
        Math.round(trackIndex * Math.max(1, Number(sourceSampleRateSeconds) || 1))
      );
      return {
        lat: Number(point.lat),
        lng: Number(point.lng),
        ele: sourceWorkoutObject.getAltitudeAt(sourceSampleIndex)
      };
    });

    const sampledTrack = [];
    const seenKeys = new Set();
    const pushPoint = (point) => {
      if (!point) {
        return;
      }
      const lat = Number(point.lat);
      const lng = Number(point.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return;
      }
      const key = `${lat.toFixed(7)}:${lng.toFixed(7)}`;
      if (seenKeys.has(key) && sampledTrack.length > 0) {
        const last = sampledTrack[sampledTrack.length - 1];
        if (last.lat === lat && last.lng === lng) {
          return;
        }
      }
      seenKeys.add(key);
      sampledTrack.push({
        lat,
        lng,
        ele: Number.isFinite(point.ele) ? Number(point.ele) : null
      });
    };

    for (let index = 0; index < targetWorkoutObject.length; index += 5) {
      const targetDistanceMeters = targetWorkoutObject.getDistanceAt(index);
      if (!Number.isFinite(targetDistanceMeters)) {
        continue;
      }
      const progress = Math.max(0, Math.min(1, targetDistanceMeters / effectiveTargetDistanceMeters));
      pushPoint(interpolateTrackPointAtDistanceAxis(
        enrichedSourceTrack,
        sourceDistanceAxis,
        progress * sourceDistanceFallback
      ));
    }

    const lastDistanceMeters = targetWorkoutObject.getDistanceAt(targetWorkoutObject.length - 1);
    const lastProgress = Number.isFinite(lastDistanceMeters)
      ? Math.max(0, Math.min(1, lastDistanceMeters / effectiveTargetDistanceMeters))
      : 1;
    pushPoint(interpolateTrackPointAtDistanceAxis(
      enrichedSourceTrack,
      sourceDistanceAxis,
      lastProgress * sourceDistanceFallback
    ));

    if (sampledTrack.length < 2) {
      throw new Error("GPS copy produced too few track points.");
    }

    return {
      track: sampledTrack,
      sampleRateSeconds: 5,
      mappedDistanceMeters: computeTrackDistanceMeters(sampledTrack),
      lookupDistanceMeters: sourceDistanceFallback
    };
  }

  static async enrichManualGpsTrackAltitude(manualGpsTrack) {
    const baseTrack = Array.isArray(manualGpsTrack?.track) ? manualGpsTrack.track : [];
    if (baseTrack.length < 2) {
      throw new Error("Manual GPS track needs at least two points for altitude enrichment.");
    }

    const service = new ElevationService({
      batchSize: 100,
      sleepMs: 150,
      downsampleStep: 5
    });

    const enrichedTrack = await service.enrichTrack(baseTrack);
    return {
      ...manualGpsTrack,
      track: enrichedTrack
    };
  }

  static buildWorkoutStreamFromManualGps(workoutObject, manualGpsTrack, totalWorkoutDistanceMeters) {
    if (!workoutObject?.hasDistanceSeries?.()) {
      throw new Error("Workout has no distance series for manual GPS altitude mapping.");
    }

    const track = Array.isArray(manualGpsTrack?.track) ? manualGpsTrack.track : [];
    if (track.length < 2) {
      throw new Error("Manual GPS altitude track needs at least two points.");
    }

    const trackIndex = buildTrackDistanceIndex(track);
    if (trackIndex.totalMeters <= 0) {
      throw new Error("Manual GPS altitude track distance is invalid.");
    }

    const effectiveWorkoutDistanceMeters = Number(totalWorkoutDistanceMeters);
    if (!Number.isFinite(effectiveWorkoutDistanceMeters) || effectiveWorkoutDistanceMeters <= 0) {
      throw new Error("Workout distance is invalid for manual GPS stream rebuild.");
    }

    const records = [];
    const altitudes = [];

    for (let index = 0; index < workoutObject.length; index++) {
      const metrics = workoutObject.getMetricsAt(index);
      const distanceMeters = workoutObject.getDistanceAt(index);
      const progress = Number.isFinite(distanceMeters)
        ? Math.max(0, Math.min(1, distanceMeters / effectiveWorkoutDistanceMeters))
        : (workoutObject.length > 1 ? index / (workoutObject.length - 1) : 0);
      const lookupDistanceMeters = progress * trackIndex.totalMeters;
      const altitude = interpolateScalarAtDistance(track, trackIndex.cumulativeMeters, lookupDistanceMeters, "ele");
      const normalizedAltitude = Number.isFinite(altitude)
        ? altitude
        : (index > 0 ? altitudes[index - 1] : 0);

      altitudes.push(normalizedAltitude);
      records.push({
        power: metrics.power,
        heart_rate: metrics.hr,
        cadence: metrics.cadence,
        speed: Number.isFinite(metrics.speed) ? metrics.speed / 3.6 : 0,
        altitude: normalizedAltitude,
        distance: Number.isFinite(distanceMeters) ? distanceMeters : undefined
      });
    }

    const rebuiltWorkout = Workout.fromRecords(records, {
      validGps: true,
      startTime: workoutObject.getStartTime()
    });

    return {
      workoutObject: rebuiltWorkout,
      totalAscent: Math.round(rebuiltWorkout.getElevationGainTotal()),
      totalDescent: computeTotalDescentMeters(altitudes)
    };
  }

  static async updateWorkoutManualGps(id, uid, manualGpsTrack, lookupPoints = [], streamUpdate = null) {
    const normalizedTrack = Array.isArray(manualGpsTrack?.track)
      ? manualGpsTrack.track
          .map((point) => ({
            lat: Number(point?.lat),
            lng: Number(point?.lng),
            ele: Number(point?.ele)
          }))
          .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng))
      : [];

    if (normalizedTrack.length < 2) {
      throw new Error("Manual GPS track needs at least two points.");
    }

    const bbox = computeBBox(normalizedTrack);
    if (!bbox) {
      throw new Error("Manual GPS track bounding box is invalid.");
    }

    const pointsCount = normalizedTrack.length;
    const geom = buildLinestringWkt(normalizedTrack);
    const firstPoint = normalizedTrack[0];
    const lastPoint = normalizedTrack[normalizedTrack.length - 1];
    const trackStartGeom = `POINT(${firstPoint.lng} ${firstPoint.lat})`;
    const trackEndGeom = `POINT(${lastPoint.lng} ${lastPoint.lat})`;
    const normalizedLookupPoints = Array.isArray(lookupPoints)
      ? lookupPoints
          .map((point) => ({
            lat: Number(point?.lat),
            lng: Number(point?.lng)
          }))
          .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng))
      : [];
    const streamBuffer = streamUpdate?.workoutObject
      ? await streamUpdate.workoutObject.toCompressedBuffer()
      : null;

    const result = await pool.query(
      `UPDATE workouts
       SET
        validgps = true,
        points_count = $3,
        samplerategps = $4,
        bounds = ST_MakeEnvelope($5::float8, $6::float8, $7::float8, $8::float8, 4326),
        track_start = ST_GeomFromText($9, 4326),
        track_end = ST_GeomFromText($10, 4326),
        geom = ST_GeomFromText($11, 4326),
        gps_source = 'manual_lookup',
        manual_gps_lookup_points = $12::jsonb,
        stream = COALESCE($13::bytea, stream),
        total_ascent = COALESCE($14::float8, total_ascent),
        total_descent = COALESCE($15::float8, total_descent)
       WHERE id = $1
         AND uid = $2
       RETURNING
        id,
        sampleRateGPS,
        gps_source,
        manual_gps_lookup_points,
        total_ascent,
        total_descent,
        ST_AsGeoJSON(geom)::json AS track`,
      [
        id,
        uid,
        pointsCount,
        Number(manualGpsTrack?.sampleRateSeconds) || 5,
        bbox.minLng,
        bbox.minLat,
        bbox.maxLng,
        bbox.maxLat,
        trackStartGeom,
        trackEndGeom,
        geom,
        JSON.stringify(normalizedLookupPoints),
        streamBuffer,
        Number.isFinite(streamUpdate?.totalAscent) ? streamUpdate.totalAscent : null,
        Number.isFinite(streamUpdate?.totalDescent) ? streamUpdate.totalDescent : null
      ]
    );

    if (result.rowCount === 0) {
      throw new Error("no workouts found");
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
      throw new Error("no workouts found");
    }

    return result.rows[0];
  }

  static async getWorkout(id) {
    const result = await pool.query(
      `SELECT stream FROM workouts WHERE id = $1`,
      [id]
    );

    if (result.rowCount === 0) {
      throw new Error("no workouts found");
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
      throw new Error("no workouts found");
    }

    const workoutMap = new Map();

    for (const w of result.rows) {
      const workoutObject = await Workout.fromCompressed(w.stream);
      workoutMap.set(w.id, workoutObject);
    };

    return workoutMap;

  }


} // class
const FEATURE_THUMBNAILS_ON_DEMAND = String(process.env.FEATURE_THUMBNAILS_ON_DEMAND || "1").trim() !== "0";
