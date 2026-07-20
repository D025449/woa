import express from "express";

import authMiddleware from "../middleware/authMiddleware.js";
import requireActiveAccountWrite from "../middleware/requireActiveAccountWrite.js";
import pool from "../services/database.js";
import { FileDBService } from "../services/fileDBService.js";
import WorkoutDBService from "../services/workoutDBService.js";
import CollaborationDBService from "../services/collaborationDBService.js";
import WorkoutSharingService from "../services/workoutSharingService.js";
import { DEFAULT_GPS_SAMPLE_RATE_SECONDS, normalizeGpsSampleRateSeconds } from "../shared/gpsSampling.js";
import SegmentDBService from "../services/segmentDBService.js";
import { enqueueSegmentBestEfforts } from "../services/segment-best-efforts-service.js";
import FitExportService from "../services/fitExportService.js";
import WorkoutThumbnailService from "../services/workoutThumbnailService.js";
import WorkoutSimilarityService from "../services/workoutSimilarityService.js";
import { fetchBicycleRoute } from "../services/bicycleRoutingService.js";
import WorkoutOpenV2 from "../shared/WorkoutOpenV2.js";

const router = express.Router();
const FEATURE_THUMBNAILS_ON_DEMAND = String(process.env.FEATURE_THUMBNAILS_ON_DEMAND || "1").trim() !== "0";
const WORKOUT_OPEN_PROFILE_LOG = String(process.env.WORKOUT_OPEN_PROFILE_LOG || "0").trim() === "1";

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

async function lookupManualWorkoutRoute(points = []) {
  const normalizedPoints = points.map((point) => ({
    lat: Number(point?.lat),
    lng: Number(point?.lng)
  }));

  if (normalizedPoints.length < 2 || normalizedPoints.some((point) => !Number.isFinite(point.lat) || !Number.isFinite(point.lng))) {
    const error = new Error("At least two valid route points are required.");
    error.statusCode = 400;
    throw error;
  }

  const route = await fetchBicycleRoute(normalizedPoints);
  const track = Array.isArray(route?.geometry?.coordinates)
    ? route.geometry.coordinates.map(([lng, lat]) => ({ lat: Number(lat), lng: Number(lng) }))
    : [];

  if (track.length < 2) {
    const error = new Error("Route lookup returned too few track points.");
    error.statusCode = 422;
    throw error;
  }

  return {
    distanceMeters: Number(route.distance) || computeTrackDistanceMeters(track),
    track
  };
}

function formatFitExportFileName(startTimeValue, fallbackId) {
  const date = new Date(startTimeValue);
  if (Number.isNaN(date.getTime())) {
    return `workout-${fallbackId}.fit`;
  }

  const pad = (value) => String(value).padStart(2, "0");
  const yyyy = date.getFullYear();
  const MM = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const HH = pad(date.getHours());
  const mm = pad(date.getMinutes());
  const ss = pad(date.getSeconds());

  return `${yyyy}-${MM}-${dd}-${HH}-${mm}-${ss}.fit`;
}

router.get("/:id/export.fit", authMiddleware, async (req, res) => {
  try {
    const workoutId = Number(req.params.id);
    const uid = req.user?.id;

    if (!Number.isFinite(workoutId) || workoutId <= 0) {
      return res.status(400).json({ error: "Invalid workout id" });
    }

    const accessInfo = await WorkoutSharingService.getAccessibleWorkout(uid, workoutId);
    if (!accessInfo?.is_owner) {
      return res.status(403).json({ error: "Only workout owners can export FIT files." });
    }

    const workout = await WorkoutDBService.getWorkout(workoutId);
    const workoutTrack = await WorkoutDBService.getTrack(workoutId, uid);
    const geoJsonCoordinates = Array.isArray(workoutTrack?.track?.coordinates)
      ? workoutTrack.track.coordinates
      : [];
    const gpsCoordinates = geoJsonCoordinates
      .filter((point) => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]))
      .map((point) => [Number(point[1]), Number(point[0])]); // GeoJSON [lng, lat] -> [lat, lng]
    const hasValidGps = !!(workoutTrack?.validgps ?? workoutTrack?.validGps);

    if (hasValidGps) {
      console.log("[fit-export] gps mapping", {
        workoutId,
        points: gpsCoordinates.length,
        sampleRateGps: workoutTrack?.samplerategps ?? null,
        firstPoint: gpsCoordinates[0] || null,
        lastPoint: gpsCoordinates[gpsCoordinates.length - 1] || null
      });
    }

    const fitBuffer = FitExportService.buildFitFromWorkout(workout, {
      serialNumber: workoutId,
      sampleRateGps: workoutTrack?.samplerategps,
      gpsCoordinates,
      includeGps: hasValidGps,
      gpsSource: workoutTrack?.gps_source ?? workoutTrack?.gpsSource ?? null
    });
    const fileName = formatFitExportFileName(
      typeof workout.getStartTime === "function" ? workout.getStartTime() : null,
      workoutId
    );

    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("Cache-Control", "no-store");
    return res.send(fitBuffer);
  } catch (err) {
    console.error("GET /workouts/:id/export.fit failed:", err);
    return res.status(err.statusCode || 500).json({
      error: err.message || "Failed to export workout as FIT"
    });
  }
});

