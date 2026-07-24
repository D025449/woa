import express from "express";

import authMiddleware from "../middleware/authMiddleware.js";
import requireActiveAccountWrite from "../middleware/requireActiveAccountWrite.js";
import ViewPreferenceService from "../services/viewPreferenceService.js";

const router = express.Router();

router.get("/:viewKey", authMiddleware, async (req, res, next) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    res.setHeader("Cache-Control", "private, no-store");
    const data = await ViewPreferenceService.get(req.user.id, req.params.viewKey);
    return res.json({ data });
  } catch (err) {
    return next(err);
  }
});

router.put("/:viewKey", authMiddleware, requireActiveAccountWrite, async (req, res, next) => {
  try {
    const data = await ViewPreferenceService.upsert(
      req.user.id,
      req.params.viewKey,
      req.body?.state
    );
    return res.json({ data });
  } catch (err) {
    return next(err);
  }
});

router.use((err, req, res, _next) => {
  if (err?.statusCode) {
    return res.status(err.statusCode).json({ error: err.message });
  }

  console.error("view preference route failed:", err);
  return res.status(500).json({ error: err?.message || "View preference request failed" });
});

export default router;
