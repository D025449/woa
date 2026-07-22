import express from "express";
import multer from "multer";

import authMiddleware from "../middleware/authMiddleware.js";
import requireActiveAccountWrite from "../middleware/requireActiveAccountWrite.js";
//import checkSessionMiddleware from "../middleware/checkSessionMiddleware.js";
//import uploadMiddleware from "../middleware/uploadMiddleware.js";

import MapSegment from "../shared/MapSegment.js"

import SegmentDBService from "../services/segmentDBService.js";
import SegmentFavoriteService from "../services/segmentFavoriteService.js";
import ElevationService from "../services/ElevationService.js";
import { enqueueSegmentBestEfforts } from "../services/segment-best-efforts-service.js";
import CollaborationDBService from "../services/collaborationDBService.js";

import pool from "../services/database.js";

import { FileDBService } from "../services/fileDBService.js";
import { fetchBicycleRoute } from "../services/bicycleRoutingService.js";
import {
  buildSegmentArchive,
  decodeSegmentArchive,
  filterNovelSegments,
  SEGMENT_ARCHIVE_MAX_BYTES,
  SegmentArchiveValidationError
} from "../services/segmentArchiveService.js";

const router = express.Router();
const SEGMENT_BEST_EFFORTS_ON_DEMAND = String(
  process.env.SEGMENT_BEST_EFFORTS_ON_DEMAND || "1"
).trim() !== "0";
const SEGMENT_BEST_EFFORTS_ON_DEMAND_LIMIT = Math.min(
  100,
  Math.max(1, Math.floor(Number(process.env.SEGMENT_BEST_EFFORTS_ON_DEMAND_LIMIT) || 100))
);
const segmentArchiveUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: SEGMENT_ARCHIVE_MAX_BYTES,
    files: 1
  }
});
const receiveSegmentArchive = (req, res, next) => {
  segmentArchiveUpload.single("archive")(req, res, (error) => {
    if (error instanceof multer.MulterError) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  });
};

const checkAuth = (req, res, next) => {
  req.isAuthenticated = !!req.session.userInfo;
  next();
};