router.get("/:id/sharing", authMiddleware, async (req, res) => {
  try {
    const workoutId = Number(req.params.id);
    const uid = req.user.id;
    const data = await WorkoutSharingService.getSharingForWorkout(uid, workoutId);
    return res.json({ data });
  } catch (err) {
    console.error("GET /workouts/:id/sharing failed:", err);
    return res.status(err.statusCode || 500).json({ error: err.message || "Failed to load workout sharing" });
  }
});

router.put("/:id/sharing", authMiddleware, requireActiveAccountWrite, async (req, res) => {
  try {
    const workoutId = Number(req.params.id);
    const uid = req.user.id;
    const data = await WorkoutSharingService.updateSharingForWorkout(uid, workoutId, req.body || {});
    if (Array.isArray(data.newlyPublishedGroupIds) && data.newlyPublishedGroupIds.length > 0) {
      const targets = await SegmentDBService.getSharedSegmentRescanTargetsForWorkout(
        workoutId,
        uid,
        data.newlyPublishedGroupIds
      );

      const groupedTargets = targets.reduce((acc, target) => {
        const ownerId = String(target.uid);
        if (!acc.has(ownerId)) {
          acc.set(ownerId, []);
        }
        acc.get(ownerId).push(target.id);
        return acc;
      }, new Map());

      await Promise.all(
        [...groupedTargets.entries()].map(([ownerId, segmentIds]) =>
          enqueueSegmentBestEfforts({
            uid: Number(ownerId),
            segmentIds
          })
        )
      );
    }
    return res.json({ ok: true, data });
  } catch (err) {
    console.error("PUT /workouts/:id/sharing failed:", err);
    return res.status(err.statusCode || 500).json({ error: err.message || "Failed to update workout sharing" });
  }
});

