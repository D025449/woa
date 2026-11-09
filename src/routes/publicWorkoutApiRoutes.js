import express from "express";
import { randomUUID } from "node:crypto";
import apiKeyAuth from "../middleware/apiKeyAuth.js";
import publicApiRateLimit from "../middleware/publicApiRateLimit.js";
import PublicWorkoutApiService, { apiFailure } from "../services/publicWorkoutApiService.js";

function query(req) {
  return new URL(req.originalUrl, "https://api.invalid").searchParams;
}

function rejectQuery(req) {
  if ([...query(req).keys()].length) apiFailure(400, "invalid_request", "Query parameters are not accepted here.");
}

export function createPublicWorkoutApiRouter({ service = new PublicWorkoutApiService(), rateLimit = publicApiRateLimit,
  httpsOnly = process.env.NODE_ENV === "production" } = {}) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    res.set("Referrer-Policy", "no-referrer");
    res.set("X-Content-Type-Options", "nosniff");
    if (httpsOnly && !req.secure) apiFailure(400, "invalid_request", "HTTPS is required.");
    if (req.method !== "GET") {
      res.set("Allow", "GET");
      apiFailure(405, "method_not_allowed", "Only GET is supported.");
    }
    next();
  });
  router.use(rateLimit("ingress", 120, req => req.ip), apiKeyAuth(["workouts:read"]),
    rateLimit("user", 60, req => req.apiAuth.userId));

  router.get("/workouts", async (req, res, next) => {
    try { res.json(await service.list(req.apiAuth.userId, query(req))); }
    catch (error) { next(error); }
  });
  router.get("/workouts/:id/export.fit", (req, res, next) => {
    if (!["workouts:gps:read", "workouts:fit:read"].every(scope => req.apiAuth.scopes.includes(scope))) {
      apiFailure(403, "insufficient_scope", "Required API scope is missing.");
    }
    next();
  }, rateLimit("fit", 10, req => req.apiAuth.userId), async (req, res, next) => {
    try {
      rejectQuery(req);
      const result = await service.fit(req.apiAuth.userId, req.params.id);
      res.set("Content-Disposition", `attachment; filename="${result.fileName}"`);
      res.type("application/octet-stream").send(result.bytes);
    } catch (error) { next(error); }
  });
  router.get("/workouts/:id/gps", (req, res, next) => {
    if (!req.apiAuth.scopes.includes("workouts:gps:read")) {
      apiFailure(403, "insufficient_scope", "Required API scope is missing.");
    }
    next();
  }, rateLimit("gps", 10, req => req.apiAuth.userId), async (req, res, next) => {
    try {
      rejectQuery(req);
      res.type("application/geo+json").send(await service.gps(req.apiAuth.userId, req.params.id));
    } catch (error) { next(error); }
  });
  router.get("/workouts/:id", async (req, res, next) => {
    try { rejectQuery(req); res.json(await service.detail(req.apiAuth.userId, req.params.id)); }
    catch (error) { next(error); }
  });
  router.use(() => { apiFailure(404, "not_found", "API endpoint not found."); });
  router.use((error, req, res, _next) => {
    const messages = {
      invalid_request: [400, "Invalid request parameters, ID or cursor."],
      workout_not_found: [404, "Workout not found."], not_found: [404, "API endpoint not found."],
      insufficient_scope: [403, "Required API scope is missing."], method_not_allowed: [405, "Only GET is supported."],
      gps_response_too_large: [422, "GPS response exceeds the configured budget."],
      fit_response_too_large: [422, "FIT export exceeds the configured budget."],
      rate_limited: [429, "Processing capacity exceeded."]
    };
    const code = error instanceof URIError ? "invalid_request" : Object.hasOwn(messages, error?.code) ? error.code : "service_unavailable";
    const [status, message] = messages[code] || [503, "API service unavailable."];
    if (status === 429) res.set("Retry-After", "1");
    res.status(status).type("application/json").json({ error: { code, message, request_id: randomUUID() } });
  });
  return router;
}

export default createPublicWorkoutApiRouter();
