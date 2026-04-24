import express from "express";

import authMiddleware from "../middleware/authMiddleware.js";
import pool from "../services/database.js";
import { FileDBService } from "../services/fileDBService.js";
import WorkoutDBService from "../services/workoutDBService.js";
import CollaborationDBService from "../services/collaborationDBService.js";
import WorkoutSharingService from "../services/workoutSharingService.js";
import SegmentDBService from "../services/segmentDBService.js";
import { enqueueSegmentBestEfforts } from "../services/segment-best-efforts-service.js";

const router = express.Router();

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

router.put("/:id/sharing", authMiddleware, async (req, res) => {
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

// GET /api/workouts/:id/stream
router.get("/:id/stream", authMiddleware, async (req, res) => {
  try {
    const id = req.params.id;
    const uid = req.user.id;

    if (!id) {
      return res.status(400).json({ error: "Missing workout id" });
    }

    const stream = await WorkoutDBService.getStream(id, uid);

    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Encoding", "br");
    res.setHeader("Cache-Control", "no-store");

    // optional extra safety
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    return res.send(stream);

  } catch (err) {
    console.error("Stream load error:", err);
    return res.status(err.statusCode || 500).json({ error: err.message || "Internal server error" });
  }
});

router.get("/:id/track", authMiddleware, async (req, res) => {
  try {
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


router.delete("/:id", authMiddleware, async (req, res) => {
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


router.post("/workouts/:id/segments", authMiddleware, async (req, res, next) => {
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

    const segments = await FileDBService.getSegmentsByWorkout(
      uid,
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
