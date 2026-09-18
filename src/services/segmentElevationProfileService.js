import pool from "./database.js";
import WorkoutDBService from "./workoutDBService.js";
import { buildSegmentComparisonProfile } from "../shared/SegmentComparison.js";

export const WORKOUT_ALTITUDE_ALGORITHM_VERSION = 1;
export const DEFAULT_WORKOUT_ALTITUDE_CANDIDATE_LIMIT = 50;
export const DEFAULT_WORKOUT_ALTITUDE_MIN_CLUSTER_SIZE = 5;
export const DEFAULT_WORKOUT_ALTITUDE_MIN_CLUSTER_FRACTION = 0.6;
export const DEFAULT_WORKOUT_ALTITUDE_CLUSTER_RADIUS_METERS = 15;

function finiteNumber(value) {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function interpolateProfilePoint(points, distanceMeters) {
  if (points.length === 0) return null;
  if (distanceMeters <= points[0].distanceMeters) return points[0].altitude;
  if (distanceMeters >= points.at(-1).distanceMeters) return points.at(-1).altitude;

  let low = 0;
  let high = points.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (points[middle].distanceMeters <= distanceMeters) low = middle;
    else high = middle;
  }

  const left = points[low];
  const right = points[high];
  const width = right.distanceMeters - left.distanceMeters;
  if (!(width > 0)) return left.altitude;
  const progress = (distanceMeters - left.distanceMeters) / width;
  return left.altitude + (right.altitude - left.altitude) * progress;
}

export function normalizeWorkoutAltitudeProfile(comparison, pointCount, distanceMeters) {
  const normalizedPointCount = Math.max(2, Math.floor(Number(pointCount) || 0));
  const normalizedDistance = Number(distanceMeters);
  if (!Number.isFinite(normalizedDistance) || normalizedDistance <= 0) return null;

  const points = (Array.isArray(comparison?.points) ? comparison.points : [])
    .map((point) => ({
      distanceMeters: Number(point?.distanceKm) * 1000,
      altitude: finiteNumber(point?.altitude)
    }))
    .filter((point) => Number.isFinite(point.distanceMeters) && point.altitude != null)
    .sort((left, right) => left.distanceMeters - right.distanceMeters);

  if (points.length < 2) return null;
  if (points[0].distanceMeters > normalizedDistance * 0.02) return null;
  if (points.at(-1).distanceMeters < normalizedDistance * 0.98) return null;

  const values = Array.from({ length: normalizedPointCount }, (_, index) => {
    const distance = normalizedDistance * index / (normalizedPointCount - 1);
    return interpolateProfilePoint(points, distance);
  });
  return values.every(Number.isFinite) ? values : null;
}

export function profileRmse(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || left.length === 0) {
    return Number.POSITIVE_INFINITY;
  }
  let squaredError = 0;
  for (let index = 0; index < left.length; index += 1) {
    const difference = Number(left[index]) - Number(right[index]);
    if (!Number.isFinite(difference)) return Number.POSITIVE_INFINITY;
    squaredError += difference * difference;
  }
  return Math.sqrt(squaredError / left.length);
}