router.get("/:id/open-v2", authMiddleware, async (req, res) => {
  try {
    const startedAt = Date.now();
    const id = req.params.id;
    const uid = req.user.id;

    if (!id) {
      return res.status(400).json({ error: "Missing workout id" });
    }

    const accessStartedAt = Date.now();
    const accessInfo = await WorkoutSharingService.getAccessibleWorkout(uid, id);
    const accessMs = Date.now() - accessStartedAt;

    const payloadStartedAt = Date.now();
    const openPayload = await WorkoutDBService.getOpenPayloadRaw(id, uid);
    const payloadMs = Date.now() - payloadStartedAt;
    const row = openPayload?.row || null;
    const dbProfile = openPayload?.profile || {};

    const segmentsStartedAt = Date.now();
    const [segmentResult, gpsSegmentResult] = await Promise.all([
      FileDBService.getSegmentsByWorkout(uid, id),
      SegmentDBService.getGPSSegmentByWorkout(uid, id)
    ]);
    const segmentsMs = Date.now() - segmentsStartedAt;

    const responseBuildStartedAt = Date.now();
    const payload = WorkoutOpenV2.buildPayload({
      meta: {
        workoutId: Number(id),
        streamCodec: String(row.stream_codec || "brotli"),
        gpsTrackCodec: String(row.gps_track_blob_codec || "brotli"),
        validGps: !!(row?.validgps ?? row?.validGps),
        sampleRateGps: Number(row?.samplerategps ?? row?.sampleRateGPS ?? 0) || null,
        gpsSource: row.gps_source || null,
        manualGpsLookupPoints: Array.isArray(row.manual_gps_lookup_points) ? row.manual_gps_lookup_points : [],
        segmentProcessingStatus: row.segment_processing_status || "queued",
        segmentProcessingError: row.segment_processing_error || null,
        segmentProcessingUpdatedAt: row.segment_processing_updated_at || null,
        access: {
          isOwner: !!accessInfo.is_owner,
          ownerDisplayName: accessInfo.owner_display_name || null,
          ownerEmail: accessInfo.owner_email || null
        }
      },
      workoutStream: row?.stream || Buffer.alloc(0),
      gpsTrackBlob: row?.gps_track_blob || Buffer.alloc(0),
      segments: Array.isArray(segmentResult?.rows) ? segmentResult.rows : [],
      gpsSegments: Array.isArray(gpsSegmentResult?.rows) ? gpsSegmentResult.rows : []
    });
    const responseBuildMs = Date.now() - responseBuildStartedAt;

    if (WORKOUT_OPEN_PROFILE_LOG) {
      console.info("[workout-open] open-v2.profile", {
        workoutId: id,
        uid,
        accessMs,
        payloadMs,
        segmentsMs,
        queryMs: Number(dbProfile.queryMs || 0),
        responseBuildMs,
        streamCodec: String(row.stream_codec || "brotli"),
        gpsTrackCodec: String(row.gps_track_blob_codec || "brotli"),
        streamBytes: Number(row.stream_size || row?.stream?.length || 0),
        gpsTrackBlobBytes: Number(row.gps_track_blob_size || row?.gps_track_blob?.length || 0),
        segmentCount: Array.isArray(segmentResult?.rows) ? segmentResult.rows.length : 0,
        gpsSegmentCount: Array.isArray(gpsSegmentResult?.rows) ? gpsSegmentResult.rows.length : 0,
        payloadBytes: payload.byteLength,
        totalMs: Date.now() - startedAt
      });
    }

    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Cache-Control", "private, max-age=0, must-revalidate");
    return res.send(Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength));
  } catch (err) {
    console.error("Workout open v2 payload load error:", err);
    return res.status(err.statusCode || 500).json({ error: err.message || "Internal server error" });
  }
});

// GET /api/workouts/:id/stream
router.get("/:id/stream", authMiddleware, async (req, res) => {
  try {
    const startedAt = Date.now();
    const id = req.params.id;
    const uid = req.user.id;

    if (!id) {
      return res.status(400).json({ error: "Missing workout id" });
    }

    const streamRow = await WorkoutDBService.getStream(id, uid);
    const stream = streamRow.stream;
    const uploadedAtIso = streamRow.uploaded_at
      ? new Date(streamRow.uploaded_at).toISOString()
      : "";
    const streamSize = Number(streamRow.stream_size || stream?.length || 0);
    const etag = `"workout-stream-${id}-${uploadedAtIso}-${streamSize}"`;

    const ifNoneMatch = req.headers["if-none-match"];
    const clientEtags = typeof ifNoneMatch === "string"
      ? ifNoneMatch.split(",").map((v) => v.trim())
      : [];

    res.setHeader("ETag", etag);
    res.setHeader("Cache-Control", "private, max-age=0, must-revalidate");

    if (clientEtags.includes(etag) || clientEtags.includes("*")) {
      if (WORKOUT_OPEN_PROFILE_LOG) {
        console.info("[workout-open] stream.profile", {
          workoutId: id,
          uid,
          streamCodec: String(streamRow.stream_codec || "brotli"),
          streamBytes: streamSize,
          cacheHit304: true,
          totalMs: Date.now() - startedAt
        });
      }
      return res.status(304).end();
    }

    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Encoding", String(streamRow.stream_codec || "brotli") === "gzip" ? "gzip" : "br");
    if (WORKOUT_OPEN_PROFILE_LOG) {
      console.info("[workout-open] stream.profile", {
        workoutId: id,
        uid,
        streamCodec: String(streamRow.stream_codec || "brotli"),
        streamBytes: streamSize,
        cacheHit304: false,
        totalMs: Date.now() - startedAt
      });
    }
    return res.send(stream);

  } catch (err) {
    console.error("Stream load error:", err);
    return res.status(err.statusCode || 500).json({ error: err.message || "Internal server error" });
  }
});

