import express from "express";

import authMiddleware from "../middleware/authMiddleware.js";
//import checkSessionMiddleware from "../middleware/checkSessionMiddleware.js";
//import uploadMiddleware from "../middleware/uploadMiddleware.js";

import MapSegment from "../shared/MapSegment.js"

import SegmentDBService from "../services/segmentDBService.js";

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



    res.json({
      ok: true,
      id: globalThis.crypto.randomUUID(),
      distance: route.distance,
      duration: route.duration,
      track,
      start: { ...start, name: label_start },
      end: { ...end, name: label_end }

    });

  } catch (err) {
    console.error("POST /files/track-lookup failed:", err);
    next(err);
  }
});

router.post("/save/:id/segments", authMiddleware, async (req, res, next) => {
  try {
    const transaction_id = req.params.id;
    const authSub = req.user?.sub;

    const segments = Array.isArray(req.body)
      ? req.body
      : req.body.segments;

    if (!Array.isArray(segments) || segments.length === 0) {
      return res.status(400).json({
        error: "Segments must be a non-empty array"
      });
    }



    const rows_inserted = await SegmentDBService.insertGpsSegmentsBulk(authSub, segments);

    console.log(rows_inserted);


    const updated = segments.map(seg => ({
      ...seg,
      rowstate: 'DB'
    }));

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

router.post("/query", authMiddleware, async (req, res) => {
  const authSub = req.user.sub;
  const { bounds, excludeIds } = req.body;
  //const excludeIdsArray = excludeIds;
  const limit = parseInt(req.body.limit) || 100;

  const result = await SegmentDBService.querySegmentsByBounds(authSub, bounds, excludeIds, limit );

  const data = result.rows.map(r => SegmentDBService.mapSegment(r));

  res.json({ data });
});


router.get("/bestefforts/:id/data", authMiddleware, async (req, res, next) => {
  try {
    const segmentid = req.params.id;
    const authSub = req.user?.sub;

    console.log("QUERY:", req.query);
    const page = parseInt(req.query.page || req.body.page) || 1;
    const size = parseInt(req.query.size || req.body.size) || 20;
    const sort = req.query.sort || [];
    const filters = req.query.filter || [];


    const result = await SegmentDBService.getBestEffortsBySegment(
      authSub,
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




/*
router.delete("/workouts/:id", authMiddleware, async (req, res) => {
  const workoutId = req.params.id;
  const sub = req.user.sub;

  try {
    const result = await FileDBService.deleteWorkout(sub, workoutId);

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


router.get('/uploadUI', checkAuth, async (req, res) => {
  console.log(req.user);
  if (!req?.user?.sub) {
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
    const authSub = req.user?.sub;

    const result = await FileDBService.getWorkoutsByUser(
      authSub,
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

    const workoutId = req.params.id;
    const authSub = req.user?.sub;

    const url = await FileDBService.getWorkoutRecordsPreSignedUrl(
      workoutId,
      authSub
    );

    res.json({ url });


  } catch (err) {
    next(err);
  }
});


router.get("/ctl-atl", authMiddleware, async (req, res, next) => {
  try {
    const authSub = req.user?.sub;

    const { period } = req.query;

    const ALLOWED_PERIODS = ["date", "week", "month"];

    const selectedPeriod = ALLOWED_PERIODS.includes(period)
      ? period
      : "date";


    const data = await FileDBService.getCTLATL(authSub, selectedPeriod);

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
    const authSub = req.user?.sub;

    const { period } = req.query;

    const ALLOWED_PERIODS = ["week", "month", "quarter", "year"];

    const selectedPeriod = ALLOWED_PERIODS.includes(period)
      ? period
      : "quarter";

    const result = await FileDBService.getFTPValues(
      authSub,
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
    const authSub = req.user?.sub;

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
      authSub
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


router.post("/workouts/:id/segments", authMiddleware, async (req, res, next) => {
  try {
    const workoutId = req.params.id;
    const authSub = req.user?.sub;

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
      authSub,
      workoutId,
      segments
    );

    const result = await FileDBService.upsertSegmentsBulk(
      authSub,
      workoutId,
      segments
    );

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
    const authSub = req.user?.sub;

    const segments = await FileDBService.getSegmentsByWorkout(
      authSub,
      workoutId
    );

    res.json({
      count: segments.length,
      data: segments
    });

  } catch (err) {
    console.error("GET /files/workouts/:id/segments failed:", err);
    next(err);
  }
});*/


export default router;