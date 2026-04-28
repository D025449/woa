import express from "express";

import authMiddleware from "../middleware/authMiddleware.js";
import TrainingPlanDBService from "../services/trainingPlanDBService.js";
import TrainingPlanReviewService from "../services/trainingPlanReviewService.js";
import TrainingPlanService from "../services/trainingPlanService.js";
import TrainingContextService from "../services/trainingContextService.js";

const router = express.Router();

router.get("/context", authMiddleware, async (req, res, next) => {
  try {
    const data = await TrainingContextService.buildUserContext(req.user.id);
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.post("/plan-preview", authMiddleware, async (req, res, next) => {
  try {
    const userContext = await TrainingContextService.buildUserContext(req.user.id);
    const data = TrainingPlanService.generatePreviewPlan(req.body || {}, userContext);
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.post("/plans", authMiddleware, async (req, res, next) => {
  try {
    const input = req.body || {};
    const userContext = await TrainingContextService.buildUserContext(req.user.id);
    const generatedPlan = TrainingPlanService.generatePreviewPlan(input, userContext);
    const data = await TrainingPlanDBService.savePlan(req.user.id, input, generatedPlan);
    res.status(201).json({ data });
  } catch (err) {
    next(err);
  }
});

router.get("/plans", authMiddleware, async (req, res, next) => {
  try {
    const data = await TrainingPlanDBService.listPlans(req.user.id, req.query.limit);
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.get("/plans/latest", authMiddleware, async (req, res, next) => {
  try {
    const data = await TrainingPlanDBService.getLatestPlan(req.user.id);
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.get("/plans/:planId", authMiddleware, async (req, res, next) => {
  try {
    const data = await TrainingPlanDBService.getPlanById(req.user.id, Number(req.params.planId));
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.put("/plans/:planId/weeks/:weekNumber", authMiddleware, async (req, res, next) => {
  try {
    const data = await TrainingPlanDBService.updateWeek(
      req.user.id,
      Number(req.params.planId),
      Number(req.params.weekNumber),
      req.body || {}
    );
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.post("/plans/:planId/weeks/:weekNumber/regenerate", authMiddleware, async (req, res, next) => {
  try {
    const planId = Number(req.params.planId);
    const weekNumber = Number(req.params.weekNumber);
    const storedPlan = await TrainingPlanDBService.getPlanById(req.user.id, planId);
    const userContext = await TrainingContextService.buildUserContext(req.user.id);
    const regeneratedPlan = TrainingPlanService.generatePreviewPlan(storedPlan.input || {}, userContext);
    const regeneratedWeek = (regeneratedPlan.weeks || []).find((week) => Number(week.weekNumber) === weekNumber);

    if (!regeneratedWeek) {
      const error = new Error("Training plan week not found");
      error.statusCode = 404;
      throw error;
    }

    const data = await TrainingPlanDBService.replaceWeekWithGenerated(
      req.user.id,
      planId,
      weekNumber,
      regeneratedWeek
    );

    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.put("/plans/:planId/name", authMiddleware, async (req, res, next) => {
  try {
    const data = await TrainingPlanDBService.updatePlanName(
      req.user.id,
      Number(req.params.planId),
      req.body?.name
    );
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.post("/plans/:planId/review", authMiddleware, async (req, res, next) => {
  try {
    const planId = Number(req.params.planId);
    const plan = await TrainingPlanDBService.getPlanById(req.user.id, planId);
    const reviewData = await TrainingPlanReviewService.reviewWeek(req.user.id, plan);
    const data = await TrainingPlanDBService.replaceReviewData(req.user.id, planId, reviewData);
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.use((err, req, res, next) => {
  if (err?.statusCode) {
    return res.status(err.statusCode).json({ error: err.message });
  }

  console.error("coaching route failed:", err);
  return res.status(500).json({ error: err?.message || "Coaching request failed" });
});

export default router;
