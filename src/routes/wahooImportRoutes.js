import express from "express";
import authMiddleware from "../middleware/authMiddleware.js";
import requireActiveAccountWrite from "../middleware/requireActiveAccountWrite.js";
import WahooImportService, { validateWahooId } from "../services/wahooImportService.js";

const router = express.Router();
router.use(authMiddleware, (req, res, next) => {
  res.set("Cache-Control", "no-store");
  res.set("Referrer-Policy", "no-referrer");
  if (!req.user?.id) return res.status(401).json({ error: "Unauthorized", code: "unauthorized" });
  next();
}, requireActiveAccountWrite);
router.get("/activities", async (req, res, next) => {
  try { res.json({ data: await WahooImportService.activities(req.user.id, req.query.start ?? 0) }); }
  catch (error) { next(error); }
});
router.get("/activities/:id/file", async (req, res, next) => {
  try {
    const id = validateWahooId(req.params.id);
    const data = await WahooImportService.file(req.user.id, id);
    res.set("Content-Type", "application/vnd.ant.fit");
    res.set("Content-Disposition", `attachment; filename="${id}.fit"`);
    res.send(data);
  } catch (error) { next(error); }
});
router.use((error, req, res, _next) => {
  const code = /^wahoo_[a-z_]+$/.test(error.code || "") ? error.code : "wahoo_unavailable";
  res.status([400, 502].includes(error.statusCode) ? error.statusCode : 502).json({ error: "Wahoo request failed", code });
});
export default router;
