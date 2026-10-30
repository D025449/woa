import pool from "./database.js";
import { decryptGarminKey } from "./garminConnectionService.js";

const BASE = "https://personal.connectapi.garmin.com";
const TOKEN_PATH = "/personalapitoken-service/personal-api/personal-api-key/token";
const tokens = new Map();
const MAX_ZIP = 64 * 1024 * 1024;

function failure(code, statusCode = 502) {
  return Object.assign(new Error(code), { code, statusCode });
}

const TECHNICAL_CODES = new Set([
  "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENETUNREACH",
  "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET", "UND_ERR_RESPONSE_STATUS_CODE", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID", "TIMEOUT", "NETWORK_ERROR",
  "HTTP_ERROR", "INVALID_RESPONSE", "RESPONSE_TOO_LARGE", "STORAGE_ERROR", "DATABASE_ERROR", "INTERNAL_ERROR"
]);

export function garminDiagnostic(error) {
  const value = error?.diagnostic || {};
  return {
    stage: ["token", "activities", "download", "credentials", "storage"].includes(value.stage) ? value.stage : "internal",
    ...(Number.isInteger(value.upstreamStatus) && value.upstreamStatus >= 100 && value.upstreamStatus <= 599
      ? { upstreamStatus: value.upstreamStatus } : {}),
    technicalCode: TECHNICAL_CODES.has(value.technicalCode) ? value.technicalCode : "INTERNAL_ERROR"
  };
}

async function bytes(response, max) {
  if (Number(response.headers.get("content-length")) > max) throw failure("garmin_too_large");
  const reader = response.body?.getReader();
  if (!reader) throw failure("garmin_invalid_response");
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > max) throw failure("garmin_too_large");
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks, total);
}

async function call(path, authorization, { token = false, zip = false } = {}) {
  const stage = token ? "token" : zip ? "download" : "activities";
  let upstreamStatus;
  try {
    const response = await fetch(`${BASE}${path}`, {
      method: token ? "POST" : "GET",
      headers: { Authorization: authorization, Accept: token ? "*/*" : zip ? "application/x-zip-compressed" : "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(60_000)
    });
    upstreamStatus = response.status;
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 401) throw failure(token ? "garmin_invalid_key" : "garmin_token_expired", 401);
      if (response.status === 403) throw failure("garmin_forbidden", 403);
      if (response.status === 404) throw failure("garmin_not_found", 404);
      if (response.status === 429) throw failure("garmin_rate_limit", 429);
      throw failure("garmin_unavailable");
    }
    const data = await bytes(response, zip ? MAX_ZIP : token ? 65536 : 2 * 1024 * 1024);
    if (zip) {
      if (data.length < 4 || data[0] !== 0x50 || data[1] !== 0x4b || data[2] !== 3 || data[3] !== 4) {
        throw failure("garmin_invalid_response");
      }
      return data;
    }
    const text = data.toString("utf8").trim();
    let parsed;
    try { parsed = JSON.parse(text); }
    catch {
      const contentType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (token && ["text/plain", "application/jwt"].includes(contentType)
          && /^[A-Za-z0-9._~+/-]+=*$/.test(text)) {
        return { access_token: text };
      }
      throw failure("garmin_invalid_response");
    }
    return token && typeof parsed === "string" ? { access_token: parsed } : parsed;
  } catch (error) {
    const candidate = error?.cause?.code || error?.code;
    const technicalCode = error?.name === "TimeoutError" || error?.name === "AbortError" ? "TIMEOUT"
      : TECHNICAL_CODES.has(candidate) ? candidate
      : error?.code === "garmin_too_large" ? "RESPONSE_TOO_LARGE"
      : upstreamStatus >= 400 ? "HTTP_ERROR"
      : error?.statusCode ? "INVALID_RESPONSE" : "NETWORK_ERROR";
    const result = error?.statusCode ? error : failure("garmin_unavailable");
    result.diagnostic = { stage, upstreamStatus, technicalCode };
    // Only allowlisted metadata is returned; never attach original exceptions or bodies.
    throw result;
  }
}