export function selectDominantWorkoutAltitudeCluster(candidates, options = {}) {
  const normalized = (Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => Array.isArray(candidate?.altitudes) && candidate.altitudes.length >= 2);
  if (normalized.length === 0) {
    return { candidates: [], cluster: [], medoid: null, dispersionMeters: null, confirmed: false };
  }

  const radiusMeters = Math.max(
    0.1,
    Number(options.radiusMeters) || DEFAULT_WORKOUT_ALTITUDE_CLUSTER_RADIUS_METERS
  );
  const distanceMatrix = normalized.map(() => Array(normalized.length).fill(0));
  for (let left = 0; left < normalized.length; left += 1) {
    for (let right = left + 1; right < normalized.length; right += 1) {
      const distance = profileRmse(normalized[left].altitudes, normalized[right].altitudes);
      distanceMatrix[left][right] = distance;
      distanceMatrix[right][left] = distance;
    }
  }

  let centerIndex = 0;
  let neighborIndices = [];
  let neighborMedian = Number.POSITIVE_INFINITY;
  for (let index = 0; index < normalized.length; index += 1) {
    const neighbors = distanceMatrix[index]
      .map((distance, candidateIndex) => ({ distance, candidateIndex }))
      .filter(({ distance }) => distance <= radiusMeters);
    const distanceMedian = median(neighbors.map(({ distance }) => distance)) ?? Number.POSITIVE_INFINITY;
    if (
      neighbors.length > neighborIndices.length
      || (neighbors.length === neighborIndices.length && distanceMedian < neighborMedian)
    ) {
      centerIndex = index;
      neighborIndices = neighbors.map(({ candidateIndex }) => candidateIndex);
      neighborMedian = distanceMedian;
    }
  }

  const cluster = neighborIndices.map((index) => normalized[index]);
  let medoidIndex = centerIndex;
  let medoidMeanDistance = Number.POSITIVE_INFINITY;
  for (const candidateIndex of neighborIndices) {
    const totalDistance = neighborIndices.reduce(
      (sum, otherIndex) => sum + distanceMatrix[candidateIndex][otherIndex],
      0
    );
    const meanDistance = totalDistance / neighborIndices.length;
    if (meanDistance < medoidMeanDistance) {
      medoidIndex = candidateIndex;
      medoidMeanDistance = meanDistance;
    }
  }

  const medoid = normalized[medoidIndex];
  const dispersionMeters = median(
    neighborIndices.map((index) => distanceMatrix[medoidIndex][index])
  );
  const minimumSize = Math.max(
    Math.max(1, Math.floor(Number(options.minClusterSize) || DEFAULT_WORKOUT_ALTITUDE_MIN_CLUSTER_SIZE)),
    Math.ceil(
      normalized.length
      * Math.min(1, Math.max(0, Number(options.minClusterFraction) || DEFAULT_WORKOUT_ALTITUDE_MIN_CLUSTER_FRACTION))
    )
  );

  return {
    candidates: normalized,
    cluster,
    medoid,
    dispersionMeters,
    confirmed: cluster.length >= minimumSize
  };
}

function summarizeAltitudes(altitudes) {
  let ascent = 0;
  for (let index = 1; index < altitudes.length; index += 1) {
    ascent += Math.max(0, altitudes[index] - altitudes[index - 1]);
  }
  return {
    startAltitude: altitudes[0],
    endAltitude: altitudes.at(-1),
    ascent
  };
}

function configuredNumber(name, fallback, minimum) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? Math.max(minimum, value) : fallback;
}

export default class SegmentElevationProfileService {
  static get candidateLimit() {
    return Math.floor(configuredNumber(
      "SEGMENT_ELEVATION_PROFILE_CANDIDATE_LIMIT",
      DEFAULT_WORKOUT_ALTITUDE_CANDIDATE_LIMIT,
      5
    ));
  }

  static async markSegmentsStale(segmentIds, queryable = pool) {
    const ids = [...new Set((Array.isArray(segmentIds) ? segmentIds : [])
      .map(Number)
      .filter((segmentId) => Number.isInteger(segmentId) && segmentId > 0))];
    if (ids.length === 0) return [];

    const result = await queryable.query(`
      UPDATE gps_segments
      SET
        workout_altitude_status = CASE
          WHEN workout_altitude_status IN ('confirmed', 'stale') THEN 'stale'
          ELSE 'candidate'
        END,
        updated_at = NOW()
      WHERE id = ANY($1::bigint[])
      RETURNING id
    `, [ids]);
    return result.rows.map((row) => Number(row.id));
  }

