import express from "express";

import authMiddleware from "../middleware/authMiddleware.js";
//import checkSessionMiddleware from "../middleware/checkSessionMiddleware.js";
//import uploadMiddleware from "../middleware/uploadMiddleware.js";

import MapSegment from "../shared/MapSegment.js"

import SegmentDBService from "../services/segmentDBService.js";
import ElevationService from "../services/ElevationService.js";

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


router.post("/track-lookup", authMiddleware, async (req, res, next) => {
  try {
    const { start, end } = req.body;

    if (!start || !end) {
      return res.status(400).json({
        error: "start and end required"
      });
    }

    const { lat: lat1, lng: lng1 } = start;
    const { lat: lat2, lng: lng2 } = end;

    // ⚠️ OSRM erwartet: lng,lat
    const url = `https://router.project-osrm.org/route/v1/cycling/${lng1},${lat1};${lng2},${lat2}?overview=full&geometries=geojson`;

    const response = await fetch(url);
    const data = await response.json();

    if (!data.routes || data.routes.length === 0) {
      return res.status(404).json({
        error: "No route found"
      });
    }

    const start_location = await reverseGeocode(lat1, lng1);
    await new Promise(r => setTimeout(r, 1000));
    const end_location = await reverseGeocode(lat2, lng2);

    const route = data.routes[0];

    // 👉 GeoJSON → dein Format
    const track = route.geometry.coordinates.map(([lng, lat]) => ({
      lat,
      lng
    }));

    const label_start = MapSegment.formatLocation(start_location.address, "full");
    const label_end = MapSegment.formatLocation(end_location.address, "full");

    const service = new ElevationService({
      downsampleStep: 5,   // 🔥 hier steuerst du es
      batchSize: 100,
      sleepMs: 150
    });

    const enriched = await service.enrichTrack(track);
    const ascent = service.calculateAscent(enriched);

    res.json({
      ok: true,
      id: globalThis.crypto.randomUUID(),
      distance: route.distance,
      duration: route.duration,
      track: enriched,
      ascent,
      start: { ...start, name: label_start, altitude: enriched[0].ele },
      end: { ...end, name: label_end, altitude: enriched[enriched.length - 1].ele }

    });

  } catch (err) {
    console.error("POST /files/track-lookup failed:", err);
    next(err);
  }
});

router.post("/save/:id/segments", authMiddleware, async (req, res, next) => {
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



    const segments_inserted = await SegmentDBService.insertGpsSegmentsBulk(uid, segments);
    const matching_efforts = await SegmentDBService.scanWorkoutsForSegments(uid, segments_inserted);

    console.log(matching_efforts);


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

router.post("/query", authMiddleware, async (req, res, next) => {
  try {
    const uid = req.user.id
    const { bounds, excludeIds } = req.body;
    //const excludeIdsArray = excludeIds;
    const limit = parseInt(req.body.limit) || 100;

    const result = await SegmentDBService.querySegmentsByBounds(uid, bounds, excludeIds, limit);

    const data = result.rows.map(r => SegmentDBService.mapSegment(r));

    res.json({ data });
  } 
  catch (err) 
  {
    console.error("POST /query", err);
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


    const result = await SegmentDBService.getBestEffortsBySegment(
      uid,
      segmentid,
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




export default router;