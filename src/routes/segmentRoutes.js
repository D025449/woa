import express from "express";

import authMiddleware from "../middleware/authMiddleware.js";
import requireActiveAccountWrite from "../middleware/requireActiveAccountWrite.js";
//import checkSessionMiddleware from "../middleware/checkSessionMiddleware.js";
//import uploadMiddleware from "../middleware/uploadMiddleware.js";

import MapSegment from "../shared/MapSegment.js"

import SegmentDBService from "../services/segmentDBService.js";
import ElevationService from "../services/ElevationService.js";
import { enqueueSegmentBestEfforts } from "../services/segment-best-efforts-service.js";
import CollaborationDBService from "../services/collaborationDBService.js";

import pool from "../services/database.js";

import { FileDBService } from "../services/fileDBService.js";

const router = express.Router();

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



router.post("/track-lookup", authMiddleware, requireActiveAccountWrite, async (req, res, next) => {
  const timing = createStepLogger("segments.track-lookup");
  try {
    const { start, end } = req.body;
    const uid = req.user?.id;

    if (!start || !end) {
      return res.status(400).json({
        error: "start and end required"
      });
    }

    const { lat: lat1, lng: lng1 } = start;
    const { lat: lat2, lng: lng2 } = end;

    // ⚠️ OSRM erwartet: lng,lat
    const url = `https://router.project-osrm.org/route/v1/cycling/${lng1},${lat1};${lng2},${lat2}?overview=full&geometries=geojson`;

    const routePromise = fetch(url).then((response) => response.json());
    const startLocationPromise = reverseGeocode(lat1, lng1);

    const data = await routePromise;
    timing.mark("osrm-route");

    const start_location = await startLocationPromise;
    timing.mark("reverse-start");

    if (!data.routes || data.routes.length === 0) {
      timing.flush({ status: 404, reason: "no_route" });
      return res.status(404).json({
        error: "No route found"
      });
    }

    const route = data.routes[0];

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
      start: { ...start, name: label_start, altitude: enriched[0].ele },
      end: { ...end, name: label_end, altitude: enriched[enriched.length - 1].ele }
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
    timing.flush({
      status: 500,
      error: err.message
    });
    console.error("POST /files/track-lookup failed:", err);
    next(err);
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

router.post("/query", authMiddleware, requireActiveAccountWrite, async (req, res, next) => {
  try {
    const uid = req.user.id
    const { bounds, excludeIds, scope } = req.body;
    //const excludeIdsArray = excludeIds;
    const limit = parseInt(req.body.limit) || 100;

    const result = await SegmentDBService.querySegmentsByBounds(uid, bounds, excludeIds, limit, scope);

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


    const result = await SegmentDBService.getBestEffortsBySegment(
      uid,
      segmentid,
      page,
      size,
      sort,
      filters,
      scope,
      perUser
    );


    res.json(result);

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
