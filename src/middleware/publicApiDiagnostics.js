import { randomUUID } from "node:crypto";

const contexts = new WeakMap();
const methods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const routes = new Set(["/workouts", "/workouts/:id", "/workouts/:id/gps", "/workouts/:id/export.fit",
  "/summary", "/training-load", "/power-profile", "/ftp-history", "/mcp",
  "/oauth/mcp/authorize", "/oauth/mcp/token", "/oauth/mcp/revoke",
  "/api/profile/mcp-connections", "/api/profile/mcp-connections/:id"]);
const reasons = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND",
  "28000", "28P01", "42501", "42P01", "42703", "23503", "23505", "23514",
  "53300", "53400", "57P01", "57P02", "57P03", "57014", "08000", "08001",
  "08003", "08004", "08006", "08P01", "40001", "40P01"]);
const writeLog = entry => console.error(JSON.stringify(entry));

export function apiRequestId(req) {
  if (!contexts.has(req)) contexts.set(req, { id: randomUUID(), family: "public_api", logger: writeLog });
  return contexts.get(req).id;
}

export function publicApiDiagnostics(family, logger = writeLog) {
  return (req, res, next) => {
    contexts.set(req, { id: randomUUID(), family, logger });
    res.set("X-Request-ID", apiRequestId(req));
    next();
  };
}

export function reportApiError(req, status, code, error) {
  const request_id = apiRequestId(req), context = contexts.get(req);
  let reason = reasons.has(error?.code) ? error.code : status < 500 ? code : "unexpected_error";
  if (status >= 500 && typeof error?.message === "string"
    && error.message.includes("client password must be a string")) reason = "database_password_type";
  // Never log request URLs, headers, bodies, identities, exception messages or stacks.
  try { context.logger({ event: "public_api_error", request_id, family: context.family,
    method: methods.has(req.method) ? req.method : "OTHER", route: routes.has(req.route?.path) ? req.route.path : null,
    status, code, reason }); } catch { /* Diagnostics must not change the response. */ }
  return request_id;
}

export function publicApiError(req, res, status, code, message, error = undefined) {
  const request_id = reportApiError(req, status, code, error);
  res.set("X-Request-ID", request_id);
  res.set("Content-Type", "application/json");
  return res.status(status).json({ error: { code, message, request_id } });
}
