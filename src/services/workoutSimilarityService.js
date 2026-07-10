import SegmentMatcher from "./SegmentMatcher.js";
import WorkoutDBService from "./workoutDBService.js";
import { DEFAULT_GPS_SAMPLE_RATE_SECONDS, normalizeGpsSampleRateSeconds } from "../shared/gpsSampling.js";

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

  static createProjectionContext(track = []) {
    if (!Array.isArray(track) || track.length < 2) {
      return null;
    }

    let latSum = 0;
    for (let index = 0; index < track.length; index += 1) {
      latSum += Number(track[index]?.lat || 0);
    }
    const avgLatDeg = latSum / track.length;
    return {
      metersPerDegLat: 111320,
      metersPerDegLng: Math.cos(avgLatDeg * Math.PI / 180) * 111320,
      originLat: Number(track[0]?.lat || 0),
      originLng: Number(track[0]?.lng || 0)
    };
  }

  static buildProjectedTrack(track = [], projectionContext = null) {
    if (!Array.isArray(track) || track.length < 2) {
      return null;
    }

    const context = projectionContext || this.createProjectionContext(track);
    if (!context) {
      return null;
    }

    const {
      metersPerDegLat,
      metersPerDegLng,
      originLat,
      originLng
    } = context;
    const xs = new Float64Array(track.length);
    const ys = new Float64Array(track.length);

    for (let index = 0; index < track.length; index += 1) {
      const point = track[index];
      xs[index] = (Number(point?.lng || 0) - originLng) * metersPerDegLng;
      ys[index] = (Number(point?.lat || 0) - originLat) * metersPerDegLat;
    }

    return {
      track,
      xs,
      ys,
      projectionContext: context
    };
  }

  static buildSampledProjectedPoints(projectedTrack, step = 10) {
    if (!projectedTrack?.xs || projectedTrack.xs.length < 2) {
      return { xs: new Float64Array(0), ys: new Float64Array(0) };
    }

    const normalizedStep = Math.max(1, Number(step) || 1);
    const lastIndex = projectedTrack.xs.length - 1;
    const sampledIndices = [];

    for (let index = 0; index < projectedTrack.xs.length; index += normalizedStep) {
      sampledIndices.push(index);
    }
    if (sampledIndices.length === 0 || sampledIndices[sampledIndices.length - 1] !== lastIndex) {
      sampledIndices.push(lastIndex);
    }

    const sampledXs = new Float64Array(sampledIndices.length);
    const sampledYs = new Float64Array(sampledIndices.length);
    for (let index = 0; index < sampledIndices.length; index += 1) {
      const sourceIndex = sampledIndices[index];
      sampledXs[index] = projectedTrack.xs[sourceIndex];
      sampledYs[index] = projectedTrack.ys[sourceIndex];
    }

    return {
      xs: sampledXs,
      ys: sampledYs
    };
  }

  static buildControlPoints(track = [], sampleRateSeconds = DEFAULT_GPS_SAMPLE_RATE_SECONDS) {
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

  static buildControlPointIndices(trackLength = 0, sampleRateSeconds = DEFAULT_GPS_SAMPLE_RATE_SECONDS) {
    if (!Number.isFinite(trackLength) || trackLength < 2) {
      return [];
    }

    const warmupSkipPoints = Math.max(1, Math.round(60 / Math.max(1, sampleRateSeconds)));
    const startIndex = Math.min(trackLength - 1, warmupSkipPoints);
    const checkpoints = [
      startIndex,
      Math.floor(trackLength * 0.25),
      Math.floor(trackLength * 0.5),
      Math.floor(trackLength * 0.75),
      trackLength - 1
    ];

    return [...new Set(
      checkpoints
        .map((index) => Math.max(0, Math.min(trackLength - 1, index)))
        .filter((index) => Number.isInteger(index))
    )];
  }

  static buildProjectedControlPoints(projectedTrack, sampleRateSeconds = DEFAULT_GPS_SAMPLE_RATE_SECONDS) {
    if (!projectedTrack?.xs || projectedTrack.xs.length < 2) {
      return { xs: new Float64Array(0), ys: new Float64Array(0) };
    }

    const indices = this.buildControlPointIndices(projectedTrack.xs.length, sampleRateSeconds);
    const xs = new Float64Array(indices.length);
    const ys = new Float64Array(indices.length);
    for (let index = 0; index < indices.length; index += 1) {
      const sourceIndex = indices[index];
      xs[index] = projectedTrack.xs[sourceIndex];
      ys[index] = projectedTrack.ys[sourceIndex];
    }

    return { xs, ys };
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

  static computePointMatchRatioProjected(sampledPoints, projectedPolyline, maxDistanceMeters = 20, options = {}) {
    const sampledXs = sampledPoints?.xs;
    const sampledYs = sampledPoints?.ys;
    const polylineXs = projectedPolyline?.xs;
    const polylineYs = projectedPolyline?.ys;
    if (
      !(sampledXs instanceof Float64Array) ||
      !(sampledYs instanceof Float64Array) ||
      !(polylineXs instanceof Float64Array) ||
      !(polylineYs instanceof Float64Array) ||
      sampledXs.length === 0 ||
      polylineXs.length < 2
    ) {
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
    const maxDistanceSquared = maxDistanceMeters * maxDistanceMeters;
    const hardAbortDistanceSquared = hardAbortDistanceMeters !== null
      ? hardAbortDistanceMeters * hardAbortDistanceMeters
      : null;

    let matched = 0;
    for (let pointIndex = 0; pointIndex < sampledXs.length; pointIndex += 1) {
      const px = sampledXs[pointIndex];
      const py = sampledYs[pointIndex];
      let minDistanceSquared = Infinity;

      for (let segmentIndex = 0; segmentIndex < polylineXs.length - 1; segmentIndex += 1) {
        const ax = polylineXs[segmentIndex];
        const ay = polylineYs[segmentIndex];
        const bx = polylineXs[segmentIndex + 1];
        const by = polylineYs[segmentIndex + 1];
        const dx = bx - ax;
        const dy = by - ay;

        let distanceSquared;
        if (dx === 0 && dy === 0) {
          const ddx = px - ax;
          const ddy = py - ay;
          distanceSquared = ddx * ddx + ddy * ddy;
        } else {
          const t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy);
          const clamped = t < 0 ? 0 : (t > 1 ? 1 : t);
          const projX = ax + clamped * dx;
          const projY = ay + clamped * dy;
          const ddx = px - projX;
          const ddy = py - projY;
          distanceSquared = ddx * ddx + ddy * ddy;
        }

        if (distanceSquared < minDistanceSquared) {
          minDistanceSquared = distanceSquared;
          if (minDistanceSquared <= maxDistanceSquared) {
            break;
          }
        }
      }

      if (hardAbortDistanceSquared !== null && minDistanceSquared > hardAbortDistanceSquared) {
        return matched / sampledXs.length;
      }

      if (minDistanceSquared <= maxDistanceSquared) {
        matched += 1;
      }

      if (minRequiredRatio !== null) {
        const remainingPoints = sampledXs.length - (pointIndex + 1);
        const maxPossibleRatio = (matched + remainingPoints) / sampledXs.length;
        if (maxPossibleRatio < minRequiredRatio) {
          return matched / sampledXs.length;
        }
      }
    }

    return matched / sampledXs.length;
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
      sourceSampleRateSeconds = DEFAULT_GPS_SAMPLE_RATE_SECONDS,
      candidateSampleRateSeconds = DEFAULT_GPS_SAMPLE_RATE_SECONDS,
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

  static passesCheapPrecheckProjected(sourceProjectedTrack, candidateProjectedTrack, options = {}) {
    const {
      sourceSampleRateSeconds = DEFAULT_GPS_SAMPLE_RATE_SECONDS,
      candidateSampleRateSeconds = DEFAULT_GPS_SAMPLE_RATE_SECONDS,
      cheapPrecheckDistanceMeters = 40,
      cheapPrecheckMinRatio = 0.6
    } = options;

    const sourceControlPoints = this.buildProjectedControlPoints(sourceProjectedTrack, sourceSampleRateSeconds);
    const candidateControlPoints = this.buildProjectedControlPoints(candidateProjectedTrack, candidateSampleRateSeconds);
    const sourceRatio = this.computePointMatchRatioProjected(
      sourceControlPoints,
      candidateProjectedTrack,
      cheapPrecheckDistanceMeters
    );
    const candidateRatio = this.computePointMatchRatioProjected(
      candidateControlPoints,
      sourceProjectedTrack,
      cheapPrecheckDistanceMeters
    );

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
      onlyHigherWorkoutIds = false,
      includeProfile = false
    } = options;
    const normalizedRebuildMode = String(rebuildMode || "full").trim().toLowerCase() === "delta"
      ? "delta"
      : "full";
    const shouldSkipExistingEdges = normalizedRebuildMode === "delta";
    const shouldDeleteExistingEdges = typeof deleteExistingEdgesPerWorkout === "boolean"
      ? deleteExistingEdgesPerWorkout
      : normalizedRebuildMode === "full";

    const startedAt = Date.now();
    let loadSourceTrackMs = 0;
    let loadCandidatesMs = 0;
    let deleteExistingEdgesMs = 0;
    let sampleSourceTrackMs = 0;
    let candidateTrackNormalizeMs = 0;
    let cheapPrecheckMs = 0;
    let sampleCandidateTrackMs = 0;
    let compareRouteMs = 0;
    let compareRouteABMs = 0;
    let compareRouteBAMs = 0;
    let scoreMs = 0;
    let persistEdgeMs = 0;
    let rejectedByRouteAB = 0;
    let rejectedByRouteBA = 0;
    let rejectedByScore = 0;

    const loadSourceTrackStartedAt = Date.now();
    const sourceTrackRow = await WorkoutDBService.getTrack(sourceWorkoutId, uid);
    loadSourceTrackMs = Date.now() - loadSourceTrackStartedAt;
    const sourceTrack = Array.isArray(sourceTrackRow?.trackPoints)
      ? sourceTrackRow.trackPoints
      : this.normalizeTrackGeoJson(sourceTrackRow?.track);
    if (sourceTrack.length < 2) {
      if (shouldDeleteExistingEdges) {
        const deleteExistingEdgesStartedAt = Date.now();
        await WorkoutDBService.deleteSimilarityEdgesForWorkout(
          sourceWorkoutId,
          uid,
          this.MATCH_TYPE_GPS_ROUTE
        );
        deleteExistingEdgesMs = Date.now() - deleteExistingEdgesStartedAt;
      }
      return includeProfile
        ? {
            edges: [],
            profile: {
              candidateCount: 0,
              comparedCandidates: 0,
              precheckRejectedCandidates: 0,
              matchedCandidates: 0,
              persistedEdges: 0,
              elapsedMs: Date.now() - startedAt,
              loadSourceTrackMs,
              loadCandidatesMs,
              deleteExistingEdgesMs,
              sampleSourceTrackMs,
              candidateTrackNormalizeMs,
              cheapPrecheckMs,
              sampleCandidateTrackMs,
              compareRouteMs,
              compareRouteABMs,
              compareRouteBAMs,
              scoreMs,
              persistEdgeMs,
              rejectedByRouteAB,
              rejectedByRouteBA,
              rejectedByScore
            }
          }
        : [];
    }

    const loadCandidatesStartedAt = Date.now();
    const candidates = await WorkoutDBService.getSimilarRouteCandidates(sourceWorkoutId, uid, {
      distanceToleranceRatio,
      ascentToleranceRatio,
      endpointRadiusMeters,
      startRadiusMeters,
      endRadiusMeters,
      minCandidateWorkoutId: onlyHigherWorkoutIds ? Number(sourceWorkoutId) : null,
      skipExistingEdgeMatchType: shouldSkipExistingEdges ? this.MATCH_TYPE_GPS_ROUTE : null
    });
    loadCandidatesMs = Date.now() - loadCandidatesStartedAt;

    if (shouldDeleteExistingEdges) {
      const deleteExistingEdgesStartedAt = Date.now();
      await WorkoutDBService.deleteSimilarityEdgesForWorkout(
        sourceWorkoutId,
        uid,
        this.MATCH_TYPE_GPS_ROUTE
      );
      deleteExistingEdgesMs += Date.now() - deleteExistingEdgesStartedAt;
    }

    const sampleSourceTrackStartedAt = Date.now();
    const projectionContext = this.createProjectionContext(sourceTrack);
    const projectedSourceTrack = this.buildProjectedTrack(sourceTrack, projectionContext);
    const sampledSourcePoints = this.buildSampledProjectedPoints(projectedSourceTrack, sampleEveryNthPoint);
    sampleSourceTrackMs = Date.now() - sampleSourceTrackStartedAt;
    const similarityEdgesToPersist = [];
    let persistedEdges = [];
    let comparedCandidates = 0;
    let precheckRejectedCandidates = 0;
    let matchedCandidates = 0;
    const sourceSampleRateSeconds = normalizeGpsSampleRateSeconds(
      sourceTrackRow?.samplerategps ?? sourceTrackRow?.sampleRateGPS,
      DEFAULT_GPS_SAMPLE_RATE_SECONDS
    );

    for (const candidate of candidates) {
      comparedCandidates += 1;
      const normalizeCandidateTrackStartedAt = Date.now();
      const candidateTrack = Array.isArray(candidate?.trackPoints)
        ? candidate.trackPoints
        : this.normalizeTrackGeoJson(candidate.track);
      candidateTrackNormalizeMs += Date.now() - normalizeCandidateTrackStartedAt;
      if (candidateTrack.length < 2) {
        continue;
      }

      const cheapPrecheckStartedAt = Date.now();
      const projectedCandidateTrack = this.buildProjectedTrack(candidateTrack, projectionContext);
      const cheapPrecheck = this.passesCheapPrecheckProjected(projectedSourceTrack, projectedCandidateTrack, {
        sourceSampleRateSeconds,
        candidateSampleRateSeconds: normalizeGpsSampleRateSeconds(
          candidate?.samplerategps ?? candidate?.sampleRateGPS,
          DEFAULT_GPS_SAMPLE_RATE_SECONDS
        ),
        cheapPrecheckDistanceMeters,
        cheapPrecheckMinRatio
      });
      cheapPrecheckMs += Date.now() - cheapPrecheckStartedAt;
      if (!cheapPrecheck.passes) {
        precheckRejectedCandidates += 1;
        continue;
      }

      const sampleCandidateTrackStartedAt = Date.now();
      const sampledCandidatePoints = this.buildSampledProjectedPoints(projectedCandidateTrack, sampleEveryNthPoint);
      sampleCandidateTrackMs += Date.now() - sampleCandidateTrackStartedAt;
      const minRequiredRouteOverlap = this.computeRequiredRouteOverlap({
        minScore,
        distanceDeltaRatio: candidate.distance_delta_ratio,
        ascentDeltaRatio: candidate.ascent_delta_ratio
      });

      const compareRouteABStartedAt = Date.now();
      const pointMatchRatioAB = this.computePointMatchRatioProjected(
        sampledSourcePoints,
        projectedCandidateTrack,
        maxPointToLineDistanceMeters,
        {
          minRequiredRatio: minRequiredRouteOverlap,
          hardAbortDistanceMeters
        }
      );
      const compareRouteABElapsedMs = Date.now() - compareRouteABStartedAt;
      compareRouteABMs += compareRouteABElapsedMs;
      compareRouteMs += compareRouteABElapsedMs;
      if (pointMatchRatioAB < minRequiredRouteOverlap) {
        rejectedByRouteAB += 1;
        continue;
      }

      const compareRouteBAStartedAt = Date.now();
      const pointMatchRatioBA = this.computePointMatchRatioProjected(
        sampledCandidatePoints,
        projectedSourceTrack,
        maxPointToLineDistanceMeters,
        {
          minRequiredRatio: minRequiredRouteOverlap,
          hardAbortDistanceMeters
        }
      );
      const compareRouteBAElapsedMs = Date.now() - compareRouteBAStartedAt;
      compareRouteBAMs += compareRouteBAElapsedMs;
      compareRouteMs += compareRouteBAElapsedMs;
      if (pointMatchRatioBA < minRequiredRouteOverlap) {
        rejectedByRouteBA += 1;
        continue;
      }

      const scoreStartedAt = Date.now();
      const score = this.buildScore({
        pointMatchRatioAB,
        pointMatchRatioBA,
        distanceDeltaRatio: candidate.distance_delta_ratio,
        ascentDeltaRatio: candidate.ascent_delta_ratio
      });
      scoreMs += Date.now() - scoreStartedAt;

      if (score < minScore) {
        rejectedByScore += 1;
        continue;
      }

      matchedCandidates += 1;
      similarityEdgesToPersist.push({
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
    }

    if (similarityEdgesToPersist.length > 0) {
      const persistEdgeStartedAt = Date.now();
      persistedEdges = await WorkoutDBService.upsertSimilarityEdgesBulk(similarityEdgesToPersist);
      persistEdgeMs += Date.now() - persistEdgeStartedAt;
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

    if (includeProfile) {
      return {
        edges: persistedEdges,
        profile: {
          candidateCount: candidates.length,
          comparedCandidates,
          precheckRejectedCandidates,
          matchedCandidates,
          persistedEdges: persistedEdges.length,
          elapsedMs: Date.now() - startedAt,
          loadSourceTrackMs,
          loadCandidatesMs,
          deleteExistingEdgesMs,
          sampleSourceTrackMs,
          candidateTrackNormalizeMs,
          cheapPrecheckMs,
          sampleCandidateTrackMs,
          compareRouteMs,
          compareRouteABMs,
          compareRouteBAMs,
          scoreMs,
          persistEdgeMs,
          rejectedByRouteAB,
          rejectedByRouteBA,
          rejectedByScore
        }
      };
    }

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