async function reverseGeocode(lat1, lng1) {
  const urln = `https://nominatim.openstreetmap.org/reverse?lat=${lat1}&lon=${lng1}&format=json`;
  const resn = await fetch(urln, {
    headers: {
      "User-Agent": "CBA24"
    }
  });

  if (!resn.ok) {
    throw new Error(`Nominatim error: ${resn.status}`);
  }
  const datan = await resn.json();
  return datan;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function haversineMeters(a, b) {
  const toRad = (value) => (value * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad((b.lat ?? 0) - (a.lat ?? 0));
  const dLng = toRad((b.lng ?? 0) - (a.lng ?? 0));
  const lat1 = toRad(a.lat ?? 0);
  const lat2 = toRad(b.lat ?? 0);

  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const x =
    sinLat * sinLat +
    Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;

  return 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function computeTrackSpacingStats(track) {
  if (!Array.isArray(track) || track.length < 2) {
    return {
      pointCount: Array.isArray(track) ? track.length : 0,
      segmentCount: 0
    };
  }

  const distances = [];

  for (let i = 1; i < track.length; i++) {
    distances.push(haversineMeters(track[i - 1], track[i]));
  }

  const sorted = [...distances].sort((a, b) => a - b);
  const sum = distances.reduce((acc, value) => acc + value, 0);
  const pickPercentile = (p) => {
    const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
    return sorted[idx];
  };

  return {
    pointCount: track.length,
    segmentCount: distances.length,
    minMeters: Math.round(sorted[0] * 10) / 10,
    maxMeters: Math.round(sorted[sorted.length - 1] * 10) / 10,
    avgMeters: Math.round((sum / distances.length) * 10) / 10,
    p50Meters: Math.round(pickPercentile(0.5) * 10) / 10,
    p90Meters: Math.round(pickPercentile(0.9) * 10) / 10
  };
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

function computeTrackAscent(track) {
  if (!Array.isArray(track) || track.length < 2) {
    return 0;
  }

  let total = 0;
  for (let i = 1; i < track.length; i++) {
    const prev = track[i - 1]?.ele;
    const current = track[i]?.ele;

    if (typeof prev !== "number" || typeof current !== "number") {
      continue;
    }

    const delta = current - prev;
    if (delta > 0) {
      total += delta;
    }
  }

  return total;
}

function bearingDegrees(from, to) {
  const toRad = (value) => (value * Math.PI) / 180;
  const toDeg = (value) => (value * 180) / Math.PI;
  const lat1 = toRad(from.lat ?? 0);
  const lat2 = toRad(to.lat ?? 0);
  const dLng = toRad((to.lng ?? 0) - (from.lng ?? 0));

  const y = Math.sin(dLng) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);

  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function turnAngleDegrees(prev, current, next) {
  const inBearing = bearingDegrees(prev, current);
  const outBearing = bearingDegrees(current, next);
  let diff = Math.abs(outBearing - inBearing);
  if (diff > 180) diff = 360 - diff;
  return diff;
}

function buildCurvatureAwareTrack(track, options = {}) {
  const {
    minDistanceMeters = 15,
    maxGapMeters = 45,
    turnAngleDegreesThreshold = 12
  } = options;

  if (!Array.isArray(track) || track.length <= 2) {
    return Array.isArray(track) ? [...track] : [];
  }

  const reduced = [track[0]];
  let lastKeptIndex = 0;

  for (let i = 1; i < track.length - 1; i++) {
    const candidate = track[i];
    const next = track[i + 1];
    const distanceFromLastKept = haversineMeters(track[lastKeptIndex], candidate);
    const angle = turnAngleDegrees(track[i - 1], candidate, next);
    const distanceToNext = haversineMeters(candidate, next);

    const shouldKeep =
      distanceFromLastKept >= maxGapMeters ||
      angle >= turnAngleDegreesThreshold ||
      (distanceFromLastKept >= minDistanceMeters && distanceToNext >= minDistanceMeters);

    if (shouldKeep) {
      reduced.push(candidate);
      lastKeptIndex = i;
    }
  }

  const lastPoint = track[track.length - 1];
  if (reduced[reduced.length - 1] !== lastPoint) {
    reduced.push(lastPoint);
  }

  return reduced;
}

function createStepLogger(scope, meta = {}) {
  const startedAt = Date.now();
  let lastAt = startedAt;
  const steps = [];

  return {
    mark(label, extra = {}) {
      const now = Date.now();
      steps.push({
        label,
        stepMs: now - lastAt,
        totalMs: now - startedAt,
        ...extra
      });
      lastAt = now;
    },
    flush(extra = {}) {
      console.log(`[timing] ${scope}`, {
        ...meta,
        totalMs: Date.now() - startedAt,
        steps,
        ...extra
      });
    }
  };
}

router.get("/archive/export", authMiddleware, async (req, res, next) => {
  try {
    const uid = req.user?.id;
    const segments = await SegmentDBService.getOwnedSegmentsForArchive(uid);
    const archive = buildSegmentArchive(segments);
    const date = new Date().toISOString().slice(0, 10);

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="woa-segments-${date}.zip"`);
    res.setHeader("Content-Length", String(archive.byteLength));
    res.send(archive);
  } catch (error) {
    console.error("GET /segments/archive/export failed:", error);
    next(error);
  }
});

router.post(
  "/archive/import",
  authMiddleware,
  requireActiveAccountWrite,
  receiveSegmentArchive,
  async (req, res, next) => {
    try {
      if (!req.file?.buffer) {
        throw new SegmentArchiveValidationError("A segment ZIP archive is required");
      }

      const uid = req.user?.id;
      const importedSegments = await decodeSegmentArchive(req.file.buffer);
      const existingSegments = await SegmentDBService.getOwnedSegmentsForArchive(uid);
      const { accepted, skippedDuplicates } = filterNovelSegments(importedSegments, existingSegments);
      const insertedRows = await SegmentDBService.insertGpsSegmentsBulk(uid, accepted);
      const segmentIds = [...new Set(
        insertedRows
          .map((row) => Number(row.id))
          .filter(Number.isInteger)
      )];

      if (segmentIds.length > 0) {
        await enqueueSegmentBestEfforts({ uid, segmentIds });
      }

      console.log("[segments] archive-import.completed", {
        uid: String(uid),
        total: importedSegments.length,
        imported: insertedRows.length,
        skippedDuplicates,
        queuedBestEffortScans: segmentIds.length
      });
      res.status(201).json({
        ok: true,
        total: importedSegments.length,
        imported: insertedRows.length,
        skippedDuplicates,
        queuedBestEffortScans: segmentIds.length,
        segments: insertedRows.map((row) => SegmentDBService.mapSegment(row))
      });
    } catch (error) {
      if (error instanceof SegmentArchiveValidationError || error instanceof multer.MulterError) {
        return res.status(400).json({ error: error.message });
      }
      console.error("POST /segments/archive/import failed:", error);
      next(error);
    }
  }
);



router.post("/track-lookup", authMiddleware, requireActiveAccountWrite, async (req, res) => {
  const timing = createStepLogger("segments.track-lookup");
  try {
    const { start, waypoints = [], end, points = null } = req.body;
    const uid = req.user?.id;

    const routePoints = Array.isArray(points) && points.length >= 2
      ? points
      : [start, ...(Array.isArray(waypoints) ? waypoints : []), end].filter(Boolean);

    if (routePoints.length < 2) {
      return res.status(400).json({
        error: "at least two route points required"
      });
    }

    const normalizedPoints = routePoints.map((point) => ({
      lat: Number(point?.lat),
      lng: Number(point?.lng)
    }));

    const hasInvalidPoint = normalizedPoints.some((point) =>
      !Number.isFinite(point.lat) || !Number.isFinite(point.lng)
    );

    if (hasInvalidPoint) {
      return res.status(400).json({
        error: "route points contain invalid lat/lng values"
      });
    }

    const normalizedStart = normalizedPoints[0];
    const normalizedEnd = normalizedPoints[normalizedPoints.length - 1];
    const { lat: lat1, lng: lng1 } = normalizedStart;
    const { lat: lat2, lng: lng2 } = normalizedEnd;

    const routePromise = fetchBicycleRoute(normalizedPoints);
    const startLocationPromise = reverseGeocode(lat1, lng1);

    const route = await routePromise;
    timing.mark("osrm-route");

    const start_location = await startLocationPromise;
    timing.mark("reverse-start");

    // 👉 GeoJSON → dein Format
    const rawTrack = route.geometry.coordinates.map(([lng, lat]) => ({
      lat,
      lng
    }));
    const trackSpacing = computeTrackSpacingStats(rawTrack);
    timing.mark("track-spacing", trackSpacing);
    const optimizedTrack = buildCurvatureAwareTrack(rawTrack);
    const optimizedTrackSpacing = computeTrackSpacingStats(optimizedTrack);
    timing.mark("optimized-track-spacing", {
      ...optimizedTrackSpacing,
      reducedPointCount: rawTrack.length - optimizedTrack.length,
      reductionPercent: rawTrack.length > 0
        ? Math.round(((rawTrack.length - optimizedTrack.length) / rawTrack.length) * 1000) / 10
        : 0
    });

    const label_start = MapSegment.formatLocation(start_location.address, "full");

    const service = new ElevationService({
      batchSize: 100,
      sleepMs: 150
    });

    const elevationPromise = service.enrichTrack(optimizedTrack);
    await sleep(1000);
    timing.mark("reverse-gap-wait");
    const endLocationPromise = reverseGeocode(lat2, lng2);

    const end_location = await endLocationPromise;
    timing.mark("reverse-end");

    const enriched = await elevationPromise;
    timing.mark("elevation", {
      pointCount: optimizedTrack.length
    });
    const ascent = service.calculateAscent(enriched);
    const label_end = MapSegment.formatLocation(end_location.address, "full");

    const temp_seg = {
      ok: true,
      distance: route.distance,
      duration: route.duration,
      track: enriched,
      ascent,
      start: { ...normalizedStart, name: label_start, altitude: enriched[0].ele },
      end: { ...normalizedEnd, name: label_end, altitude: enriched[enriched.length - 1].ele }
    };

    temp_seg.bestEffortsStatus = "queued";
    const segments_inserted = await SegmentDBService.insertGpsSegmentsBulk(uid, [temp_seg]);
    timing.mark("insert-segment", {
      insertedCount: segments_inserted.length
    });

    await enqueueSegmentBestEfforts({
      uid,
      segmentIds: segments_inserted.map((segment) => segment.id)
    });
    timing.mark("enqueue-best-efforts");

    const updated = segments_inserted.map(seg => ({
      ...SegmentDBService.mapSegment(seg),
      rowstate: 'DB'
    }));

    /*res.status(201).json({
      ok: true,
      count: updated.length,
      segments: updated
    });*/

    timing.flush({
      status: 201,
      segmentId: updated[0]?.id
    });

    res.status(201).json(updated[0]);


    /*res.json({
      ok: true,
      id: globalThis.crypto.randomUUID(),
      distance: route.distance,
      duration: route.duration,
      track: enriched,
      ascent,
      start: { ...start, name: label_start, altitude: enriched[0].ele },
      end: { ...end, name: label_end, altitude: enriched[enriched.length - 1].ele }

    });*/

  } catch (err) {
    const status = err.statusCode || 500;
    timing.flush({
      status,
      error: err.message,
      upstreamStatus: err.upstreamStatus,
      upstreamCode: err.upstreamCode
    });
    console.error("POST /segments/track-lookup failed:", err);
    return res.status(status).json({
      error: err.message || "Segment route lookup failed",
      upstreamCode: err.upstreamCode
    });
  }
});

router.post("/track-lookup-v2", authMiddleware, requireActiveAccountWrite, async (req, res, next) => {
  const timing = createStepLogger("segments.track-lookup-v2");

  try {
    const { track } = req.body;
    const uid = req.user?.id;

    if (!Array.isArray(track) || track.length < 2) {
      return res.status(400).json({
        error: "track with at least two points required"
      });
    }

    const normalizedTrack = track.map((point) => ({
      lat: Number(point.lat),
      lng: Number(point.lng),
      ele: point.ele != null ? Number(point.ele) : null
    }));

    const hasInvalidPoint = normalizedTrack.some((point) =>
      !Number.isFinite(point.lat) || !Number.isFinite(point.lng)
    );

    if (hasInvalidPoint) {
      return res.status(400).json({
        error: "track contains invalid lat/lng values"
      });
    }

    const start = normalizedTrack[0];
    const end = normalizedTrack[normalizedTrack.length - 1];

    const trackSpacing = computeTrackSpacingStats(normalizedTrack);
    timing.mark("track-spacing", trackSpacing);

    const startLocation = await reverseGeocode(start.lat, start.lng);
    timing.mark("reverse-start");

    await sleep(1000);
    timing.mark("reverse-gap-wait");

    const endLocation = await reverseGeocode(end.lat, end.lng);
    timing.mark("reverse-end");

    const label_start = MapSegment.formatLocation(startLocation.address, "full");
    const label_end = MapSegment.formatLocation(endLocation.address, "full");

    const temp_seg = {
      ok: true,
      distance: computeTrackDistanceMeters(normalizedTrack),
      duration: null,
      track: normalizedTrack,
      ascent: computeTrackAscent(normalizedTrack),
      start: {
        lat: start.lat,
        lng: start.lng,
        name: label_start,
        altitude: start.ele
      },
      end: {
        lat: end.lat,
        lng: end.lng,
        name: label_end,
        altitude: end.ele
      },
      bestEffortsStatus: "queued"
    };

    const segments_inserted = await SegmentDBService.insertGpsSegmentsBulk(uid, [temp_seg]);
    timing.mark("insert-segment", {
      insertedCount: segments_inserted.length
    });

    await enqueueSegmentBestEfforts({
      uid,
      segmentIds: segments_inserted.map((segment) => segment.id)
    });
    timing.mark("enqueue-best-efforts");

    const updated = segments_inserted.map((seg) => ({
      ...SegmentDBService.mapSegment(seg),
      rowstate: "DB"
    }));

    timing.flush({
      status: 201,
      segmentId: updated[0]?.id
    });

    res.status(201).json(updated[0]);
  } catch (err) {
    timing.flush({
      status: 500,
      error: err.message
    });
    console.error("POST /segments/track-lookup-v2 failed:", err);
    next(err);
  }
});

router.post("/save/:id/segments", authMiddleware, requireActiveAccountWrite, async (req, res, next) => {
  try {
    const transaction_id = req.params.id;
    const uid = req.user?.id;

    const segments = Array.isArray(req.body)
      ? req.body
      : req.body.segments;

    if (!Array.isArray(segments) || segments.length === 0) {
      return res.status(400).json({
        error: "Segments must be a non-empty array"
      });
    }



    const segmentsWithStatus = segments.map((segment) => ({
      ...segment,
      bestEffortsStatus: segment.bestEffortsStatus ?? "queued"
    }));
    const segments_inserted = await SegmentDBService.insertGpsSegmentsBulk(uid, segmentsWithStatus);

    await enqueueSegmentBestEfforts({
      uid,
      segmentIds: segments_inserted.map((segment) => segment.id)
    });

    //console.log(new_sbe);





    const updated = segments_inserted.map(seg => ({
      ...SegmentDBService.mapSegment(seg),
      rowstate: 'DB'
    }));

    //const data = segments_inserted.map(r => SegmentDBService.mapSegment(r));



    res.status(201).json({
      ok: true,
      count: updated.length,
      segments: updated
    });

  } catch (err) {
    console.error("POST /save/:id/segments failed:", err);
    next(err);
  }
});

router.get("/:id/sharing", authMiddleware, async (req, res, next) => {
  try {
    const uid = req.user?.id;
    const segmentId = Number(req.params.id);
    const data = await SegmentDBService.getSegmentSharing(uid, segmentId);
    res.json({ data });
  } catch (err) {
    console.error("GET /segments/:id/sharing failed:", err);
    next(err);
  }
});

router.put("/:id/sharing", authMiddleware, requireActiveAccountWrite, async (req, res, next) => {
  try {
    const uid = req.user?.id;
    const segmentId = Number(req.params.id);
    const data = await SegmentDBService.updateSegmentSharing(uid, segmentId, req.body);
    if (Array.isArray(data.newlyPublishedGroupIds) && data.newlyPublishedGroupIds.length > 0) {
      await enqueueSegmentBestEfforts({
        uid,
        segmentIds: [segmentId]
      });
    }
    res.json({ data });
  } catch (err) {
    console.error("PUT /segments/:id/sharing failed:", err);
    next(err);
  }
});

router.get("/favorites", authMiddleware, async (req, res, next) => {
  try {
    const segmentIds = await SegmentFavoriteService.listAccessibleIds(req.user.id);
    res.json({ segmentIds });
  } catch (err) {
    console.error("GET /segments/favorites failed:", err);
    next(err);
  }
});

router.put("/:id/favorite", authMiddleware, requireActiveAccountWrite, async (req, res, next) => {
  try {
    const uid = req.user.id;
    const segmentId = Number(req.params.id);
    if (!Number.isInteger(segmentId) || segmentId <= 0) {
      return res.status(400).json({ error: "Invalid segment id" });
    }

    const segment = await SegmentDBService.getAccessibleSegment(uid, segmentId);
    if (!segment) {
      return res.status(404).json({ error: "Segment not found" });
    }

    await SegmentFavoriteService.add(uid, segmentId);
    return res.json({ ok: true, segmentId, isFavorite: true });
  } catch (err) {
    console.error("PUT /segments/:id/favorite failed:", err);
    next(err);
  }
});

router.delete("/:id/favorite", authMiddleware, requireActiveAccountWrite, async (req, res, next) => {
  try {
    const segmentId = Number(req.params.id);
    if (!Number.isInteger(segmentId) || segmentId <= 0) {
      return res.status(400).json({ error: "Invalid segment id" });
    }

    await SegmentFavoriteService.remove(req.user.id, segmentId);
    return res.json({ ok: true, segmentId, isFavorite: false });
  } catch (err) {
    console.error("DELETE /segments/:id/favorite failed:", err);
    next(err);
  }
});

router.post("/query", authMiddleware, requireActiveAccountWrite, async (req, res, next) => {
  try {
    const uid = req.user.id
    const { bounds, excludeIds, scope, favoritesOnly } = req.body;
    //const excludeIdsArray = excludeIds;
    const limit = parseInt(req.body.limit) || 100;

    const result = await SegmentDBService.querySegmentsByBounds(uid, bounds, excludeIds, limit, scope, favoritesOnly === true);

    const data = result.rows.map(r => SegmentDBService.mapSegment(r));

    res.json({ data });
  }
  catch (err) {
    console.error("POST /query", err);
    next(err);
  }
});

router.get("/workout-gps-seg-best-effort/:id/data", authMiddleware, async (req, res, next) => {
  try {
    const wid = req.params.id;
    const uid = req.user?.id;

    const result = await SegmentDBService.getGPSSegmentByWorkout(uid, wid);
    res.json(result.rows);

  } catch (err) {
    console.log(err);
    next(err);
  }

});


router.get("/bestefforts/:id/data", authMiddleware, async (req, res, next) => {
  try {
    const segmentid = req.params.id;
    const uid = req.user?.id;

    console.log("QUERY:", req.query);
    const page = parseInt(req.query.page || req.body.page) || 1;
    const size = parseInt(req.query.size || req.body.size) || 20;
    const sort = req.query.sort || [];
    const filters = req.query.filter || [];
    const scope = req.query.scope || req.body.scope || "mine";
    const perUser = req.query.perUser || req.body.perUser || "all";

    const accessibleSegment = SEGMENT_BEST_EFFORTS_ON_DEMAND
      ? await SegmentDBService.getAccessibleSegment(uid, segmentid)
      : null;
    const useOnDemand = SEGMENT_BEST_EFFORTS_ON_DEMAND
      && Number(accessibleSegment?.uid) === Number(uid)
      && String(scope).toLowerCase() === "mine"
      && String(perUser).toLowerCase() === "all";

    if (useOnDemand) {
      const startedAt = performance.now();
      const result = await SegmentDBService.materializeOnDemandSegmentBestEfforts(uid, segmentid, {
        limit: SEGMENT_BEST_EFFORTS_ON_DEMAND_LIMIT
      });
      const totalMs = performance.now() - startedAt;
      console.log("[segments] best-efforts.on-demand.profile", {
        uid: String(uid),
        segmentId: String(segmentid),
        totalMatchCount: result.total_records,
        returnedMatchCount: result.returned_records,
        limit: SEGMENT_BEST_EFFORTS_ON_DEMAND_LIMIT,
        totalMs: Math.round(totalMs * 100) / 100,
        profile: result.profile
      });
      return res.json({
        data: result.data,
        last_page: 1,
        total_records: result.total_records,
        returned_records: result.returned_records,
        result_limit: SEGMENT_BEST_EFFORTS_ON_DEMAND_LIMIT,
        on_demand: true,
        best_efforts_status: "completed",
        best_efforts_error: null
      });
    }


    const [result, statusRow] = await Promise.all([
      SegmentDBService.getBestEffortsBySegment(
        uid,
        segmentid,
        page,
        size,
        sort,
        filters,
        scope,
        perUser
      ),
      SegmentDBService.getBestEffortsStatus(uid, segmentid)
    ]);


    res.json({
      ...result,
      best_efforts_status: statusRow?.best_efforts_status ?? null,
      best_efforts_error: statusRow?.best_efforts_error ?? null
    });

  } catch (err) {
    console.log(err);
    next(err);
  }
});

router.get("/:id", authMiddleware, async (req, res, next) => {
  try {
    const segmentId = req.params.id;
    const uid = req.user?.id;

    const segment = await SegmentDBService.getSegmentById(uid, segmentId);

    if (!segment) {
      return res.status(404).json({
        error: "Segment not found"
      });
    }

    res.json({
      ...segment,
      rowstate: "DB"
    });
  } catch (err) {
    console.error("GET /segments/:id failed:", err);
    next(err);
  }
});

router.get("/:id/best-efforts-status", authMiddleware, async (req, res, next) => {
  try {
    const segmentId = req.params.id;
    const uid = req.user?.id;

    const statusRow = await SegmentDBService.getBestEffortsStatus(uid, segmentId);

    if (!statusRow) {
      return res.status(404).json({
        error: "Segment not found"
      });
    }

    res.json({
      id: statusRow.id,
      status: statusRow.best_efforts_status,
      error: statusRow.best_efforts_error
    });
  } catch (err) {
    console.error("GET /segments/:id/best-efforts-status failed:", err);
    next(err);
  }
});

router.delete("/:id", authMiddleware, requireActiveAccountWrite, async (req, res, next) => {
  try {
    const segmentId = req.params.id;
    const uid = req.user?.id;

    const deleted = await SegmentDBService.deleteSegmentById(uid, segmentId);

    if (!deleted) {
      return res.status(404).json({
        error: "Segment not found"
      });
    }

    res.json({
      ok: true,
      id: deleted.id
    });
  } catch (err) {
    console.error("DELETE /segments/:id failed:", err);
    next(err);
  }
});




export default router;
