import { createHash, randomBytes } from "node:crypto";
import pool from "./database.js";

export const API_KEY_SCOPES = Object.freeze(["workouts:read", "workouts:gps:read", "workouts:fit:read"]);
export const API_KEY_LIMIT = 5;
export const API_KEY_LIFETIME_DAYS = 90;
const KEY_PATTERN = /^woa_pk_[A-Za-z0-9_-]{43}$/;
const METADATA_COLUMNS = "id::text, name, key_prefix, scopes, created_at, expires_at, revoked_at, last_used_at";

function fail(statusCode, code, message) {
  throw Object.assign(new Error(message), { statusCode, code });
}

function userId(value) {
  const text = String(value ?? "");
  if (!/^[1-9][0-9]{0,18}$/.test(text) || BigInt(text) > 9223372036854775807n
    || (typeof value === "number" && !Number.isSafeInteger(value))) {
    fail(401, "unauthorized", "Authentication required.");
  }
  return text;
}

export function normalizeApiKeyScopes(scopes) {
  if (!Array.isArray(scopes) || scopes.length < 1 || scopes.length > API_KEY_SCOPES.length
    || scopes.some(scope => !API_KEY_SCOPES.includes(scope))
    || new Set(scopes).size !== scopes.length || !scopes.includes("workouts:read")
    || (scopes.includes("workouts:fit:read") && !scopes.includes("workouts:gps:read"))) {
    fail(400, "invalid_scopes", "Select valid API scopes; FIT requires workout and GPS read access.");
  }
  return API_KEY_SCOPES.filter(scope => scopes.includes(scope));
}

function metadata(row) {
  return {
    id: String(row.id), name: row.name, prefix: row.key_prefix,
    scopes: row.scopes, createdAt: row.created_at, expiresAt: row.expires_at,
    revokedAt: row.revoked_at, lastUsedAt: row.last_used_at,
    status: row.status || "active"
  };
}

async function account(database, ownerId, lock = false) {
  const { rows } = await database.query(
    `SELECT account_status FROM users WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [ownerId]
  );
  const status = rows[0]?.account_status;
  if (!["active", "pending_deletion"].includes(status)) {
    fail(403, "account_unavailable", "Account is not available.");
  }
  return status;
}

export default class ApiKeyService {
  static async list(owner, database = pool) {
    const ownerId = userId(owner);
    const status = await account(database, ownerId);
    const { rows } = await database.query(`SELECT ${METADATA_COLUMNS},
      CASE WHEN revoked_at IS NOT NULL THEN 'revoked'
        WHEN expires_at <= NOW() THEN 'expired' ELSE 'active' END AS status
      FROM user_api_keys WHERE user_id = $1
      ORDER BY (revoked_at IS NULL AND expires_at > NOW()) DESC, created_at DESC, id DESC LIMIT 100`, [ownerId]);
    return { keys: rows.map(metadata), canCreate: status === "active",
      limits: { maxActiveKeys: API_KEY_LIMIT, lifetimeDays: API_KEY_LIFETIME_DAYS } };
  }

  static async create(owner, input, database = pool) {
    const ownerId = userId(owner);
    if (typeof input?.name !== "string" || !input.name.trim() || input.name.trim().length > 80
      || Array.from(input.name).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
      fail(400, "invalid_name", "Enter a key name between 1 and 80 characters.");
    }
    const scopes = normalizeApiKeyScopes(input.scopes);
    const client = await database.connect();
    try {
      await client.query("BEGIN");
      if (await account(client, ownerId, true) !== "active") {
        fail(423, "account_pending_deletion", "Cancel account deletion before creating keys.");
      }
      const count = await client.query(`SELECT COUNT(*)::int AS count FROM user_api_keys
        WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > NOW()`, [ownerId]);
      if (Number(count.rows[0].count) >= API_KEY_LIMIT) {
        fail(409, "key_limit_reached", "Revoke an active key before creating another.");
      }
      const secret = `woa_pk_${randomBytes(32).toString("base64url")}`;
      const hash = createHash("sha256").update(secret).digest("hex");
      const { rows } = await client.query(`INSERT INTO user_api_keys
        (user_id, name, key_prefix, key_hash, scopes, expires_at)
        VALUES ($1, $2, $3, $4, $5::text[], NOW() + INTERVAL '90 days')
        RETURNING ${METADATA_COLUMNS}`, [ownerId, input.name.trim(), secret.slice(0, 17), hash, scopes]);
      await client.query("COMMIT");
      return { key: metadata(rows[0]), secret };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  static async revoke(owner, keyId, database = pool) {
    const ownerId = userId(owner);
    if (typeof keyId !== "string" || !/^[1-9][0-9]{0,18}$/.test(keyId)
      || BigInt(keyId) > 9223372036854775807n) fail(400, "invalid_key_id", "Invalid key ID.");
    const { rows } = await database.query(`UPDATE user_api_keys k
      SET revoked_at = COALESCE(k.revoked_at, NOW())
      WHERE k.id = $1 AND k.user_id = $2 AND EXISTS (
        SELECT 1 FROM users u WHERE u.id = k.user_id
          AND u.account_status IN ('active', 'pending_deletion'))
      RETURNING k.id`, [keyId, ownerId]);
    if (!rows.length) fail(404, "key_not_found", "Key not found.");
  }

  static async resolve(secret, database = pool) {
    if (typeof secret !== "string" || !KEY_PATTERN.test(secret)) {
      fail(401, "unauthorized", "Invalid API key.");
    }
    const hash = createHash("sha256").update(secret).digest("hex");
    const { rows } = await database.query(`SELECT k.id::text, k.user_id::text, k.scopes, u.account_status
      FROM user_api_keys k INNER JOIN users u ON u.id = k.user_id
      WHERE k.key_hash = $1 AND k.revoked_at IS NULL AND k.expires_at > NOW()`, [hash]);
    const row = rows[0];
    if (!row) fail(401, "unauthorized", "Invalid API key.");
    if (!["active", "pending_deletion"].includes(row.account_status)) {
      fail(403, "account_unavailable", "Account is not available.");
    }
    let scopes;
    try { scopes = normalizeApiKeyScopes(row.scopes); }
    catch { fail(401, "unauthorized", "Invalid API key."); }
    const touched = await database.query(`UPDATE user_api_keys k SET last_used_at = NOW()
      WHERE k.id = $1 AND k.user_id = $2 AND k.revoked_at IS NULL AND k.expires_at > NOW()
        AND EXISTS (SELECT 1 FROM users u WHERE u.id = k.user_id
          AND u.account_status IN ('active', 'pending_deletion')) RETURNING k.id`, [row.id, row.user_id]);
    if (!touched.rows.length) fail(401, "unauthorized", "Invalid API key.");
    return Object.freeze({ userId: userId(row.user_id), keyId: String(row.id), scopes: Object.freeze(scopes) });
  }
}
