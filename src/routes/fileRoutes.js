import express from "express";
import { strToU8, zipSync } from "fflate";

import authMiddleware from "../middleware/authMiddleware.js";
import requireActiveAccountWrite from "../middleware/requireActiveAccountWrite.js";
import { FileDBService } from "../services/fileDBService.js";
import CollaborationDBService from "../services/collaborationDBService.js";
import EntitlementService from "../services/entitlementService.js";
import TrainingFeedDBService from "../services/trainingFeedDBService.js";
import TrainingActivityDBService from "../services/trainingActivityDBService.js";
import {
  buildManualActivityArchiveManifest,
  buildManualActivityDocument,
  manualActivityFileName
} from "../shared/ManualActivityExchange.js";
import { POWER_DISTRIBUTION_ZONES } from "../shared/PowerDistribution.js";

const router = express.Router();

const checkAuth = (req, res, next) => {
  req.isAuthenticated = !!req.session.userInfo;
  next();
};

function normalizeArrayParam(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  return [];
}
router.delete("/workouts/:id", authMiddleware, requireActiveAccountWrite, async (req, res) => {
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

router.post("/workouts/bulk-delete", authMiddleware, requireActiveAccountWrite, async (req, res) => {
  const uid = req.user.id;
  const workoutIds = Array.isArray(req.body?.workoutIds) ? req.body.workoutIds : [];
  const normalizedIds = [...new Set(
    workoutIds
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0)
  )];

  if (!normalizedIds.length) {
    return res.status(400).json({ error: "No valid workout ids provided" });
  }

  try {
    const result = await FileDBService.deleteWorkouts(uid, normalizedIds);
    return res.json({
      ok: true,
      deletedIds: result.deletedIds,
      requestedCount: normalizedIds.length,
      deletedCount: result.rowCount
    });
  } catch (err) {
    console.error("POST /files/workouts/bulk-delete failed:", err);
    return res.status(500).json({ error: "Failed to bulk delete workouts" });
  }
});


router.get('/uploadUI', checkAuth, async (req, res) => {
  if (!req?.user?.id) {
    const redirectUrl = encodeURIComponent(req.originalUrl);
    return res.redirect(`/login?redirect=${redirectUrl}`);
  }

  const usage = await EntitlementService.getUsageOverview(req.user.id);
  const storedWorkoutUsage = Array.isArray(usage?.items)
    ? usage.items.find((item) => item.featureKey === "stored_workout") || null
    : null;

  res.render('fileUploadNew', {
    userInfo: req.user,
    isAuthenticated: req.isAuthenticated,
    uploadUsage: {
      storedWorkout: storedWorkoutUsage
    }
  });
});

router.get('/uploadNewUI', checkAuth, async (req, res) => {
  return res.redirect('/files/uploadUI');
});

// -------------------------------------
// GET /files/workouts  (combined training feed)
// -------------------------------------
router.get("/workouts", authMiddleware, async (req, res, next) => {
  try {
    console.log("QUERY:", req.query);
    const page = parseInt(req.query.page || req.body.page) || 1;
    const size = parseInt(req.query.size || req.body.size) || 20;
    const sort = normalizeArrayParam(req.query.sort);
    const filters = normalizeArrayParam(req.query.filter);
    const scope = String(req.query.scope || "mine");
    const favoritesOnly = ["1", "true"].includes(String(req.query.favoritesOnly || "").toLowerCase());
    const uid = req.user?.id;

    const result = await TrainingFeedDBService.getEntriesByUser(
      uid,
      page,
      size,
      sort,
      filters,
      scope,
      favoritesOnly
    );


    res.json(result);

  } catch (err) {
    console.log(err);
    next(err);
  }
});

router.post("/training-activities", authMiddleware, requireActiveAccountWrite, async (req, res, next) => {
  try {
    const activity = await TrainingActivityDBService.create(req.user.id, req.body || {});
    return res.status(201).json({ activity });
  } catch (err) {
    if (err?.statusCode) return res.status(err.statusCode).json({ error: err.message });
    return next(err);
  }
});

router.get("/training-activities/export.zip", authMiddleware, async (req, res, next) => {
  try {
    const exportedAt = new Date();
    const activities = await TrainingActivityDBService.getAll(req.user.id);
    const entries = {
      "manifest.json": strToU8(JSON.stringify(
        buildManualActivityArchiveManifest(activities.length, exportedAt),
        null,
        2
      ))
    };
    activities.forEach((activity, index) => {
      const name = manualActivityFileName(activity.start_time, String(index + 1).padStart(4, "0"));
      entries[`activities/${name}`] = strToU8(JSON.stringify(
        buildManualActivityDocument(activity, exportedAt),
        null,
        2
      ));
    });
    const archive = zipSync(entries, { level: 6 });
    const date = exportedAt.toISOString().slice(0, 10);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="woa-manual-activities-${date}.zip"`
    );
    res.setHeader("Cache-Control", "no-store");
    return res.send(Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength));
  } catch (err) {
    return next(err);
  }
});

router.post("/training-activities/import/preview", authMiddleware, async (req, res, next) => {
  try {
    const preview = await TrainingActivityDBService.previewImport(
      req.user.id,
      req.body?.activities
    );
    return res.json({ preview });
  } catch (err) {
    if (err?.statusCode) return res.status(err.statusCode).json({ error: err.message });
    return next(err);
  }
});

router.post("/training-activities/import", authMiddleware, requireActiveAccountWrite, async (req, res, next) => {
  try {
    const result = await TrainingActivityDBService.importMany(
      req.user.id,
      req.body?.activities,
      req.body?.overwriteExisting === true
    );
    return res.status(201).json({ result });
  } catch (err) {
    if (err?.statusCode) return res.status(err.statusCode).json({ error: err.message });
    return next(err);
  }
});

router.get("/training-activities/:id/export.json", authMiddleware, async (req, res, next) => {
  try {
    const activity = await TrainingActivityDBService.getById(req.user.id, req.params.id);
    if (!activity) return res.status(404).json({ error: "Training activity not found" });
    const document = buildManualActivityDocument(activity);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${manualActivityFileName(activity.start_time)}"`
    );
    res.setHeader("Cache-Control", "no-store");
    return res.send(`${JSON.stringify(document, null, 2)}\n`);
  } catch (err) {
    return next(err);
  }
});

