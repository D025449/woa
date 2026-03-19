import { Router } from "express";
import { createAndEnqueueImport } from "../services/import-service.js";
import { getImportJobById } from "../db/import-jobs-repo.js";
import S3Service from "../services/s3Service.js";

const router = Router();

router.post("/", async (req, res, next) => {
  try {
    const { key, originalFileName, sizeBytes } = req.body;

    if (!key || !originalFileName || !sizeBytes) {
      return res.status(400).json({
        error: "key, originalFileName und sizeBytes sind erforderlich"
      });
    }

    const numericSizeBytes = Number(sizeBytes);

    if (!Number.isFinite(numericSizeBytes) || numericSizeBytes <= 0) {
      return res.status(400).json({
        error: "Ungültige sizeBytes"
      });
    }

    try {
      await S3Service.headObject(process.env.S3_BUCKET, key);
    } catch (err) {
      return res.status(400).json({
        error: "S3-Objekt wurde nicht gefunden"
      });
    }

    const userId = req.user.sub;
    console.log("UserID: " + userId);
    const job = await createAndEnqueueImport({
      key,
      originalFileName,
      sizeBytes: numericSizeBytes,
      auth_sub: userId
    });

    res.status(202).json({
      jobId: job.id
    });
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const job = await getImportJobById(req.params.id);

    if (!job) {
      return res.status(404).json({
        error: "Job nicht gefunden"
      });
    }

    if (req.user && job.user_sub && req.user.sub !== job.user_sub) {
      return res.status(403).json({
        error: "Kein Zugriff auf diesen Job"
      });
    }

    res.json({
      id: job.id,
      status: job.status,
      stage: job.stage,
      progressPercent: Number(job.progressPercent || 0),
      totalFiles: job.totalFiles,
      processedFiles: job.processedFiles,
      failedFiles: job.failedFiles,
      errorMessage: job.errorMessage
    });
  } catch (err) {
    next(err);
  }
});

export default router;