router.get("/:id/track", authMiddleware, async (req, res) => {
  try {
    const startedAt = Date.now();
    const id = req.params.id;
    const uid = req.user.id;

    if (!id) {
      return res.status(400).json({ error: "Missing workout id" });
    }

    const accessInfo = await WorkoutSharingService.getAccessibleWorkout(uid, id);
    const row = await WorkoutDBService.getTrack(id, uid);

    //res.setHeader("Content-Type", "application/octet-stream");
    //res.setHeader("Content-Encoding", "br");
    //res.setHeader("Cache-Control", "no-store");

    // optional extra safety
    //res.setHeader("Pragma", "no-cache");
    //res.setHeader("Expires", "0");
    if (WORKOUT_OPEN_PROFILE_LOG) {
      const trackPoints = Array.isArray(row?.track?.coordinates) ? row.track.coordinates.length : 0;
      console.info("[workout-open] track.profile", {
        workoutId: id,
        uid,
        validGps: !!(row?.validgps ?? row?.validGps),
        sampleRateGps: Number(row?.samplerategps ?? row?.sampleRateGPS ?? 0) || null,
        trackPoints,
        totalMs: Date.now() - startedAt
      });
    }
    return res.json({
      ...row,
      access: {
        isOwner: !!accessInfo.is_owner,
        ownerDisplayName: accessInfo.owner_display_name || null,
        ownerEmail: accessInfo.owner_email || null
      }
    });

  } catch (err) {
    console.error("Track load error:", err);
    return res.status(err.statusCode || 500).json({ error: err.message || "Internal server error" });
  }
});

router.post("/:id/manual-gps", authMiddleware, requireActiveAccountWrite, async (req, res) => {
  try {
    const workoutId = Number(req.params.id);
    const uid = req.user?.id;
    const lookupPoints = Array.isArray(req.body?.points) ? req.body.points : [];

    if (!Number.isFinite(workoutId) || workoutId <= 0) {
      return res.status(400).json({ error: "Invalid workout id" });
    }

    const context = await WorkoutDBService.getManualGpsContext(workoutId, uid);
    const routeLookup = await lookupManualWorkoutRoute(lookupPoints);
    const workoutDistanceMeters = Number(context.total_distance)
      || Number(context.workoutObject?.getDistanceAt?.(context.workoutObject.length - 1))
      || 0;

    const distanceDeltaRatio = workoutDistanceMeters > 0
      ? Math.abs(routeLookup.distanceMeters - workoutDistanceMeters) / workoutDistanceMeters
      : 0;

    if (!Number.isFinite(workoutDistanceMeters) || workoutDistanceMeters <= 0) {
      return res.status(422).json({ error: "Workout has no usable distance data for manual GPS mapping." });
    }

    if (distanceDeltaRatio > 0.2) {
      return res.status(422).json({
        error: "Lookup route differs too much from the workout distance.",
        distanceDeltaRatio
      });
    }

    const manualGpsSampleRateSeconds = normalizeGpsSampleRateSeconds(
      req.body?.sampleRateSeconds,
      context.samplerategps ?? context.sampleRateGPS ?? DEFAULT_GPS_SAMPLE_RATE_SECONDS
    );

    const manualGpsTrack = WorkoutDBService.buildManualGpsTrackFromLookup(
      context.workoutObject,
      routeLookup.track,
      workoutDistanceMeters,
      manualGpsSampleRateSeconds
    );
    const altitudeEnrichedTrack = await WorkoutDBService.enrichManualGpsTrackAltitude(manualGpsTrack);
    const streamUpdate = WorkoutDBService.buildWorkoutStreamFromManualGps(
      context.workoutObject,
      altitudeEnrichedTrack,
      workoutDistanceMeters
    );

    const updatedTrackRow = await WorkoutDBService.updateWorkoutManualGps(
      workoutId,
      uid,
      altitudeEnrichedTrack,
      lookupPoints,
      streamUpdate
    );
    const thumbnailPayload = WorkoutThumbnailService.createThumbnailPayload({
      gpsTrack: altitudeEnrichedTrack.track.map((point) => [point.lat, point.lng]),
      workoutObject: streamUpdate.workoutObject
    });
    const thumbnail = thumbnailPayload
      ? await WorkoutThumbnailService.upsertThumbnail(workoutId, thumbnailPayload)
      : null;

    return res.json({
      ok: true,
      workoutId,
      gpsSource: updatedTrackRow.gps_source,
      sampleRateGPS: updatedTrackRow.samplerategps ?? updatedTrackRow.sampleRateGPS ?? manualGpsSampleRateSeconds,
      pointsCount: Array.isArray(updatedTrackRow?.track?.coordinates) ? updatedTrackRow.track.coordinates.length : 0,
      distanceDeltaRatio,
      totalAscent: updatedTrackRow.total_ascent ?? null,
      totalDescent: updatedTrackRow.total_descent ?? null,
      hasThumbnail: !!thumbnail,
      thumbnailUpdatedAt: thumbnail?.updatedAt || null
    });
  } catch (err) {
    console.error("POST /workouts/:id/manual-gps failed:", err);
    return res.status(err.statusCode || 500).json({
      error: err.message || "Failed to assign manual GPS to workout"
    });
  }
});

