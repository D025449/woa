import fs from "node:fs/promises";
import path from "node:path";
import { Router } from "express";

import authMiddleware from "../middleware/authMiddleware.js";
import uploadMiddleware from "../middleware/uploadMiddleware.js";
import { createAndEnqueueImport } from "../services/import-service.js";

const router = Router();

router.post(
  "/",
  authMiddleware,
  uploadMiddleware.single("file"),
  async (req, res, next) => {
    const uploadedFile = req.file;

    try {
      if (!req.user?.id) {
        if (uploadedFile?.path) {
          await fs.rm(uploadedFile.path, { force: true });
        }

        return res.status(401).json({
          error: "Nicht angemeldet"
        });
      }

      if (!uploadedFile) {
        return res.status(400).json({
          error: "Keine Datei hochgeladen"
        });
      }

      const ext = path.extname(uploadedFile.originalname).toLowerCase();

      if (ext !== ".zip" && ext !== ".fit") {
        await fs.rm(uploadedFile.path, { force: true });

        return res.status(400).json({
          error: "Nur .zip oder .fit Dateien sind erlaubt"
        });
      }

      const job = await createAndEnqueueImport({
        localPath: uploadedFile.path,
        originalFileName: uploadedFile.originalname,
        sizeBytes: uploadedFile.size,
        uid: req.user.id
      });

      res.status(202).json({
        jobId: job.id
      });
    } catch (err) {
      if (uploadedFile?.path) {
        await fs.rm(uploadedFile.path, { force: true }).catch(() => {});
      }

      next(err);
    }
  }
);

export default router;
