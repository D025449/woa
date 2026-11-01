import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import pool from "./database.js";

export function wahooUserId(profile) {
  const value = profile?.id;
  if ((typeof value !== "string" && typeof value !== "number") ||
      (typeof value === "number" && !Number.isSafeInteger(value)) ||
      !/^[1-9][0-9]{0,18}$/.test(String(value)) || BigInt(value) > 9223372036854775807n) {
    throw new Error("Wahoo request failed");
  }
  return String(value);
}
function authenticatedRequest(tokens, path) {
  return jsonRequest(`https://api.wahooligan.com${path}`, {
    headers: { Authorization: `Bearer ${tokens.accessToken}`, Accept: "application/json" }
  }, 1024 * 1024);
}

function key() {
  const value = process.env.WAHOO_TOKEN_ENCRYPTION_KEY || "";
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error("Wahoo storage unavailable");
  return Buffer.from(value, "hex");
}
export function encryptWahooTokens(userId, tokens) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from(`wahoo:${userId}`));
  const data = Buffer.concat([cipher.update(JSON.stringify(tokens), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(":");
}
export function decryptWahooTokens(userId, envelope) {
  const [version, iv, tag, data] = envelope.split(":");
  if (version !== "v1" || !iv || !tag || !data) throw new Error("Invalid Wahoo envelope");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  decipher.setAAD(Buffer.from(`wahoo:${userId}`));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8"));
}
async function jsonRequest(url, options, maxBytes = 65536) {
  try {
    const response = await fetch(url, { ...options, redirect: "error", signal: AbortSignal.timeout(15000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error("Wahoo request failed"); }
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maxBytes) throw new Error("Wahoo response too large");
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel(); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch { throw new Error("Wahoo request failed"); }
}
export default class WahooConnectionService {
  static config() {
    const clientId = process.env.WAHOO_CLIENT_ID;
    const clientSecret = process.env.WAHOO_CLIENT_SECRET;
    const redirectUri = process.env.WAHOO_REDIRECT_URI;
    if (!clientId || !clientSecret || !redirectUri) throw new Error("Wahoo is not configured");
    const url = new URL(redirectUri);
    if ((url.protocol !== "https:" && !(process.env.NODE_ENV !== "production" &&
        url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) ||
        url.pathname !== "/auth/wahoo/callback" || url.search || url.hash || url.username || url.password) {
      throw new Error("Invalid Wahoo redirect URI");
    }
    key();
    return { clientId, clientSecret, redirectUri };
  }
  static authorizationUrl(state) {
    const { clientId, redirectUri } = this.config();
    const url = new URL("https://api.wahooligan.com/oauth/authorize");
    url.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri,
      scope: "user_read workouts_read offline_data", response_type: "code", state }).toString();
    return url.href;
  }
  static async exchange(parameters) {
    const { clientId, clientSecret, redirectUri } = this.config();
    const data = await jsonRequest("https://api.wahooligan.com/oauth/token", {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, ...parameters })
    });
    if (![data?.access_token, data?.refresh_token].every(value =>
      typeof value === "string" && value.length > 0 && value.length <= 16384 && !/\s/.test(value)) ||
      typeof data.expires_in !== "number" || !Number.isFinite(data.expires_in) || data.expires_in <= 0 ||
      data.expires_in > 365 * 86400 || String(data.token_type).toLowerCase() !== "bearer") {
      throw new Error("Invalid Wahoo token response");
    }
    return { accessToken: data.access_token, refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
      offlineDataGranted: data.scope == null || (typeof data.scope === "string" && data.scope.split(/\s+/).includes("offline_data")) };
  }
  static async connect(userId, code) {
    try {
      const tokens = await this.exchange({ grant_type: "authorization_code", code });
      const id = wahooUserId(await authenticatedRequest(tokens, "/v1/user"));
      await pool.query(`INSERT INTO user_wahoo_connections (user_id, tokens_encrypted, wahoo_user_id, offline_data_granted)
        VALUES ($1, $2, $3, $4) ON CONFLICT (user_id) DO UPDATE
        SET tokens_encrypted = EXCLUDED.tokens_encrypted, wahoo_user_id = EXCLUDED.wahoo_user_id,
        offline_data_granted = EXCLUDED.offline_data_granted, auto_import_enabled = FALSE, updated_at = NOW()`,
      [userId, encryptWahooTokens(userId, tokens), id, tokens.offlineDataGranted]);
    } catch { throw new Error("Wahoo request failed"); }
  }
  static async status(userId) {
    let available = true;
    try { this.config(); } catch { available = false; }
    const { rows } = await pool.query("SELECT updated_at, auto_import_enabled, offline_data_granted FROM user_wahoo_connections WHERE user_id = $1", [userId]);
    return { configured: rows.length > 0, available, updatedAt: rows[0]?.updated_at || null,
      autoImportEnabled: rows[0]?.auto_import_enabled === true,
      offlineDataGranted: rows[0]?.offline_data_granted === true,
      webhookAvailable: this.webhookAvailable() };
  }
  static webhookAvailable() {
    const token = process.env.WAHOO_WEBHOOK_TOKEN || "";
    return token.length >= 32 && token.length <= 512;
  }
  static async setAutoImport(userId, enabled) {
    if (typeof enabled !== "boolean" || (enabled && !this.webhookAvailable())) throw new Error("Wahoo settings unavailable");
    const result = await pool.query(`UPDATE user_wahoo_connections
      SET auto_import_enabled = $2, updated_at = NOW()
      WHERE user_id = $1 AND ($2 = FALSE OR (offline_data_granted = TRUE AND wahoo_user_id IS NOT NULL))`, [userId, enabled]);
    if (result.rowCount !== 1) throw new Error("Wahoo settings unavailable");
  }
  // Internal operation: credentials never leave the service. Row locking
  // serializes refreshes across app processes and coordinates with disconnect.
  static async readUser(userId) {
    return this.apiRequest(userId, "/v1/user");
  }
  static async apiRequest(userId, path) {
    const client = await pool.connect();
    let committed = false;
    try {
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT tokens_encrypted, wahoo_user_id FROM user_wahoo_connections WHERE user_id = $1 FOR UPDATE", [userId]);
      if (!rows.length) throw new Error("Wahoo is not connected");
      let tokens = decryptWahooTokens(userId, rows[0].tokens_encrypted);
      if (tokens.expiresAt <= Date.now() + 60000) {
        tokens = await this.exchange({ grant_type: "refresh_token", refresh_token: tokens.refreshToken });
        rows[0].tokens_encrypted = encryptWahooTokens(userId, tokens);
        await client.query("UPDATE user_wahoo_connections SET tokens_encrypted = $2, updated_at = NOW() WHERE user_id = $1",
          [userId, rows[0].tokens_encrypted]);
      }
      // Preserve rotated credentials even if the following API request fails.
      await client.query("COMMIT");
      committed = true;
      let profile;
      if (rows[0].wahoo_user_id == null) {
        profile = await authenticatedRequest(tokens, "/v1/user");
        const id = wahooUserId(profile);
        // Do not attach a stale profile after disconnect/reconnect or token rotation.
        const result = await client.query(`UPDATE user_wahoo_connections SET wahoo_user_id = $2
          WHERE user_id = $1 AND tokens_encrypted = $3 AND wahoo_user_id IS NULL`,
        [userId, id, rows[0].tokens_encrypted]);
        if (result.rowCount !== 1) throw new Error("Wahoo request failed");
      }
      return path === "/v1/user" && profile ? profile : await authenticatedRequest(tokens, path);
    } catch {
      if (!committed) await client.query("ROLLBACK");
      throw new Error("Wahoo request failed");
    } finally { client.release(); }
  }
  static async remove(userId) {
    await pool.query("DELETE FROM user_wahoo_connections WHERE user_id = $1", [userId]);
  }
}
