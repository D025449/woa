import express from "express";
import Connection, { wahooUserId } from "../services/wahooConnectionService.js";
import { validWebhookToken, receiveWahooWebhook } from "../services/wahooWebhookService.js";

const router = express.Router();
router.use((req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
router.post("/", express.json({ limit: "64kb" }), async (req, res) => {
  if (!Connection.webhookAvailable()) return res.status(503).json({ error: "Webhook unavailable" });
  if (!validWebhookToken(req.body?.webhook_token)) return res.status(401).json({ error: "Unauthorized" });
  if (req.body?.event_type === "workout_summary") {
    try {
      wahooUserId(req.body.user);
      wahooUserId(req.body.workout_summary);
      wahooUserId(req.body.workout_summary?.workout);
    } catch { return res.status(400).json({ error: "Invalid webhook" }); }
  }
  try {
    await receiveWahooWebhook(req.body);
    return res.status(200).json({ ok: true });
  } catch { return res.status(503).json({ error: "Webhook unavailable" }); }
});
// Keep parser errors and payloads out of the global error logger.
router.use((error, req, res, _next) => {
  res.status(error?.type === "entity.too.large" ? 413 : 400).json({ error: "Invalid webhook" });
});
export default router;
