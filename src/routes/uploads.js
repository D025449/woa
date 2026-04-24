import fs from "node:fs/promises";
import path from "node:path";
import { Router } from "express";

import authMiddleware from "../middleware/authMiddleware.js";
import uploadMiddleware from "../middleware/uploadMiddleware.js";
import { createAndEnqueueImport } from "../services/import-service.js";
import WorkoutSharingService from "../services/workoutSharingService.js";

const router = Router();

function parseGroupIds(value) {
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

router.post(
  "/",
  authMiddleware,
  uploadMiddleware.array("files", 50),
  async (req, res, next) => {
    const uploadedFiles = req.files || [];

    try {
      if (!req.user?.id) {
        await Promise.all(uploadedFiles.map((file) => fs.rm(file.path, { force: true }).catch(() => {})));

        return res.status(401).json({
          error: "Nicht angemeldet"
        });
      }

      if (uploadedFiles.length === 0) {
        return res.status(400).json({
          error: "Keine Dateien hochgeladen"
        });
      }

      for (const uploadedFile of uploadedFiles) {
        const ext = path.extname(uploadedFile.originalname).toLowerCase();

        if (ext !== ".zip" && ext !== ".fit") {
          await Promise.all(uploadedFiles.map((file) => fs.rm(file.path, { force: true }).catch(() => {})));

          return res.status(400).json({
            error: "Nur .zip oder .fit Dateien sind erlaubt"
          });
        }
      }

      const shareConfig = await WorkoutSharingService.resolveShareConfigForUser(req.user.id, {
        shareMode: req.body?.shareMode,
        groupIds: parseGroupIds(req.body?.groupIds)
      });

      const job = await createAndEnqueueImport({
        localPaths: uploadedFiles.map((file) => file.path),
        originalFileNames: uploadedFiles.map((file) => file.originalname),
        sizeBytes: uploadedFiles.reduce((sum, file) => sum + file.size, 0),
        uid: req.user.id,
        shareMode: shareConfig.shareMode,
        groupIds: shareConfig.groupIds
      });

      res.status(202).json({
        jobId: job.id
      });
    } catch (err) {
      await Promise.all(uploadedFiles.map((file) => fs.rm(file.path, { force: true }).catch(() => {})));

      next(err);
    }
  }
);

export default router;
