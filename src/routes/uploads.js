import { Router } from "express";
import crypto from "node:crypto";
import path from "node:path";
import S3Service from "../services/s3Service.js";

const router = Router();

router.post("/presign", async (req, res, next) => {
  try {
    const { fileName, fileType, fileSize } = req.body;

    if (!fileName || !fileSize) {
      return res.status(400).json({
        error: "fileName und fileSize sind erforderlich"
      });
    }

    const numericFileSize = Number(fileSize);

    if (!Number.isFinite(numericFileSize) || numericFileSize <= 0) {
      return res.status(400).json({
        error: "Ungültige fileSize"
      });
    }

    if (numericFileSize > 250 * 1024 * 1024) {
      return res.status(400).json({
        error: "Datei ist zu groß"
      });
    }

    const ext = path.extname(fileName).toLowerCase();

    if (ext !== ".zip" && ext !== ".fit") {
      return res.status(400).json({
        error: "Nur .zip oder .fit Dateien sind erlaubt"
      });
    }

    const safeFileName = path.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, "_");
    const key = `imports/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}-${safeFileName}`;

    const uploadUrl = await S3Service.getPresignedUploadUrl(
      process.env.S3_BUCKET,
      key,
      fileType || guessContentType(fileName),
      300
    );

    res.json({
      uploadUrl,
      key
    });
  } catch (err) {
    next(err);
  }
});

function guessContentType(fileName) {
  const lower = fileName.toLowerCase();

  if (lower.endsWith(".zip")) return "application/zip";
  if (lower.endsWith(".fit")) return "application/octet-stream";

  return "application/octet-stream";
}

export default router;