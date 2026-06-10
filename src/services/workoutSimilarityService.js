import SegmentMatcher from "./SegmentMatcher.js";
import WorkoutDBService from "./workoutDBService.js";

export default class WorkoutSimilarityService {
  static MATCH_TYPE_GPS_ROUTE = "gps_route";
  static DEBUG = String(process.env.SIMILARITY_DEBUG || "").trim() === "1";

  static debug(message, payload = {}) {
    if (!this.DEBUG) {
      return;
    }

    console.log(`[similarity-debug] ${message}`, payload);
  }

  static normalizeTrackGeoJson(trackGeoJson) {
    const coordinates = trackGeoJson?.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) {
      return [];
    }

    return coordinates
      .map(([lng, lat]) => ({
        lat: Number(lat),
        lng: Number(lng)
      }))
      .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));
  }

  static buildSampledPoints(track = [], step = 10) {
    if (!Array.isArray(track) || track.length < 2) {
      return [];
    }

    const sampled = [];
    for (let index = 0; index < track.length; index += Math.max(1, step)) {
      sampled.push(track[index]);
    }

    const lastPoint = track[track.length - 1];
    if (sampled.length === 0 || sampled[sampled.length - 1] !== lastPoint) {
      sampled.push(lastPoint);
    }

    return sampled;
  }

  static buildControlPoints(track = [], sampleRateSeconds = 5) {
    if (!Array.isArray(track) || track.length < 2) {
      return [];
    }

    const warmupSkipPoints = Math.max(1, Math.round(60 / Math.max(1, sampleRateSeconds)));
    const startIndex = Math.min(track.length - 1, warmupSkipPoints);
    const checkpoints = [
      startIndex,
      Math.floor(track.length * 0.25),
      Math.floor(track.length * 0.5),
      Math.floor(track.length * 0.75),
      track.length - 1
    ];

    return [...new Set(
      checkpoints
        .map((index) => track[Math.max(0, Math.min(track.length - 1, index))])
        .filter(Boolean)
    )];
  }

  static computePointMatchRatio(sampledPoints, polyline, maxDistanceMeters = 20, options = {}) {
    if (!Array.isArray(sampledPoints) || sampledPoints.length === 0 || !Array.isArray(polyline) || polyline.length < 2) {
      return 0;
    }

    const minRequiredRatioRaw = Number(options.minRequiredRatio);
    const minRequiredRatio = Number.isFinite(minRequiredRatioRaw)
      ? Math.max(0, Math.min(1, minRequiredRatioRaw))
      : null;
    const hardAbortDistanceRaw = Number(options.hardAbortDistanceMeters);
    const hardAbortDistanceMeters = Number.isFinite(hardAbortDistanceRaw) && hardAbortDistanceRaw > maxDistanceMeters
      ? hardAbortDistanceRaw
      : null;

    let matched = 0;
    for (let index = 0; index < sampledPoints.length; index += 1) {
      const point = sampledPoints[index];
      const distance = SegmentMatcher.pointToPolylineDistance(point, polyline);
      if (hardAbortDistanceMeters !== null && distance > hardAbortDistanceMeters) {
        return matched / sampledPoints.length;
      }

      if (distance <= maxDistanceMeters) {
        matched += 1;
      }

      if (minRequiredRatio !== null) {
        const remainingPoints = sampledPoints.length - (index + 1);
        const maxPossibleRatio = (matched + remainingPoints) / sampledPoints.length;
        if (maxPossibleRatio < minRequiredRatio) {
          return matched / sampledPoints.length;
        }
      }
    }

    return matched / sampledPoints.length;
  }

  static computeRequiredRouteOverlap({
    minScore,
    distanceDeltaRatio,
    ascentDeltaRatio
  }) {
    const distanceScore = Math.max(0, 1 - Number(distanceDeltaRatio || 0));
    const ascentScore = Math.max(0, 1 - Number(ascentDeltaRatio || 0));
    const nonRouteContribution = distanceScore * 0.2 + ascentScore * 0.1;

    return Math.max(0, Math.min(1, (Number(minScore || 0) - nonRouteContribution) / 0.7));
  }

  static buildScore({
    pointMatchRatioAB,
    pointMatchRatioBA,
    distanceDeltaRatio,
    ascentDeltaRatio
  }) {
    const routeOverlapScore = Math.min(pointMatchRatioAB, pointMatchRatioBA);
    const distanceScore = Math.max(0, 1 - Number(distanceDeltaRatio || 0));
    const ascentScore = Math.max(0, 1 - Number(ascentDeltaRatio || 0));

    return (
      routeOverlapScore * 0.7 +
      distanceScore * 0.2 +
      ascentScore * 0.1
    );
  }

  static passesCheapPrecheck(sourceTrack, candidateTrack, options = {}) {
    const {
      sourceSampleRateSeconds = 5,
      candidateSampleRateSeconds = 5,
      cheapPrecheckDistanceMeters = 40,
      cheapPrecheckMinRatio = 0.6
    } = options;

    const sourceControlPoints = this.buildControlPoints(sourceTrack, sourceSampleRateSeconds);
    const candidateControlPoints = this.buildControlPoints(candidateTrack, candidateSampleRateSeconds);
    const sourceRatio = this.computePointMatchRatio(sourceControlPoints, candidateTrack, cheapPrecheckDistanceMeters);
    const candidateRatio = this.computePointMatchRatio(candidateControlPoints, sourceTrack, cheapPrecheckDistanceMeters);

    return {
      passes: sourceRatio >= cheapPrecheckMinRatio && candidateRatio >= cheapPrecheckMinRatio,
      sourceRatio,
      candidateRatio
    };
  }

  static async classifySimilarGpsWorkoutsForWorkout(sourceWorkoutId, uid, options = {}) {
    const {
      distanceToleranceRatio = 0.04,
      ascentToleranceRatio = 0.05,
      endpointRadiusMeters = 200,
      startRadiusMeters = 200,
      endRadiusMeters = 90,
      sampleEveryNthPoint = 10,
      maxPointToLineDistanceMeters = 20,
      cheapPrecheckDistanceMeters = 40,
      cheapPrecheckMinRatio = 0.6,
      minScore = 0.8,
      hardAbortDistanceMeters = 140,
      rebuildMode = "full",
      deleteExistingEdgesPerWorkout = null,
      onlyHigherWorkoutIds = false
    } = options;
    const normalizedRebuildMode = String(rebuildMode || "full").trim().toLowerCase() === "delta"
      ? "delta"
      : "full";
    const shouldSkipExistingEdges = normalizedRebuildMode === "delta";
    const shouldDeleteExistingEdges = typeof deleteExistingEdgesPerWorkout === "boolean"
      ? deleteExistingEdgesPerWorkout
      : normalizedRebuildMode === "full";

    const startedAt = Date.now();

    const sourceTrackRow = await WorkoutDBService.getTrack(sourceWorkoutId, uid);
    const sourceTrack = this.normalizeTrackGeoJson(sourceTrackRow?.track);
    if (sourceTrack.length < 2) {
      if (shouldDeleteExistingEdges) {
        await WorkoutDBService.deleteSimilarityEdgesForWorkout(
          sourceWorkoutId,
          uid,
          this.MATCH_TYPE_GPS_ROUTE
        );
      }
      return [];
    }

    const candidates = await WorkoutDBService.getSimilarRouteCandidates(sourceWorkoutId, uid, {
      distanceToleranceRatio,
      ascentToleranceRatio,
      endpointRadiusMeters,
      startRadiusMeters,
      endRadiusMeters,
      minCandidateWorkoutId: onlyHigherWorkoutIds ? Number(sourceWorkoutId) : null,
      skipExistingEdgeMatchType: shouldSkipExistingEdges ? this.MATCH_TYPE_GPS_ROUTE : null
    });

    if (shouldDeleteExistingEdges) {
      await WorkoutDBService.deleteSimilarityEdgesForWorkout(
        sourceWorkoutId,
        uid,
        this.MATCH_TYPE_GPS_ROUTE
      );
    }

    const sampledSourcePoints = this.buildSampledPoints(sourceTrack, sampleEveryNthPoint);
    const persistedEdges = [];
    let comparedCandidates = 0;
    let precheckRejectedCandidates = 0;
    let matchedCandidates = 0;
    const sourceSampleRateSeconds = Number(sourceTrackRow?.samplerategps ?? sourceTrackRow?.sampleRateGPS ?? 5) || 5;

    for (const candidate of candidates) {
      comparedCandidates += 1;
      const candidateTrack = this.normalizeTrackGeoJson(candidate.track);
      if (candidateTrack.length < 2) {
        continue;
      }

      const cheapPrecheck = this.passesCheapPrecheck(sourceTrack, candidateTrack, {
        sourceSampleRateSeconds,
        candidateSampleRateSeconds: Number(candidate?.samplerategps ?? candidate?.sampleRateGPS ?? 5) || 5,
        cheapPrecheckDistanceMeters,
        cheapPrecheckMinRatio
      });
      if (!cheapPrecheck.passes) {
        precheckRejectedCandidates += 1;
        continue;
      }

      const sampledCandidatePoints = this.buildSampledPoints(candidateTrack, sampleEveryNthPoint);
      const minRequiredRouteOverlap = this.computeRequiredRouteOverlap({
        minScore,
        distanceDeltaRatio: candidate.distance_delta_ratio,
        ascentDeltaRatio: candidate.ascent_delta_ratio
      });

      const pointMatchRatioAB = this.computePointMatchRatio(
        sampledSourcePoints,
        candidateTrack,
        maxPointToLineDistanceMeters,
        {
          minRequiredRatio: minRequiredRouteOverlap,
          hardAbortDistanceMeters
        }
      );
      if (pointMatchRatioAB < minRequiredRouteOverlap) {
        continue;
      }

      const pointMatchRatioBA = this.computePointMatchRatio(
        sampledCandidatePoints,
        sourceTrack,
        maxPointToLineDistanceMeters,
        {
          minRequiredRatio: minRequiredRouteOverlap,
          hardAbortDistanceMeters
        }
      );
      if (pointMatchRatioBA < minRequiredRouteOverlap) {
        continue;
      }

      const score = this.buildScore({
        pointMatchRatioAB,
        pointMatchRatioBA,
        distanceDeltaRatio: candidate.distance_delta_ratio,
        ascentDeltaRatio: candidate.ascent_delta_ratio
      });

      if (score < minScore) {
        continue;
      }

      matchedCandidates += 1;

      const edge = await WorkoutDBService.upsertSimilarityEdge({
        uid,
        workoutIdA: Number(sourceWorkoutId),
        workoutIdB: Number(candidate.id),
        matchType: this.MATCH_TYPE_GPS_ROUTE,
        score,
        distanceDeltaRatio: candidate.distance_delta_ratio,
        ascentDeltaRatio: candidate.ascent_delta_ratio,
        startDistanceM: candidate.start_distance_m,
        endDistanceM: candidate.end_distance_m,
        pointMatchRatioAB,
        pointMatchRatioBA
      });

      if (edge) {
        persistedEdges.push(edge);
      }
    }

    this.debug("classify-workout", {
      uid,
      sourceWorkoutId: Number(sourceWorkoutId),
      candidateCount: candidates.length,
      comparedCandidates,
      precheckRejectedCandidates,
      matchedCandidates,
      persistedEdges: persistedEdges.length,
      rebuildMode: normalizedRebuildMode,
      onlyHigherWorkoutIds,
      elapsedMs: Date.now() - startedAt
    });

    return persistedEdges;
  }

  static async classifySimilarGpsWorkoutsForUser(uid, options = {}) {
    const { onProgress } = options;
    const rebuildMode = String(options?.rebuildMode || "full").trim().toLowerCase() === "delta"
      ? "delta"
      : "full";
    const workoutIds = await WorkoutDBService.getOwnGpsWorkoutIds(uid);
    let totalEdges = 0;
    let processedWorkouts = 0;

    if (rebuildMode === "full") {
      await WorkoutDBService.deleteSimilarityEdgesForUser(uid, this.MATCH_TYPE_GPS_ROUTE);
    }

    for (const workoutId of workoutIds) {
      const edges = await this.classifySimilarGpsWorkoutsForWorkout(workoutId, uid, {
        ...options,
        rebuildMode,
        deleteExistingEdgesPerWorkout: false,
        onlyHigherWorkoutIds: true
      });
      totalEdges += Array.isArray(edges) ? edges.length : 0;
      processedWorkouts += 1;

      if (typeof onProgress === "function") {
        await onProgress({
          workoutCount: workoutIds.length,
          processedWorkouts,
          edgeCount: totalEdges,
          progressPercent: workoutIds.length > 0
            ? Math.round((processedWorkouts / workoutIds.length) * 100)
            : 100
        });
      }
    }

    return {
      workoutCount: workoutIds.length,
      processedWorkouts,
      edgeCount: totalEdges
    };
  }
}