  static async getOwnedSegmentId(uid, segmentId) {
    const result = await pool.query(`
      SELECT id
      FROM gps_segments
      WHERE id = $1
        AND uid = $2
      LIMIT 1
    `, [segmentId, uid]);
    return result.rows[0] ? Number(result.rows[0].id) : null;
  }

  static async loadSegment(segmentId) {
    const result = await pool.query(`
      SELECT id, uid, distance, points_count
      FROM gps_segments
      WHERE id = $1
      LIMIT 1
    `, [segmentId]);
    return result.rows[0] || null;
  }

  static async loadCandidates(segmentId, limit = this.candidateLimit) {
    const result = await pool.query(`
      WITH per_workout AS (
        SELECT DISTINCT ON (effort.wid)
          effort.wid,
          effort.start_offset,
          effort.end_offset,
          effort.duration,
          workout.start_time
        FROM gps_segment_best_efforts effort
        INNER JOIN workouts workout
          ON workout.id = effort.wid
        WHERE effort.sid = $1
          AND workout.validgps = true
          AND workout.gps_source = 'recorded'
          AND workout.workout_type <> 'motorsport'
          AND workout.terrain_profile NOT IN ('altitude_missing', 'altitude_invalid')
        ORDER BY effort.wid, effort.duration ASC, effort.start_offset ASC
      )
      SELECT
        wid,
        start_offset,
        end_offset,
        duration,
        start_time
      FROM per_workout
      ORDER BY start_time DESC NULLS LAST, duration ASC, wid DESC
      LIMIT $2
    `, [segmentId, limit]);
    return result.rows;
  }

  static async loadSegmentsForRebuild(segmentIds) {
    const result = await pool.query(`
      SELECT
        id,
        uid,
        distance,
        points_count,
        workout_altitudes,
        workout_start_altitude,
        workout_end_altitude,
        workout_ascent,
        workout_altitude_status
      FROM gps_segments
      WHERE id = ANY($1::bigint[])
      ORDER BY id
    `, [segmentIds]);
    return new Map(result.rows.map((row) => [Number(row.id), row]));
  }

  static async loadCandidatesForSegments(segmentIds, limit = this.candidateLimit) {
    const result = await pool.query(`
      WITH per_workout AS (
        SELECT DISTINCT ON (effort.sid, effort.wid)
          effort.sid,
          effort.wid,
          effort.start_offset,
          effort.end_offset,
          effort.duration,
          workout.start_time
        FROM gps_segment_best_efforts effort
        INNER JOIN workouts workout
          ON workout.id = effort.wid
        WHERE effort.sid = ANY($1::bigint[])
          AND workout.validgps = true
          AND workout.gps_source = 'recorded'
          AND workout.workout_type <> 'motorsport'
          AND workout.terrain_profile NOT IN ('altitude_missing', 'altitude_invalid')
        ORDER BY effort.sid, effort.wid, effort.duration ASC, effort.start_offset ASC
      ),
      ranked_candidates AS (
        SELECT
          sid,
          wid,
          start_offset,
          end_offset,
          duration,
          start_time,
          ROW_NUMBER() OVER (
            PARTITION BY sid
            ORDER BY start_time DESC NULLS LAST, duration ASC, wid DESC
          ) AS candidate_rank
        FROM per_workout
      )
      SELECT sid, wid, start_offset, end_offset, duration, start_time
      FROM ranked_candidates
      WHERE candidate_rank <= $2
      ORDER BY sid, candidate_rank
    `, [segmentIds, limit]);

    const rowsBySegmentId = new Map(segmentIds.map((segmentId) => [Number(segmentId), []]));
    for (const row of result.rows) {
      rowsBySegmentId.get(Number(row.sid))?.push(row);
    }
    return rowsBySegmentId;
  }