async function credential(userId) {
  let rows;
  try {
    ({ rows } = await pool.query("SELECT api_key_encrypted FROM user_garmin_connections WHERE user_id = $1", [userId]));
  } catch {
    throw Object.assign(failure("garmin_unavailable", 500), {
      diagnostic: { stage: "credentials", technicalCode: "DATABASE_ERROR" }
    });
  }
  if (!rows.length) {
    tokens.delete(String(userId));
    throw failure("garmin_not_configured", 409);
  }
  return rows[0].api_key_encrypted;
}

async function accessToken(userId, envelope) {
  const id = String(userId);
  const entry = tokens.get(id);
  if (entry?.envelope === envelope) {
    if (entry.expiresAt > Date.now() + 60_000) return entry.token;
    if (entry.pending) return entry.pending;
  }
  let apiKey;
  try { apiKey = decryptGarminKey(userId, envelope); }
  catch {
    throw Object.assign(failure("garmin_storage_unavailable", 503), {
      diagnostic: { stage: "storage", technicalCode: "STORAGE_ERROR" }
    });
  }
  const next = { envelope, expiresAt: 0, token: "", pending: null };
  next.pending = (async () => {
    const data = await call(TOKEN_PATH, `ApiKey ${apiKey}`, { token: true });
    // Accept OAuth snake_case and Garmin camelCase response field names.
    const token = data?.access_token || data?.accessToken;
    if (typeof token !== "string" || !token || !/^[A-Za-z0-9._~+/-]+=*$/.test(token)) {
      throw Object.assign(failure("garmin_invalid_response"), {
        diagnostic: { stage: "token", upstreamStatus: 200, technicalCode: "INVALID_RESPONSE" }
      });
    }
    let lifetime = Math.min(Number(data.expires_in ?? data.expiresIn) || 86400, 86400);
    try {
      const exp = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")).exp;
      if (Number.isFinite(exp)) lifetime = Math.min(lifetime, exp - Date.now() / 1000);
    } catch { /* Opaque tokens are valid too. */ }
    next.token = token;
    next.expiresAt = Date.now() + Math.max(0, lifetime) * 1000;
    return token;
  })();
  if (tokens.size >= 1000) tokens.delete(tokens.keys().next().value);
  tokens.set(id, next);
  try { return await next.pending; }
  finally { next.pending = null; }
}

async function authorized(userId, path, zip = false) {
  const envelope = await credential(userId); // Re-read to detect replacement/removal across processes.
  let token = await accessToken(userId, envelope);
  try { return await call(path, `Bearer ${token}`, { zip }); }
  catch (error) {
    if (error.code !== "garmin_token_expired") throw error;
    if (tokens.get(String(userId))?.token === token) tokens.delete(String(userId));
    token = await accessToken(userId, await credential(userId));
    return call(path, `Bearer ${token}`, { zip });
  }
}

export function validateGarminActivityId(value) {
  const id = String(value);
  if (!/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n) {
    throw failure("garmin_invalid_activity", 400);
  }
  return id;
}

export default class GarminConnectService {
  static async activities(userId) {
    const data = await authorized(userId, "/activitylist-service/activities/search/activities?start=0&limit=20&sortBy=startLocal&sortOrder=desc");
    if (!Array.isArray(data)) {
      throw Object.assign(failure("garmin_invalid_response"), {
        diagnostic: { stage: "activities", upstreamStatus: 200, technicalCode: "INVALID_RESPONSE" }
      });
    }
    return data.slice(0, 20).map(activity => {
      if (typeof activity.activityId === "number" && !Number.isSafeInteger(activity.activityId)) throw failure("garmin_invalid_response");
      return {
        id: validateGarminActivityId(activity.activityId),
        name: String(activity.activityName || "").slice(0, 300),
        startTime: String(activity.startTimeLocal || "").slice(0, 30),
        sport: String(activity.activityType?.typeKey || "").slice(0, 80),
        duration: Math.max(0, Number(activity.duration) || 0)
      };
    });
  }

  static async file(userId, activityId) {
    return authorized(userId, `/download-service/files/activity/${validateGarminActivityId(activityId)}`, true);
  }
}
