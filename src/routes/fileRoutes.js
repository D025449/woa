import express from "express";

import authMiddleware from "../middleware/authMiddleware.js";
import checkSessionMiddleware from "../middleware/checkSessionMiddleware.js";
import uploadMiddleware from "../middleware/uploadMiddleware.js";


import * as fileController from "../controllers/fileController.js";

import { FileDBService } from "../services/fileDBService.js";

const router = express.Router();


// POST /files/upload
router.post(
  '/upload',
  authMiddleware,
  uploadMiddleware.single('file'),
  fileController.uploadFile
);

/*const checkAuth = (req, res, next) => {
  if (!req.session.userInfo) {
    req.isAuthenticated = false;
  } else {
    req.isAuthenticated = true;
  }
  next();
};*/

router.delete("/workouts/:id", authMiddleware, async (req, res) => {
  const workoutId = req.params.id;
  const sub = req.user.sub;




  /*if (!Number.isInteger(workoutId) || workoutId <= 0) {
    return res.status(400).json({ error: "Invalid workout id" });
  }*/

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


router.get('/uploadUI', authMiddleware, async (req, res) => {
  console.log(req.user);
  //console.log(req.isAuthenticated);

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

    /*if (!req.session.userInfo) {
      return res.status(401).json({
        error: "Session expired"
      });
    }*/
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
    next(err);
  }
});

// GET /files/workouts/:id/data
router.get("/workouts/:id/data", authMiddleware, async (req, res, next) => {
  try {
    /* if (!req.session.userInfo) {
       return res.status(401).json({
         error: "Session expired"
       });
     }*/
    const workoutId = req.params.id;
    const authSub = req.user?.sub;

    const url = await FileDBService.getWorkoutRecordsPreSignedUrl(
      workoutId,
      authSub
    );

    res.json({ url });

    /*const data = await FileDBService.getWorkoutRecords(
      workoutId,
      authSub
    );

    res.json(data);*/

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


/*
  usage: GET /files/ftp?period=month
{
  "period": "month",
  "labels": [202401, 202402, 202403],
  "ftp": [280, 285, 290],
  "cp8": [320, 325, 330],
  "cp15": [300, 305, 310],
  "confidence": [5, 6, 4]
}
*/
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
        seg.start_index === undefined ||
        seg.end_index === undefined ||
        seg.start_index < 0 ||
        seg.end_index < seg.start_index
      ) {
        return res.status(400).json({
          error: "Invalid segment in payload",
          segment: seg
        });
      }
    }

    const result = await FileDBService.createSegmentsBulk(
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
});


export default router;