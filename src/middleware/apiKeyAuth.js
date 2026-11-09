import { randomUUID } from "node:crypto";
import ApiKeyService, { API_KEY_SCOPES } from "../services/apiKeyService.js";

export default function apiKeyAuth(requiredScopes = []) {
  if (!Array.isArray(requiredScopes) || requiredScopes.some(scope => !API_KEY_SCOPES.includes(scope))) {
    throw new TypeError("Unknown API scope requirement");
  }
  const required = requiredScopes.includes("workouts:fit:read")
    ? ["workouts:read", "workouts:gps:read", "workouts:fit:read"]
    : requiredScopes.includes("workouts:gps:read")
    ? ["workouts:read", "workouts:gps:read"] : [...requiredScopes];
  return async (req, res, next) => {
    delete req.apiAuth;
    res.set("Cache-Control", "no-store");
    const reject = (status, code, message) => {
      if (status === 401) res.set("WWW-Authenticate", 'Bearer realm="woa-api"');
      return res.status(status).json({ error: { code, message, request_id: randomUUID() } });
    };
    const header = req.get("authorization");
    const match = typeof header === "string" && /^Bearer (\S+)$/i.exec(header);
    if (!match) return reject(401, "unauthorized", "API key required.");
    try {
      const context = await ApiKeyService.resolve(match[1]);
      if (required.some(scope => !context.scopes.includes(scope))) {
        return reject(403, "insufficient_scope", "Required API scope is missing.");
      }
      req.apiAuth = context;
      return next();
    } catch (error) {
      if (error?.statusCode === 401) return reject(401, "unauthorized", "Invalid API key.");
      if (error?.statusCode === 403) return reject(403, "account_unavailable", "Account is not available.");
      return reject(503, "service_unavailable", "API authentication is unavailable.");
    }
  };
}
