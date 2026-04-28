import express from "express";

import authMiddleware from "../middleware/authMiddleware.js";
import ProfileDBService from "../services/profileDBService.js";
import { normalizeSupportedLocale } from "../i18n/index.js";

const router = express.Router();

router.get("/", authMiddleware, async (req, res, next) => {
  try {
    const data = await ProfileDBService.getProfile(req.user.id);
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.put("/", authMiddleware, async (req, res, next) => {
  try {
    const data = await ProfileDBService.updateProfile(req.user.id, req.body || {});

    // Keep in-memory request/session user display_name in sync for current session UX.
    if (req.user) {
      req.user.display_name = data.displayName || req.user.display_name;
      req.user.language = data.language || req.user.language;
    }
    if (req.session?.user) {
      req.session.user.display_name = data.displayName || req.session.user.display_name;
      req.session.user.language = data.language || req.session.user.language;
    }

    const normalizedLanguage = normalizeSupportedLocale(data.language, "en");
    res.cookie("lang", normalizedLanguage, {
      httpOnly: false,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 24 * 365
    });

    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.use((err, req, res, next) => {
  if (err?.statusCode) {
    return res.status(err.statusCode).json({ error: err.message });
  }

  console.error("profile route failed:", err);
  return res.status(500).json({ error: err?.message || "Profile request failed" });
});

export default router;