router.get("/:id/gps-copy-candidates", authMiddleware, requireActiveAccountWrite, async (req, res) => {
  try {
    const workoutId = Number(req.params.id);
    const uid = req.user?.id;

    if (!Number.isFinite(workoutId) || workoutId <= 0) {
      return res.status(400).json({ error: "Invalid workout id" });
    }

    const candidates = await WorkoutDBService.getGpsCopyCandidates(workoutId, uid, 0.05);
    return res.json({
      ok: true,
      workoutId,
      candidates
    });
  } catch (err) {
    console.error("GET /workouts/:id/gps-copy-candidates failed:", err);
    return res.status(err.statusCode || 500).json({
      error: err.message || "Failed to load GPS copy candidates"
    });
  }
});

router.post("/:id/gps-copy-from", authMiddleware, requireActiveAccountWrite, async (req, res) => {
  try {
    const targetWorkoutId = Number(req.params.id);
    const uid = req.user?.id;
    const sourceWorkoutId = Number(req.body?.sourceWorkoutId);

    if (!Number.isFinite(targetWorkoutId) || targetWorkoutId <= 0 || !Number.isFinite(sourceWorkoutId) || sourceWorkoutId <= 0) {
      return res.status(400).json({ error: "Invalid workout id" });
    }

    const targetContext = await WorkoutDBService.getManualGpsContext(targetWorkoutId, uid);
    const sourceContext = await WorkoutDBService.getGpsCopySourceContext(sourceWorkoutId, uid);
    const targetWorkoutDistanceMeters = Number(targetContext.total_distance)
      || Number(targetContext.workoutObject?.getDistanceAt?.(targetContext.workoutObject.length - 1))
      || 0;

    if (!Number.isFinite(targetWorkoutDistanceMeters) || targetWorkoutDistanceMeters <= 0) {
      return res.status(422).json({ error: "Workout has no usable distance data for GPS copy." });
    }

    const targetGpsSampleRateSeconds = normalizeGpsSampleRateSeconds(
      req.body?.sampleRateSeconds,
      targetContext.samplerategps
        ?? targetContext.sampleRateGPS
        ?? sourceContext.samplerategps
        ?? sourceContext.sampleRateGPS
        ?? DEFAULT_GPS_SAMPLE_RATE_SECONDS
    );

    const copiedGpsTrack = WorkoutDBService.buildGpsTrackFromSourceWorkout(
      targetContext.workoutObject,
      targetWorkoutDistanceMeters,
      sourceContext.workoutObject,
      sourceContext.trackPoints,
      sourceContext.samplerategps ?? sourceContext.sampleRateGPS,
      sourceContext.total_distance,
      targetGpsSampleRateSeconds
    );

    const streamUpdate = WorkoutDBService.buildWorkoutStreamFromManualGps(
      targetContext.workoutObject,
      copiedGpsTrack,
      targetWorkoutDistanceMeters
    );

    const updatedTrackRow = await WorkoutDBService.updateWorkoutManualGps(
      targetWorkoutId,
      uid,
      copiedGpsTrack,
      [],
      streamUpdate
    );

    const thumbnailPayload = WorkoutThumbnailService.createThumbnailPayload({
      gpsTrack: copiedGpsTrack.track.map((point) => [point.lat, point.lng]),
      workoutObject: streamUpdate.workoutObject
    });
    const thumbnail = thumbnailPayload
      ? await WorkoutThumbnailService.upsertThumbnail(targetWorkoutId, thumbnailPayload)
      : null;

    return res.json({
      ok: true,
      workoutId: targetWorkoutId,
      sourceWorkoutId,
      gpsSource: updatedTrackRow.gps_source,
      sampleRateGPS: updatedTrackRow.samplerategps ?? updatedTrackRow.sampleRateGPS ?? targetGpsSampleRateSeconds,
      pointsCount: Array.isArray(updatedTrackRow?.track?.coordinates) ? updatedTrackRow.track.coordinates.length : 0,
      totalAscent: updatedTrackRow.total_ascent ?? null,
      totalDescent: updatedTrackRow.total_descent ?? null,
      hasThumbnail: !!thumbnail,
      thumbnailUpdatedAt: thumbnail?.updatedAt || null
    });
  } catch (err) {
    console.error("POST /workouts/:id/gps-copy-from failed:", err);
    return res.status(err.statusCode || 500).json({
      error: err.message || "Failed to copy GPS from workout"
    });
  }
});

