import express from "express";
import multer from "multer";

import authMiddleware from "../middleware/authMiddleware.js";
import AnalyticsVoiceCommandService from "../services/analyticsVoiceCommandService.js";

const router = express.Router();
const voiceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024, files: 1 }
});

function receiveVoiceUpload(req, res, next) {
  voiceUpload.single("audio")(req, res, (error) => {
    if (error instanceof multer.MulterError) {
      return res.status(400).json({ error: error.message });
    }
    return next(error);
  });
}

router.post("/voice-command", authMiddleware, receiveVoiceUpload, async (req, res, next) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: "Unauthorized" });
    const data = await AnalyticsVoiceCommandService.process(req.file, req.body?.locale);
    return res.json({ data });
  } catch (error) {
    if (Number.isInteger(error?.statusCode)) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    return next(error);
  }
});

export default router;