router.get("/training-activities/:id", authMiddleware, async (req, res, next) => {
  try {
    const activity = await TrainingActivityDBService.getById(req.user.id, req.params.id);
    if (!activity) return res.status(404).json({ error: "Training activity not found" });
    return res.json({ activity });
  } catch (err) {
    return next(err);
  }
});

router.put("/training-activities/:id", authMiddleware, requireActiveAccountWrite, async (req, res, next) => {
  try {
    const activity = await TrainingActivityDBService.update(req.user.id, req.params.id, req.body || {});
    if (!activity) return res.status(404).json({ error: "Training activity not found" });
    return res.json({ activity });
  } catch (err) {
    if (err?.statusCode) return res.status(err.statusCode).json({ error: err.message });
    return next(err);
  }
});

router.post("/training-activities/:id/copies", authMiddleware, requireActiveAccountWrite, async (req, res, next) => {
  try {
    const result = await TrainingActivityDBService.copyToStartTimes(
      req.user.id,
      req.params.id,
      req.body?.targetStartTimes
    );
    if (!result) return res.status(404).json({ error: "Training activity not found" });
    return res.status(201).json({
      createdCount: result.created.length,
      createdIds: result.created.map((activity) => activity.id),
      skippedCount: result.skippedStartTimes.length,
      skippedStartTimes: result.skippedStartTimes,
      requestedCount: result.requestedCount
    });
  } catch (err) {
    if (err?.statusCode) return res.status(err.statusCode).json({ error: err.message });
    return next(err);
  }
});

