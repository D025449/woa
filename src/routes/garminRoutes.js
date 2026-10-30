import express from "express";
import authMiddleware from "../middleware/authMiddleware.js";
import requireActiveAccountWrite from "../middleware/requireActiveAccountWrite.js";
import GarminConnectService, { validateGarminActivityId, garminDiagnostic } from "../services/garminConnectService.js";

const router = express.Router();
router.use(authMiddleware, (req, res, next) => {
  res.set("Cache-Control", "no-store");
  if (!req.user?.id) return res.status(401).json({ error: "Unauthorized", code: "unauthorized" });
  next();
}, requireActiveAccountWrite);
router.get("/activities", async (req, res, next) => {
  try { res.json({ data: await GarminConnectService.activities(req.user.id) }); }
  catch (error) { next(error); }
});
router.get("/activities/:id/file", async (req, res, next) => {
  try {
    const id = validateGarminActivityId(req.params.id);
    const data = await GarminConnectService.file(req.user.id, id);
    res.set("Content-Type", "application/x-zip-compressed");
    res.set("Content-Disposition", `attachment; filename="${id}.zip"`);
    res.send(data);
  } catch (error) { next(error); }
});
router.use((error, req, res, _next) => {
  const diagnostic = garminDiagnostic(error);
  console.warn("[garmin] request failed", diagnostic);
  res.status(error.statusCode || 500).json({
    error: "Garmin request failed",
    code: /^garmin_[a-z_]+$/.test(error.code || "") ? error.code : "garmin_unavailable",
    diagnostic
  });
});
export default router;