router.get("/:id/thumbnail", authMiddleware, async (req, res) => {
  try {
    const workoutId = Number(req.params.id);
    const uid = req.user?.id;

    if (!Number.isFinite(workoutId) || workoutId <= 0) {
      return res.status(400).json({ error: "Invalid workout id" });
    }

    await WorkoutSharingService.getAccessibleWorkout(uid, workoutId);
    let thumbnail = await WorkoutThumbnailService.getThumbnail(workoutId);

    if (!thumbnail?.content && FEATURE_THUMBNAILS_ON_DEMAND) {
      thumbnail = await WorkoutThumbnailService.generateThumbnailForWorkout(workoutId);
    }

    if (!thumbnail?.content) {
      return res.status(404).end();
    }

    res.setHeader("Content-Type", thumbnail.mimeType || "image/svg+xml");
    res.setHeader("Cache-Control", "private, max-age=31536000, immutable");

    return res.send(thumbnail.content);
  } catch (err) {
    console.error("GET /workouts/:id/thumbnail failed:", err);
    return res.status(err.statusCode || 500).json({ error: err.message || "Failed to load workout thumbnail" });
  }
});

router.post("/:id/similarity/classify", authMiddleware, requireActiveAccountWrite, async (req, res) => {
  try {
    const workoutId = Number(req.params.id);
    const uid = req.user?.id;

    if (!Number.isFinite(workoutId) || workoutId <= 0) {
      return res.status(400).json({ error: "Invalid workout id" });
    }

    const accessInfo = await WorkoutSharingService.getAccessibleWorkout(uid, workoutId);
    if (!accessInfo?.is_owner) {
      return res.status(403).json({ error: "Only workout owners can classify similar workouts." });
    }

    const edges = await WorkoutSimilarityService.classifySimilarGpsWorkoutsForWorkout(workoutId, uid);

    return res.json({
      ok: true,
      matchType: WorkoutSimilarityService.MATCH_TYPE_GPS_ROUTE,
      count: Array.isArray(edges) ? edges.length : 0,
      edges
    });
  } catch (err) {
    console.error("POST /workouts/:id/similarity/classify failed:", err);
    return res.status(err.statusCode || 500).json({
      error: err.message || "Failed to classify similar workouts"
    });
  }
});

