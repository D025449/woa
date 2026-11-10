import express from "express";
import { publicApiDiagnostics, publicApiError } from "../middleware/publicApiDiagnostics.js";
import { PUBLIC_API_QUOTAS } from "../services/publicApiLimits.js";
import apiKeyAuth from "../middleware/apiKeyAuth.js";
import publicApiRateLimit from "../middleware/publicApiRateLimit.js";
import PublicAnalyticsApiService, { PUBLIC_ANALYTICS_LIMITS } from "../services/publicAnalyticsApiService.js";
import { apiFailure } from "../services/publicWorkoutApiService.js";

export function createPublicAnalyticsApiRouter({ service = new PublicAnalyticsApiService(), rateLimit = publicApiRateLimit,
  httpsOnly = process.env.NODE_ENV === "production" } = {}) {
  const router = express.Router();
  router.use(publicApiDiagnostics("analytics"));
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    res.set("Referrer-Policy", "no-referrer");
    res.set("X-Content-Type-Options", "nosniff");
    if (httpsOnly && !req.secure) apiFailure(400, "invalid_request", "HTTPS is required.");
    if (req.method !== "GET") { res.set("Allow", "GET"); apiFailure(405, "method_not_allowed", "Only GET is supported."); }
    next();
  });
  router.use(rateLimit("ingress", PUBLIC_API_QUOTAS.ingress, req => req.ip), apiKeyAuth(["analytics:read"]),
    rateLimit("user", PUBLIC_API_QUOTAS.user, req => req.apiAuth.userId));
  for (const [path, method] of [["/summary", "summary"], ["/training-load", "trainingLoad"],
    ["/power-profile", "powerProfile"], ["/ftp-history", "ftpHistory"]]) {
    router.get(path, (req, res, next) => {
      if (path === "/power-profile" && !req.apiAuth.scopes.includes("workouts:read")) {
        apiFailure(403, "insufficient_scope", "Required API scope is missing.");
      }
      next();
    }, rateLimit("analytics", PUBLIC_API_QUOTAS.analytics, req => req.apiAuth.userId), async (req, res, next) => {
      try {
        const params = new URL(req.originalUrl, "https://api.invalid").searchParams;
        const json = JSON.stringify(await service[method](req.apiAuth.userId, params));
        if (Buffer.byteLength(json) > PUBLIC_ANALYTICS_LIMITS.responseBytes) {
          apiFailure(422, "analytics_response_too_large", "Analytics response exceeds the configured budget.");
        }
        res.type("application/json").send(json);
      } catch (error) { next(error); }
    });
  }
  router.use(() => { apiFailure(404, "not_found", "API endpoint not found."); });
  router.use((error, req, res, _next) => {
    const messages = { invalid_request: [400, "Invalid analytics interval or query parameters."],
      insufficient_scope: [403, "Required API scope is missing."],
      method_not_allowed: [405, "Only GET is supported."], not_found: [404, "API endpoint not found."],
      analytics_response_too_large: [422, "Analytics exceeds the configured budget."],
      rate_limited: [429, "Analytics processing capacity exceeded."] };
    const code = error instanceof URIError ? "invalid_request" : Object.hasOwn(messages, error?.code) ? error.code : "service_unavailable";
    const [status, message] = messages[code] || [503, "Analytics service unavailable."];
    if (status === 429) res.set("Retry-After", "1");
    publicApiError(req, res, status, code, message, error);
  });
  return router;
}

export default createPublicAnalyticsApiRouter();