  static async persistResult(segmentId, result) {
    const altitudes = result.medoid?.altitudes || null;
    const summary = altitudes ? summarizeAltitudes(altitudes) : null;
    const status = result.confirmed
      ? "confirmed"
      : (result.candidates.length > 0 ? "candidate" : "unavailable");

    const update = await pool.query(`
      UPDATE gps_segments
      SET
        workout_altitudes = $2::jsonb,
        workout_start_altitude = $3,
        workout_end_altitude = $4,
        workout_ascent = $5,
        workout_altitude_status = $6,
        workout_altitude_source_wid = $7,
        workout_altitude_candidate_count = $8,
        workout_altitude_cluster_count = $9,
        workout_altitude_dispersion = $10,
        workout_altitude_algorithm_version = $11,
        workout_altitude_updated_at = NOW(),
        updated_at = NOW()
      WHERE id = $1
      RETURNING id, uid, workout_altitude_status
    `, [
      segmentId,
      altitudes == null ? null : JSON.stringify(altitudes),
      summary?.startAltitude ?? null,
      summary?.endAltitude ?? null,
      summary?.ascent ?? null,
      status,
      result.medoid?.workoutId ?? null,
      result.candidates.length,
      result.cluster.length,
      result.dispersionMeters,
      WORKOUT_ALTITUDE_ALGORITHM_VERSION
    ]);
    return update.rows[0] || null;
  }

  static hasConfirmedStoredProfile(segment) {
    const pointCount = Number(segment?.points_count);
    return ["confirmed", "stale"].includes(String(segment?.workout_altitude_status || ""))
      && Number.isInteger(pointCount)
      && pointCount >= 2
      && Array.isArray(segment?.workout_altitudes)
      && segment.workout_altitudes.length === pointCount
      && segment.workout_altitudes.every((value) => finiteNumber(value) != null)
      && finiteNumber(segment?.workout_start_altitude) != null
      && finiteNumber(segment?.workout_end_altitude) != null
      && finiteNumber(segment?.workout_ascent) != null;
  }

  static async retainConfirmedResult(segmentId) {
    const update = await pool.query(`
      UPDATE gps_segments
      SET
        workout_altitude_status = 'confirmed',
        updated_at = NOW()
      WHERE id = $1
      RETURNING id, uid, workout_altitude_status
    `, [segmentId]);
    return update.rows[0] || null;
  }