router.get("/:id/similarity", authMiddleware, async (req, res) => {
  try {
    const workoutId = Number(req.params.id);
    const uid = req.user?.id;

    if (!Number.isFinite(workoutId) || workoutId <= 0) {
      return res.status(400).json({ error: "Invalid workout id" });
    }

    const accessInfo = await WorkoutSharingService.getAccessibleWorkout(uid, workoutId);
    if (!accessInfo?.is_owner) {
      return res.json({
        ok: true,
        matchType: WorkoutSimilarityService.MATCH_TYPE_GPS_ROUTE,
        count: 0,
        edges: []
      });
    }

    const refreshStartedAt = performance.now();
    const refresh = await WorkoutSimilarityService.refreshSimilarityForWorkout(workoutId, uid);
    const refreshMs = performance.now() - refreshStartedAt;
    const clusterStartedAt = performance.now();
    const edges = await WorkoutDBService.getSimilarityClusterForWorkout(
      workoutId,
      uid,
      WorkoutSimilarityService.MATCH_TYPE_GPS_ROUTE
    );
    const clusterMs = performance.now() - clusterStartedAt;

    console.log("[similarity] on-demand.profile", {
      uid: String(uid),
      workoutId,
      directMatchCount: Array.isArray(refresh?.edges) ? refresh.edges.length : 0,
      clusterCount: Array.isArray(edges) ? edges.length : 0,
      refreshMs: Number(refreshMs.toFixed(2)),
      clusterMs: Number(clusterMs.toFixed(2)),
      totalMs: Number((refreshMs + clusterMs).toFixed(2)),
      profile: refresh?.profile || {}
    });

    return res.json({
      ok: true,
      matchType: WorkoutSimilarityService.MATCH_TYPE_GPS_ROUTE,
      count: Array.isArray(edges) ? edges.length : 0,
      edges
    });
  } catch (err) {
    console.error("GET /workouts/:id/similarity failed:", err);
    return res.status(err.statusCode || 500).json({
      error: err.message || "Failed to load similar workouts"
    });
  }
});

router.delete("/:id", authMiddleware, requireActiveAccountWrite, async (req, res) => {
  const workoutId = req.params.id;
  const uid = req.user.id;

  try {
    const result = await FileDBService.deleteWorkout(uid, workoutId);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Workout not found" });
    }
    return res.json({
      ok: true,
      id: workoutId
    });
  } catch (err) {
    console.error("DELETE /files/workouts/:id failed:", err);
    return res.status(500).json({ error: "Failed to delete workout" });
  }
});