router.delete("/training-activities/:id", authMiddleware, requireActiveAccountWrite, async (req, res, next) => {
  try {
    const activity = await TrainingActivityDBService.delete(req.user.id, req.params.id);
    if (!activity) return res.status(404).json({ error: "Training activity not found" });
    return res.json({ ok: true, id: activity.id });
  } catch (err) {
    if (err?.statusCode) return res.status(err.statusCode).json({ error: err.message });
    return next(err);
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

    const ALLOWED_PERIODS = ["date", "week", "month", "quarter", "year"];

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

router.get("/power-distribution", authMiddleware, async (req, res, next) => {
  try {
    const grouping = ["week", "month", "quarter", "year"].includes(req.query.grouping)
      ? req.query.grouping
      : "month";
    const data = await FileDBService.getPowerDistribution(req.user?.id, grouping);
    return res.json({
      grouping,
      zones: POWER_DISTRIBUTION_ZONES.map(({ key, maxPercent, color }) => ({
        key,
        maxPercent: Number.isFinite(maxPercent) ? maxPercent : null,
        color
      })),
      data
    });
  } catch (err) {
    console.error("GET /files/power-distribution failed:", err);
    return next(err);
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
    const uid = req.user?.id;

    const { period } = req.query;

    const ALLOWED_PERIODS = ["week", "month", "quarter", "year"];

    const selectedPeriod = ALLOWED_PERIODS.includes(period)
      ? period
      : "quarter";

    const [result, rollingResult] = await Promise.all([
      FileDBService.getFTPValues(uid, selectedPeriod),
      FileDBService.getRollingFTPValues(uid, selectedPeriod)
    ]);

    const rollingByPeriod = new Map(
      rollingResult.map(row => [String(row.period), row])
    );

    const transformedResult = result.map(r => ({
      grp: r.period,
      cp8: Math.round(r.cp8 ?? 0),
      cp15: Math.round(r.cp15 ?? 0),
      ftp: Math.round(r.ftp ?? 0),
      confidence: r.confidence,
      rollingFtp: Math.round(rollingByPeriod.get(String(r.period))?.ftp ?? 0),
      rollingConfidence: rollingByPeriod.get(String(r.period))?.confidence ?? 0
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
      durationArray = [5, 15, 60, 120, 240, 360, 480, 720, 900, 960, 1800];
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
    const rollingGrouping = {
      year: "year",
      year_quarter: "quarter",
      year_month: "month",
      year_week: "week"
    }[grouping];
    const [rows, rollingFtpRows] = await Promise.all([
      FileDBService.getCPBestEfforts(grouping, durationArray, uid),
      FileDBService.getRollingFTPValues(uid, rollingGrouping)
    ]);

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

    for (const row of rollingFtpRows) {
      const group = String(row.period);
      if (!data[group]) {
        data[group] = {};
      }
      data[group].eFTP = {
        power: Math.round(row.ftp),
        confidence: row.confidence,
        modelPointCount: row.modelPointCount,
        startTime: row.startTime
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

router.post("segments/delete/:id", authMiddleware, requireActiveAccountWrite, async (req, res, next) => {

    const workoutId = req.params.id;
    const uid = req.user?.id;

    const segments = req.body.segment ? [req.body.segment] : req.body.segments;

    if (!Array.isArray(segments) || segments.length === 0) {
      return res.status(400).json({
        error: "Segments must be a non-empty array"
      });
    }
    
    

});


router.post("/workouts/:id/segments", authMiddleware, requireActiveAccountWrite, async (req, res, next) => {
  try {
    const workoutId = req.params.id;
    const uid = req.user?.id;

    const segments = req.body.segment ? [req.body.segment]: req.body.segments;

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

router.delete(
  "/workouts/:id/segments/:segmentId",
  authMiddleware,
  requireActiveAccountWrite,
  async (req, res, next) => {
    try {
      const workoutId = Number(req.params.id);
      const segmentId = Number(req.params.segmentId);
      if (!Number.isInteger(workoutId) || workoutId <= 0 || !Number.isInteger(segmentId) || segmentId <= 0) {
        return res.status(400).json({ error: "Invalid workout or segment id" });
      }

      const deleted = await FileDBService.deleteManualSegment(req.user.id, workoutId, segmentId);
      if (!deleted) {
        return res.status(404).json({ error: "Manual segment not found" });
      }

      return res.json({ ok: true, segment: deleted });
    } catch (err) {
      console.error("DELETE /files/workouts/:id/segments/:segmentId failed:", err);
      return next(err);
    }
  }
);

router.patch(
  "/workouts/:id/segments/:segmentId",
  authMiddleware,
  requireActiveAccountWrite,
  async (req, res, next) => {
    try {
      const workoutId = Number(req.params.id);
      const segmentId = Number(req.params.segmentId);
      const payload = req.body?.segment || req.body || {};
      const startOffset = Number(payload.start_offset);
      const endOffset = Number(payload.end_offset);

      if (!Number.isInteger(workoutId) || workoutId <= 0 || !Number.isInteger(segmentId) || segmentId <= 0) {
        return res.status(400).json({ error: "Invalid workout or segment id" });
      }
      if (
        !Number.isInteger(startOffset)
        || !Number.isInteger(endOffset)
        || startOffset < 0
        || endOffset - startOffset < 2
      ) {
        return res.status(400).json({ error: "Invalid manual segment range" });
      }

      const normalizeMetric = (value) => {
        const metric = Number(value);
        return Number.isFinite(metric) ? metric : 0;
      };
      const segment = {
        start_offset: startOffset,
        end_offset: endOffset,
        duration: endOffset - startOffset,
        avg_power: normalizeMetric(payload.avg_power),
        avg_heart_rate: normalizeMetric(payload.avg_heart_rate),
        avg_cadence: normalizeMetric(payload.avg_cadence),
        avg_speed: normalizeMetric(payload.avg_speed),
        altimeters: normalizeMetric(payload.altimeters)
      };

      const updated = await FileDBService.updateManualSegment(
        req.user.id,
        workoutId,
        segmentId,
        segment
      );
      if (!updated) {
        return res.status(404).json({ error: "Manual segment not found" });
      }

      return res.json({ ok: true, segment: updated });
    } catch (err) {
      console.error("PATCH /files/workouts/:id/segments/:segmentId failed:", err);
      return next(err);
    }
  }
);

router.get("/workouts/:id/segments", authMiddleware, async (req, res, next) => {
  try {
    const workoutId = req.params.id;
    const uid = req.user?.id;

    const result = await FileDBService.getSegmentsByWorkout(
      uid,
      workoutId
    );

    const segmentStatus = result?.status?.segmentProcessingStatus || "completed";
    res.setHeader("Cache-Control", segmentStatus === "completed"
      ? "private, max-age=0, must-revalidate"
      : "no-store");

    res.json({
      count: Array.isArray(result?.rows) ? result.rows.length : 0,
      data: result?.rows || [],
      meta: result?.status || {
        workoutId: Number(workoutId),
        segmentProcessingStatus: "completed",
        segmentProcessingError: null,
        segmentProcessingUpdatedAt: null
      }
    });

  } catch (err) {
    console.error("GET /files/workouts/:id/segments failed:", err);
    next(err);
  }
});


export default router;
