import express from "express";
import { randomBytes, timingSafeEqual } from "node:crypto";
import authMiddleware from "../middleware/authMiddleware.js";
import requireActiveAccountWrite from "../middleware/requireActiveAccountWrite.js";
import WahooService from "../services/wahooConnectionService.js";

const router = express.Router();
const saveSession = req => new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
const notice = (res, value) => res.redirect(`/profile?wahoo=${value}#wahoo-settings`);

// Explicit Origin prevents cross-site requests to mutation endpoints.
export function requireWahooOrigin(req, res, next) {
  try {
    if (req.get("origin") !== new URL(process.env.WAHOO_REDIRECT_URI).origin) {
      return res.status(403).json({ error: "Forbidden" });
    }
    next();
  } catch { res.status(503).json({ error: "Wahoo is not configured." }); }
}

router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  res.set("Referrer-Policy", "no-referrer");
  next();
}, authMiddleware, (req, res, next) => {
  if (!req.user?.id) return res.status(401).json({ error: "Unauthorized" });
  next();
});
router.get("/status", async (req, res) => {
  try { res.json({ data: await WahooService.status(req.user.id) }); }
  catch { res.status(503).json({ error: "Wahoo connection unavailable." }); }
});
router.post("/start", requireActiveAccountWrite, requireWahooOrigin, async (req, res) => {
  try {
    const state = randomBytes(32).toString("hex");
    const url = WahooService.authorizationUrl(state);
    req.session.wahooOAuth = { state, userId: req.user.id, createdAt: Date.now() };
    await saveSession(req);
    res.json({ url });
  } catch { res.status(503).json({ error: "Wahoo connection unavailable." }); }
});

export async function wahooCallback(req, res) {
  const pending = req.session?.wahooOAuth;
  if (req.session) delete req.session.wahooOAuth;
  try {
    await saveSession(req);
    const state = req.query.state;
    if (!pending || pending.userId !== req.user.id ||
        Date.now() - pending.createdAt > 10 * 60 * 1000 ||
        typeof state !== "string" || !/^[a-f0-9]{64}$/.test(state) ||
        !timingSafeEqual(Buffer.from(state), Buffer.from(pending.state))) return notice(res, "error");
    if (req.query.error) return notice(res, "denied");
    const code = req.query.code;
    if (typeof code !== "string" || !code || code.length > 4096) return notice(res, "error");
    await WahooService.connect(req.user.id, code);
    return notice(res, "connected");
  } catch { return notice(res, "error"); }
}
router.get("/callback", requireActiveAccountWrite, wahooCallback);
router.delete("/connection", requireActiveAccountWrite, requireWahooOrigin, async (req, res) => {
  try {
    delete req.session.wahooOAuth;
    await saveSession(req);
    await WahooService.remove(req.user.id);
    res.status(204).end();
  } catch { res.status(503).json({ error: "Wahoo connection unavailable." }); }
});
export default router;
