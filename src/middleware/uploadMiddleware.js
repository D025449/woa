import path from "node:path";
import crypto from "node:crypto";
import multer from "multer";
import {
  ensureDirSync,
  getImportUploadDir
} from "../config/storagePaths.js";

const uploadDir = getImportUploadDir();

ensureDirSync(uploadDir);

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

  if (ext !== ".fit" && ext !== ".zip" && ext !== ".gz" && ext !== ".br" && ext !== ".woat") {
    cb(new Error("Nur .zip, .fit, .gz, .br oder .woat Dateien sind erlaubt"));
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
