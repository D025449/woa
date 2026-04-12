import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import multer from "multer";

const uploadDir = path.join(os.tmpdir(), "woa-imports");

fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination(_req, _file, cb) {
    cb(null, uploadDir);
  },
  filename(_req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${crypto.randomUUID()}${ext}`);
  }
});

function fileFilter(_req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();

  if (ext !== ".fit" && ext !== ".zip") {
    cb(new Error("Nur .zip oder .fit Dateien sind erlaubt"));
    return;
  }

  cb(null, true);
}

export default multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 250 * 1024 * 1024
  }
});
