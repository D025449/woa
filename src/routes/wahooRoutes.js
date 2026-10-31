import express from "express";

const router = express.Router();

// Registration placeholder only: discard all OAuth parameters without using them.
export function wahooCallbackPlaceholder(_req, res) {
  res.set("Cache-Control", "no-store");
  res.set("Referrer-Policy", "no-referrer");
  return res.redirect("/profile?wahoo=not-configured#wahoo-notice");
}

router.get("/callback", wahooCallbackPlaceholder);
export default router;
