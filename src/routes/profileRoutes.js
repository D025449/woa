import GarminConnectionService from "../services/garminConnectionService.js";
import { invalidateAnalyticsOverviewCache } from "../services/analyticsOverviewCache.js";
import UserWeightHistoryService from "../services/userWeightHistoryService.js";
import express from "express";

import authMiddleware from "../middleware/authMiddleware.js";
import requireActiveAccountWrite from "../middleware/requireActiveAccountWrite.js";
import AccountDeletionService from "../services/accountDeletionService.js";
import ProfileDBService from "../services/profileDBService.js";
import { normalizeSupportedLocale } from "../i18n/index.js";

const router = express.Router();

// authMiddleware may continue anonymously; explicitly require a user here.
router.use("/garmin", authMiddleware, (req, res, next) => {
  res.set("Cache-Control", "no-store");
  if (!req.user?.id) return res.status(401).json({ error: "Unauthorized" });
  next();
});
router.get("/garmin", async (req, res, next) => {
  try { res.json({ data: await GarminConnectionService.status(req.user.id) }); }
  catch (error) { next(error); }
});
router.put("/garmin", requireActiveAccountWrite, async (req, res, next) => {
  try { res.json({ data: await GarminConnectionService.save(req.user.id, req.body?.apiKey) }); }
  catch (error) { next(error); }
});
router.delete("/garmin", requireActiveAccountWrite, async (req, res, next) => {
  try {
    await GarminConnectionService.remove(req.user.id);
    res.status(204).end();
  } catch (error) { next(error); }
});

router.get("/weight-history", authMiddleware, async (req, res, next) => {
  try { res.json({ data: await UserWeightHistoryService.list(req.user.id) }); }
  catch (error) { next(error); }
});

router.get("/weight", authMiddleware, async (req, res, next) => {
  try { res.json({ data: await UserWeightHistoryService.resolve(req.user.id, req.query.date) }); }
  catch (error) { next(error); }
});

router.post("/weight-history", authMiddleware, requireActiveAccountWrite, async (req, res, next) => {
  try {
    const data = await UserWeightHistoryService.save(req.user.id, req.body);
    invalidateAnalyticsOverviewCache(req.user.id);
    res.status(201).json({ data });
  }
  catch (error) { next(error); }
});

router.put("/weight-history/:id", authMiddleware, requireActiveAccountWrite, async (req, res, next) => {
  try {
    const data = await UserWeightHistoryService.save(req.user.id, req.body, req.params.id);
    invalidateAnalyticsOverviewCache(req.user.id);
    res.json({ data });
  }
  catch (error) { next(error); }
});

router.delete("/weight-history/:id", authMiddleware, requireActiveAccountWrite, async (req, res, next) => {
  try {
    await UserWeightHistoryService.remove(req.user.id, req.params.id);
    invalidateAnalyticsOverviewCache(req.user.id);
    res.status(204).end();
  } catch (error) { next(error); }
});

router.get("/", authMiddleware, async (req, res, next) => {
  try {
    const data = await ProfileDBService.getProfile(req.user.id);
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.put("/", authMiddleware, requireActiveAccountWrite, async (req, res, next) => {
  try {
    const data = await ProfileDBService.updateProfile(req.user.id, req.body || {});
    invalidateAnalyticsOverviewCache(req.user.id);

    // Keep in-memory request/session user display_name in sync for current session UX.
    if (req.user) {
      req.user.display_name = data.displayName || req.user.display_name;
      req.user.language = data.language || req.user.language;
      req.user.show_sudoku = Boolean(data.showSudoku);
    }
    if (req.session?.user) {
      req.session.user.display_name = data.displayName || req.session.user.display_name;
      req.session.user.language = data.language || req.session.user.language;
      req.session.user.show_sudoku = Boolean(data.showSudoku);
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

router.get("/deletion/status", authMiddleware, async (req, res, next) => {
  try {
    const data = await AccountDeletionService.getDeletionStatus(req.user.id);
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.post("/deletion/request", authMiddleware, async (req, res, next) => {
  try {
    const data = await AccountDeletionService.requestDeletion(req.user.id);
    if (req.user) {
      req.user.account_status = data.accountStatus;
      req.user.deletion_requested_at = data.deletionRequestedAt;
      req.user.deletion_scheduled_for = data.deletionScheduledFor;
    }
    if (req.session?.user) {
      req.session.user.account_status = data.accountStatus;
      req.session.user.deletion_requested_at = data.deletionRequestedAt;
      req.session.user.deletion_scheduled_for = data.deletionScheduledFor;
      req.session.user.deleted_at = data.deletedAt;
    }
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.post("/deletion/cancel", authMiddleware, async (req, res, next) => {
  try {
    const data = await AccountDeletionService.cancelDeletion(req.user.id);
    if (req.user) {
      req.user.account_status = data.accountStatus;
      req.user.deletion_requested_at = data.deletionRequestedAt;
      req.user.deletion_scheduled_for = data.deletionScheduledFor;
    }
    if (req.session?.user) {
      req.session.user.account_status = data.accountStatus;
      req.session.user.deletion_requested_at = data.deletionRequestedAt;
      req.session.user.deletion_scheduled_for = data.deletionScheduledFor;
      req.session.user.deleted_at = data.deletedAt;
    }
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
