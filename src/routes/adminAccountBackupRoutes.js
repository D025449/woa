import express from "express";
import multer from "multer";

import requireAdmin from "../middleware/requireAdmin.js";
import UserAccountBackupService, {
  buildUserAccountBackupFilename
} from "../services/userAccountBackupService.js";
import AdminSegmentBackupService, {
  ADMIN_SEGMENT_BACKUP_MAX_BYTES,
  buildAdminSegmentBackupFilename
} from "../services/adminSegmentBackupService.js";
import { enqueueSegmentBestEfforts } from "../services/segment-best-efforts-service.js";
import PostgresBackupCatalogService from "../services/postgresBackupCatalogService.js";
import { postgresBackupOpsQueue } from "../queue/postgres-backup-ops-queue.js";

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 }
});
const segmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: ADMIN_SEGMENT_BACKUP_MAX_BYTES, files: 1 }
});

router.use(requireAdmin);

router.get("/", (req, res) => {
  res.render("admin-accounts", {
    userInfo: req.user,
    isAuthenticated: true
  });
});

router.get("/export", async (_req, res, next) => {
  try {
    const backup = await UserAccountBackupService.exportAll();
    const body = `${JSON.stringify(backup, null, 2)}\n`;
    res.set({
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${buildUserAccountBackupFilename(new Date(backup.createdAt))}"`
    });
    return res.send(body);
  } catch (error) {
    return next(error);
  }
});

router.post("/import", upload.single("backup"), async (req, res, next) => {
  try {
    if (!req.file?.buffer) {
      return res.status(400).json({ error: "Missing JSON backup file" });
    }
    let backup;
    try {
      backup = JSON.parse(req.file.buffer.toString("utf8"));
    } catch {
      return res.status(400).json({ error: "Invalid JSON backup file" });
    }
    const counts = await UserAccountBackupService.importAll(backup);
    return res.json({ ok: true, counts });
  } catch (error) {
    return next(error);
  }
});

router.get("/segments/export", async (_req, res, next) => {
  try {
    const { archive } = await AdminSegmentBackupService.exportAll();
    res.set({
      "Cache-Control": "no-store",
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${buildAdminSegmentBackupFilename()}"`,
      "Content-Length": String(archive.byteLength)
    });
    return res.send(archive);
  } catch (error) {
    return next(error);
  }
});

router.post("/segments/preview", segmentUpload.single("archive"), async (req, res, next) => {
  try {
    if (!req.file?.buffer) {
      return res.status(400).json({ error: "Missing segment ZIP backup" });
    }
    const preview = await AdminSegmentBackupService.preview(req.file.buffer);
    return res.json({ ok: true, preview });
  } catch (error) {
    return next(error);
  }
});