/*router.get('/uploadUI', checkAuth, async (req, res) => {
  console.log(req.user);
  if (!req?.user?.id) {
    //return res.redirect("/");
    const redirectUrl = encodeURIComponent(req.originalUrl);
    return res.redirect(`/login?redirect=${redirectUrl}`);
  }

  res.render('fileUpload', {
    userInfo: req.user,
    isAuthenticated: req.isAuthenticated
  });
});

// -------------------------------------
// GET /files/workouts  (Tabulator JSON)
// -------------------------------------
router.get("/workouts", authMiddleware, async (req, res, next) => {
  try {


    console.log("QUERY:", req.query);
    const page = parseInt(req.query.page || req.body.page) || 1;
    const size = parseInt(req.query.size || req.body.size) || 20;
    const sort = req.query.sort || [];
    const filters = req.query.filter || [];
    const uid = req.user?.id;

    const result = await FileDBService.getWorkoutsByUser(
      uid,
      page,
      size,
      sort,
      filters
    );


    res.json(result);

  } catch (err) {
    console.log(err);
    next(err);
  }
});

// GET /files/workouts/:id/data
router.get("/workouts/:id/data", authMiddleware, async (req, res, next) => {
  try {
    return res.status(410).json({
      error: "Legacy workout data endpoint removed"
    });

  } catch (err) {
    next(err);
  }
});


router.get("/ctl-atl", authMiddleware, async (req, res, next) => {
  try {
    const uid = req.user?.id;

    const { period } = req.query;

    const ALLOWED_PERIODS = ["date", "week", "month"];

    const selectedPeriod = ALLOWED_PERIODS.includes(period)
      ? period
      : "date";


    const data = await FileDBService.getCTLATL(uid, selectedPeriod);

    res.json({
      grouping: selectedPeriod,
      data
    });

  } catch (err) {
    console.error("GET /files/ctl-atl failed:", err);
    next(err);
  }
});

router.get("/ftp", authMiddleware, async (req, res, next) => {
  try {
    const uid = req.user?.id;

    const { period } = req.query;

    const ALLOWED_PERIODS = ["week", "month", "quarter", "year"];

    const selectedPeriod = ALLOWED_PERIODS.includes(period)
      ? period
      : "quarter";

    const result = await FileDBService.getFTPValues(
      uid,
      selectedPeriod
    );

    const transformedResult = result.map(r => ({
      grp: r.period,
      cp8: Math.round(r.cp8 ?? 0),
      cp15: Math.round(r.cp15 ?? 0),
      ftp: Math.round(r.ftp ?? 0),
      confidence: r.confidence
    }));

    res.json({
      grouping: selectedPeriod,
      data: transformedResult
    });

  } catch (err) {
    console.error("GET /files/ftp failed:", err);
    next(err);
  }
});


// -------------------------------------
// GET /files/cp-best-efforts
// sample: GET /files/cp-best-efforts?grouping=year_week&durations=15,60,240
// -------------------------------------
router.get("/cp-best-efforts", authMiddleware, async (req, res, next) => {
  try {
    const { grouping, durations } = req.query;
    const uid = req.user?.id;

    const ALLOWED_GROUPINGS = ['year', 'year_quarter', 'year_month', 'year_week'];

    // ✅ grouping validieren
    if (!grouping || !ALLOWED_GROUPINGS.includes(grouping)) {
      return res.status(400).json({
        error: "Invalid grouping",
        allowed: ALLOWED_GROUPINGS
      });
    }

    // ✅ durations parsen
    let durationArray;

    if (!durations) {
      durationArray = [5, 15, 60, 120, 240, 480, 900, 1800];
    } else {
      durationArray = durations
        .split(',')
        .map(d => parseInt(d.trim(), 10))
        .filter(n => !isNaN(n));
    }

    if (durationArray.length === 0) {
      return res.status(400).json({
        error: "No valid durations provided"
      });
    }

    // 🔥 Service Call
    const rows = await FileDBService.getCPBestEfforts(
      grouping,
      durationArray,
      uid
    );

    // 🔄 Response strukturieren (wie vorher)
    const data = {};

    for (const row of rows) {
      if (!data[row.grp]) {
        data[row.grp] = {};
      }

      data[row.grp][`CP${row.duration}`] = {
        power: row.best_effort_avg_power,
        heartRate: row.best_effort_avg_heart_rate,
        cadence: row.best_effort_avg_cadence,
        speed: row.best_effort_avg_speed,
        fileId: row.best_effort_file_id,
        startOffset: row.start_offset,
        endOffset: row.end_offset,
        startTime: row.start_time
      };
    }

    res.json({
      grouping,
      durations: durationArray,
      data
    });

  } catch (err) {
    console.error("GET /files/cp-best-efforts failed:", err);
    next(err);
  }
});


router.post("/workouts/:id/segments", authMiddleware, requireActiveAccountWrite, async (req, res, next) => {
  try {
    const workoutId = req.params.id;
    const uid = req.user?.id;

    const segments = Array.isArray(req.body)
      ? req.body
      : req.body.segments;

    if (!Array.isArray(segments) || segments.length === 0) {
      return res.status(400).json({
        error: "Segments must be a non-empty array"
      });
    }

    // ✅ Validierung
    for (const seg of segments) {
      if (
        seg.start_offset === undefined ||
        seg.end_offset === undefined ||
        seg.start_offset < 0 ||
        seg.end_offset < seg.start_offset
      ) {
        return res.status(400).json({
          error: "Invalid segment in payload",
          segment: seg
        });
      }
    }

    const result_del = await FileDBService.deleteSegmentsBulk(
      uid,
      workoutId,
      segments
    );

    const inserted = await FileDBService.insertSegmentsBulk(
      uid,
      workoutId,
      segments
    );

    const updated = await FileDBService.updateSegmentsBulk(
      uid,
      workoutId,
      segments
    );

    const result = [...inserted, ...updated];

    res.status(201).json({
      ok: true,
      count: result.length,
      segments: result
    });

  } catch (err) {
    console.error("POST /files/workouts/:id/segments failed:", err);
    next(err);
  }
});

router.get("/workouts/:id/segments", authMiddleware, async (req, res, next) => {
  try {
    const workoutId = req.params.id;
    const uid = req.user?.id;

    const result = await FileDBService.getSegmentsByWorkout(
      uid,
      workoutId
    );

    const segmentStatus = result?.status?.segmentProcessingStatus || "queued";
    res.setHeader("Cache-Control", segmentStatus === "completed"
      ? "private, max-age=0, must-revalidate"
      : "no-store");

    res.json({
      count: Array.isArray(result?.rows) ? result.rows.length : 0,
      data: result?.rows || [],
      meta: result?.status || {
        workoutId: Number(workoutId),
        segmentProcessingStatus: "queued",
        segmentProcessingError: null,
        segmentProcessingUpdatedAt: null
      }
    });

  } catch (err) {
    console.error("GET /files/workouts/:id/segments failed:", err);
    next(err);
  }
});*/


export default router;