  static async rebuildSegments(segmentIds, options = {}) {
    const persist = options.persist !== false;
    const ids = [...new Set((Array.isArray(segmentIds) ? segmentIds : [])
      .map(Number)
      .filter((segmentId) => Number.isInteger(segmentId) && segmentId > 0))];
    if (ids.length === 0) return [];

    const startedAt = performance.now();
    const loadCandidatesStartedAt = performance.now();
    const [segmentsById, rowsBySegmentId] = await Promise.all([
      this.loadSegmentsForRebuild(ids),
      this.loadCandidatesForSegments(ids)
    ]);
    const loadCandidatesMs = performance.now() - loadCandidatesStartedAt;
    const candidateRows = [...rowsBySegmentId.values()].flat();
    const workoutIds = [...new Set(candidateRows.map((row) => Number(row.wid)).filter(Number.isInteger))];
    const loadWorkoutsStartedAt = performance.now();
    const rawWorkouts = workoutIds.length > 0
      ? await WorkoutDBService.getWorkouts(workoutIds)
      : new Map();
    const loadWorkoutsMs = performance.now() - loadWorkoutsStartedAt;
    const workouts = new Map(
      [...rawWorkouts.entries()].map(([workoutId, workout]) => [Number(workoutId), workout])
    );
    const results = [];
    const calculateStartedAt = performance.now();
    for (const segmentId of ids) {
      const segment = segmentsById.get(segmentId);
      if (!segment) continue;
      const pointCount = Number(segment.points_count);
      const distanceMeters = Number(segment.distance);
      const candidates = [];

      if (Number.isInteger(pointCount) && pointCount >= 2 && distanceMeters > 0) {
        for (const row of rowsBySegmentId.get(segmentId) || []) {
          const workoutId = Number(row.wid);
          const workout = workouts.get(workoutId);
          if (!workout) continue;
          try {
            const comparison = buildSegmentComparisonProfile(
              workout,
              row,
              distanceMeters,
              { maxPoints: Math.max(128, pointCount) }
            );
            const altitudes = normalizeWorkoutAltitudeProfile(comparison, pointCount, distanceMeters);
            if (altitudes) {
              candidates.push({ workoutId, startTime: row.start_time, altitudes });
            }
          } catch {
            // One corrupt candidate must not prevent the remaining profiles from being evaluated.
          }
        }
      }

      const result = selectDominantWorkoutAltitudeCluster(candidates, {
        radiusMeters: configuredNumber(
          "SEGMENT_ELEVATION_PROFILE_CLUSTER_RADIUS_METERS",
          DEFAULT_WORKOUT_ALTITUDE_CLUSTER_RADIUS_METERS,
          0.1
        ),
        minClusterSize: configuredNumber(
          "SEGMENT_ELEVATION_PROFILE_MIN_CLUSTER_SIZE",
          DEFAULT_WORKOUT_ALTITUDE_MIN_CLUSTER_SIZE,
          1
        ),
        minClusterFraction: configuredNumber(
          "SEGMENT_ELEVATION_PROFILE_MIN_CLUSTER_FRACTION",
          DEFAULT_WORKOUT_ALTITUDE_MIN_CLUSTER_FRACTION,
          0
        )
      });
      if (!result.confirmed && this.hasConfirmedStoredProfile(segment)) {
        const retained = persist ? await this.retainConfirmedResult(segmentId) : null;
        results.push(persist
          ? (retained && { ...retained, retained: true })
          : {
              id: segmentId,
              uid: Number(segment.uid),
              workout_altitude_status: "confirmed",
              retained: true
            });
      } else {
        const status = result.confirmed
          ? "confirmed"
          : (result.candidates.length > 0 ? "candidate" : "unavailable");
        results.push(persist
          ? { ...await this.persistResult(segmentId, result), retained: false }
          : {
              id: segmentId,
              uid: Number(segment.uid),
              workout_altitude_status: status,
              candidate_count: result.candidates.length,
              cluster_count: result.cluster.length,
              dispersion_meters: result.dispersionMeters,
              source_workout_id: result.medoid?.workoutId ?? null,
              retained: false
            });
      }
    }
    const calculateAndPersistMs = performance.now() - calculateStartedAt;
    console.log("[postprocess] segment-elevation-profiles.batch", {
      requestedSegmentCount: ids.length,
      loadedSegmentCount: segmentsById.size,
      candidateRowCount: candidateRows.length,
      uniqueWorkoutCount: workoutIds.length,
      persist,
      loadCandidatesMs: Math.round(loadCandidatesMs),
      loadWorkoutsMs: Math.round(loadWorkoutsMs),
      calculateAndPersistMs: Math.round(calculateAndPersistMs),
      totalMs: Math.round(performance.now() - startedAt)
    });
    return results.filter(Boolean);
  }

  static async rebuildSegment(segmentId) {
    const [result] = await this.rebuildSegments([segmentId]);
    return result || null;
  }

  static async rebuildPendingSegments(segmentIds) {
    const ids = [...new Set((Array.isArray(segmentIds) ? segmentIds : [])
      .map(Number)
      .filter((segmentId) => Number.isInteger(segmentId) && segmentId > 0))];
    if (ids.length === 0) return [];

    const pending = await pool.query(`
      SELECT id
      FROM gps_segments
      WHERE id = ANY($1::bigint[])
        AND workout_altitude_status IN ('candidate', 'stale')
      ORDER BY id
    `, [ids]);
    return this.rebuildSegments(pending.rows.map((row) => Number(row.id)));
  }
}
