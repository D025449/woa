import express from "express";
import { randomBytes, timingSafeEqual } from "node:crypto";
import authMiddleware from "../middleware/authMiddleware.js";
import ApiKeyService from "../services/apiKeyService.js";

const router = express.Router();
const ERROR_CODES = new Set(["invalid_scopes", "invalid_name", "invalid_key_id", "key_not_found",
  "key_limit_reached", "account_pending_deletion", "account_unavailable", "unauthorized"]);

router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  res.set("Referrer-Policy", "no-referrer");
  if (req.get("authorization")) return res.status(401).json({ code: "session_required", error: "Browser session required." });
  next();
}, authMiddleware, (req, res, next) => {
  if (!req.user?.id || !req.session?.user_id || String(req.user.id) !== String(req.session.user_id)) {
    return res.status(401).json({ code: "session_required", error: "Browser session required." });
  }
  next();
});

router.get("/", async (req, res, next) => {
  try {
    const data = await ApiKeyService.list(req.user.id);
    if (!req.session.apiKeyCsrfToken) req.session.apiKeyCsrfToken = randomBytes(32).toString("hex");
    res.json({ data, csrfToken: req.session.apiKeyCsrfToken });
  } catch (error) { next(error); }
});

router.use((req, res, next) => {
  const received = req.get("x-csrf-token");
  const expected = req.session.apiKeyCsrfToken;
  const origin = `${req.protocol}://${req.get("host")}`;
  if (req.get("origin") !== origin || typeof received !== "string" || !/^[a-f0-9]{64}$/.test(received)
    || typeof expected !== "string" || expected.length !== received.length
    || !timingSafeEqual(Buffer.from(received), Buffer.from(expected))) {
    return res.status(403).json({ code: "csrf_failed", error: "Request verification failed." });
  }
  next();
});

router.post("/", async (req, res, next) => {
  try {
    const data = await ApiKeyService.create(req.user.id, { name: req.body?.name, scopes: req.body?.scopes });
    res.status(201).json({ data });
  } catch (error) { next(error); }
});

router.delete("/:id", async (req, res, next) => {
  try {
    await ApiKeyService.revoke(req.user.id, req.params.id);
    res.status(204).end();
  } catch (error) { next(error); }
});

router.use((error, req, res, _next) => {
  if (ERROR_CODES.has(error?.code)) {
    return res.status(error.statusCode).json({ code: error.code, error: error.message });
  }
  return res.status(503).json({ code: "service_unavailable", error: "API key management is unavailable." });
});

export default router;