router.post("/segments/import", segmentUpload.single("archive"), async (req, res, next) => {
  try {
    if (!req.file?.buffer) {
      return res.status(400).json({ error: "Missing segment ZIP backup" });
    }
    if (req.body?.confirmed !== "true") {
      return res.status(400).json({ error: "Segment import must be explicitly confirmed" });
    }
    const result = await AdminSegmentBackupService.importAll(req.file.buffer);
    const queueResults = await Promise.allSettled(
      result.queueTargets
        .filter((target) => target.segmentIds.length > 0)
        .map((target) => enqueueSegmentBestEfforts(target))
    );
    const queueFailures = queueResults.filter((entry) => entry.status === "rejected").length;
    return res.json({
      ok: true,
      imported: result.imported,
      queueFailures,
      preview: {
        createdAt: result.createdAt,
        totals: result.totals,
        owners: result.owners
      }
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/database/backups", async (_req, res, next) => {
  try {
    const catalog = await PostgresBackupCatalogService.list({ limit: 50 });
    return res.json({ ok: true, catalog });
  } catch (error) {
    return next(error);
  }
});

router.post("/database/backups", async (req, res, next) => {
  try {
    const label = String(req.body?.label || "").trim().slice(0, 80);
    const job = await postgresBackupOpsQueue.add("create", { label: label || null });
    return res.status(202).json({ ok: true, jobId: String(job.id), operation: job.name });
  } catch (error) {
    return next(error);
  }
});

router.post("/database/backups/verify", async (req, res, next) => {
  try {
    const backupRoot = PostgresBackupCatalogService.validateRoot(req.body?.backupRoot);
    const job = await postgresBackupOpsQueue.add("verify", { backupRoot });
    return res.status(202).json({ ok: true, jobId: String(job.id), operation: job.name });
  } catch (error) {
    return next(error);
  }
});

router.post("/database/restores/prepare", async (req, res, next) => {
  try {
    const backupRoot = PostgresBackupCatalogService.validateRoot(req.body?.backupRoot);
    if (req.body?.confirmed !== true) {
      return res.status(400).json({ error: "Restore preparation must be explicitly confirmed" });
    }
    const job = await postgresBackupOpsQueue.add("prepare-restore", { backupRoot });
    return res.status(202).json({ ok: true, jobId: String(job.id), operation: job.name });
  } catch (error) {
    return next(error);
  }
});

router.post("/database/restores/activate", async (req, res, next) => {
  try {
    const config = PostgresBackupCatalogService.configuration();
    if (!config.activationSupported) {
      return res.status(400).json({ error: "Database pointer activation is available only in production." });
    }
    if (req.body?.confirmed !== true) {
      return res.status(400).json({ error: "Restore activation must be explicitly confirmed." });
    }
    const prepareJobId = String(req.body?.prepareJobId || "");
    if (!/^\d+$/u.test(prepareJobId)) {
      return res.status(400).json({ error: "Invalid restore preparation job ID" });
    }
    const prepareJob = await postgresBackupOpsQueue.getJob(prepareJobId);
    if (!prepareJob || prepareJob.name !== "prepare-restore" || await prepareJob.getState() !== "completed") {
      return res.status(409).json({ error: "Restore preparation is not completed." });
    }
    const prepared = prepareJob.returnvalue;
    if (prepared?.schemaCompatibility !== "same-commit") {
      return res.status(409).json({ error: "Activation requires the same application commit as the backup." });
    }
    if (prepared?.sourceDatabase !== config.activeDatabase) {
      return res.status(409).json({ error: "The active database changed after restore preparation." });
    }
    if (prepared?.logicalDatabase !== config.database || !prepared?.targetDatabase) {
      return res.status(409).json({ error: "Prepared restore does not belong to the active backup namespace." });
    }
    const job = await postgresBackupOpsQueue.add("activate-restore", {
      prepareJobId,
      backupId: prepared.backupId,
      sourceDatabase: prepared.sourceDatabase,
      targetDatabase: prepared.targetDatabase,
      adminAuthSub: req.user.sub
    });
    return res.status(202).json({ ok: true, jobId: String(job.id), operation: job.name });
  } catch (error) {
    return next(error);
  }
});

router.post("/database/restores/rollback", async (req, res, next) => {
  try {
    const config = PostgresBackupCatalogService.configuration();
    if (!config.activationSupported || !config.previousDatabase) {
      return res.status(409).json({ error: "No production database rollback is available." });
    }
    if (req.body?.confirmed !== true) {
      return res.status(400).json({ error: "Database rollback must be explicitly confirmed." });
    }
    const job = await postgresBackupOpsQueue.add("rollback", {
      sourceDatabase: config.activeDatabase,
      adminAuthSub: req.user.sub
    });
    return res.status(202).json({ ok: true, jobId: String(job.id), operation: job.name });
  } catch (error) {
    return next(error);
  }
});

router.get("/database/jobs/:jobId", async (req, res, next) => {
  try {
    const jobId = String(req.params.jobId || "");
    if (!/^\d+$/u.test(jobId)) {
      return res.status(400).json({ error: "Invalid backup operation job ID" });
    }
    const job = await postgresBackupOpsQueue.getJob(jobId);
    if (!job) return res.status(404).json({ error: "Backup operation job not found" });
    const state = await job.getState();
    return res.json({
      ok: true,
      job: {
        id: String(job.id),
        operation: job.name,
        state,
        progress: job.progress || null,
        result: state === "completed" ? job.returnvalue : null,
        error: state === "failed" ? job.failedReason : null,
        createdAt: job.timestamp ? new Date(job.timestamp).toISOString() : null,
        finishedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null
      }
    });
  } catch (error) {
    return next(error);
  }
});

router.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    return res.status(400).json({ error: error.message });
  }
  console.error("admin backup failed:", error);
  return res.status(error?.statusCode || 500).json({
    error: error?.message || "Admin backup operation failed"
  });
});

export default router;
