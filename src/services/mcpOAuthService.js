import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import pool from "./database.js";
import { Pool } from "pg";
import { oauthFailure, mcpScopes } from "./mcpConfig.js";
import { publicWorkoutId } from "./publicWorkoutApiService.js";

export const mcpTokenHash = value => createHash("sha256").update(value).digest("hex");
const secret = () => `woa_mcp_${randomBytes(32).toString("base64url")}`;
const validToken = value => typeof value === "string" && /^woa_mcp_[A-Za-z0-9_-]{43}$/.test(value);
const oauthDatabase = new Pool({ ...pool.options, max: 4, connectionTimeoutMillis: 5000, statement_timeout: 5000 });

export default class McpOAuthService {
  constructor(config, database = oauthDatabase) { this.config = config; this.database = database; }

  client(id, suppliedSecret) {
    const client = this.config.clients.find(value => value.client_id === id);
    if (!client) oauthFailure(401, "invalid_client");
    if (suppliedSecret !== undefined) {
      if (typeof suppliedSecret !== "string" || suppliedSecret.length > 4096 || !client.secret_sha256
        || !timingSafeEqual(Buffer.from(mcpTokenHash(suppliedSecret)), Buffer.from(client.secret_sha256))) {
        oauthFailure(401, "invalid_client");
      }
    } else if (client.secret_sha256) oauthFailure(401, "invalid_client");
    return client;
  }

  authorization(params) {
    const allowed = ["response_type", "client_id", "redirect_uri", "scope", "state", "code_challenge", "code_challenge_method", "resource"];
    for (const key of params.keys()) if (!allowed.includes(key) || params.getAll(key).length !== 1) oauthFailure(400, "invalid_request");
    const client = this.config.clients.find(value => value.client_id === params.get("client_id"));
    if (!client || !client.redirect_uris.includes(params.get("redirect_uri"))) oauthFailure(400, "invalid_request");
    if (params.get("response_type") !== "code" || params.get("resource") !== this.config.resource
      || params.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(params.get("code_challenge") || "")
      || (params.has("state") && (!params.get("state") || params.get("state").length > 1024))) oauthFailure(400, "invalid_request");
    return { clientId: client.client_id, clientName: client.client_name, redirectUri: params.get("redirect_uri"),
      challenge: params.get("code_challenge"), state: params.get("state"), scopes: mcpScopes(params.get("scope") ?? undefined) };
  }

  async transaction(operation) {
    const db = await this.database.connect();
    try {
      await db.query("BEGIN");
      const result = await operation(db);
      await db.query("COMMIT");
      return result;
    } catch (error) { await db.query("ROLLBACK").catch(() => {}); throw error; }
    finally { db.release(); }
  }

  async authorize(owner, request) {
    const ownerId = publicWorkoutId(String(owner));
    if (typeof request.consentNonce !== "string" || !/^[a-f0-9]{64}$/.test(request.consentNonce)) oauthFailure(403, "access_denied");
    return this.transaction(async db => {
      const { rows } = await db.query("SELECT account_status FROM users WHERE id = $1 FOR UPDATE", [ownerId]);
      if (rows[0]?.account_status !== "active") oauthFailure(403, "access_denied");
      const count = await db.query(`SELECT COUNT(*)::int AS count FROM user_mcp_grants
        WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > NOW()`, [ownerId]);
      if (Number(count.rows[0].count) >= 5) oauthFailure(409, "connection_limit_reached");
      const result = await db.query(`INSERT INTO user_mcp_grants (user_id, client_id, client_name, resource, scopes, consent_hash)
        VALUES ($1, $2, $3, $4, $5::text[], $6) RETURNING id::text`,
      [ownerId, request.clientId, request.clientName, this.config.resource, request.scopes, mcpTokenHash(request.consentNonce)])
        .catch(error => { if (error.code === "23505") oauthFailure(403, "access_denied"); throw error; });
      const code = secret();
      await db.query(`INSERT INTO mcp_oauth_tokens (token_hash, grant_id, kind, expires_at, redirect_uri, code_challenge)
        VALUES ($1, $2, 'code', NOW() + INTERVAL '5 minutes', $3, $4)`,
      [mcpTokenHash(code), result.rows[0].id, request.redirectUri, request.challenge]);
      return code;
    });
  }

  async exchange(input, client) {
    const kind = input.grant_type === "authorization_code" ? "code" : input.grant_type === "refresh_token" ? "refresh" : null;
    if (!kind) oauthFailure(400, "unsupported_grant_type");
    if (input.resource !== this.config.resource) oauthFailure(400, "invalid_target");
    const token = kind === "code" ? input.code : input.refresh_token;
    if (!validToken(token)) oauthFailure(400, "invalid_grant");
    const result = await this.transaction(async db => {
      const { rows } = await db.query(`SELECT g.id::text, g.scopes, g.client_id, g.resource, g.revoked_at,
        g.expires_at > NOW() AS grant_valid, t.expires_at > NOW() AS token_valid,
        t.consumed_at, t.redirect_uri, t.code_challenge, u.account_status
        FROM mcp_oauth_tokens t JOIN user_mcp_grants g ON g.id = t.grant_id JOIN users u ON u.id = g.user_id
        WHERE t.token_hash = $1 AND t.kind = $2 FOR UPDATE OF g, t`, [mcpTokenHash(token), kind]);
      const row = rows[0];
      if (!row || row.client_id !== client.client_id || row.resource !== this.config.resource
        || row.revoked_at || !row.grant_valid || !["active", "pending_deletion"].includes(row.account_status)) oauthFailure(400, "invalid_grant");
      if (row.consumed_at) {
        await db.query("UPDATE user_mcp_grants SET revoked_at = COALESCE(revoked_at, NOW()) WHERE id = $1", [row.id]);
        return null; // Commit replay revocation before returning the OAuth error.
      }
      if (!row.token_valid) oauthFailure(400, "invalid_grant");
      if (kind === "code" && (input.redirect_uri !== row.redirect_uri
        || typeof input.code_verifier !== "string" || !/^[A-Za-z0-9._~-]{43,128}$/.test(input.code_verifier)
        || createHash("sha256").update(input.code_verifier).digest("base64url") !== row.code_challenge)) oauthFailure(400, "invalid_grant");
      if (input.scope !== undefined && mcpScopes(input.scope).join(" ") !== row.scopes.join(" ")) oauthFailure(400, "invalid_scope");
      await db.query("UPDATE mcp_oauth_tokens SET consumed_at = NOW() WHERE token_hash = $1", [mcpTokenHash(token)]);
      const access = secret(), refresh = row.scopes.includes("offline_access") ? secret() : null;
      const accessRow = await db.query(`INSERT INTO mcp_oauth_tokens (token_hash, grant_id, kind, expires_at)
        SELECT $1, id, 'access', LEAST(NOW() + INTERVAL '15 minutes', expires_at) FROM user_mcp_grants WHERE id = $2
        RETURNING GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (expires_at - NOW()))))::int AS expires_in`,
      [mcpTokenHash(access), row.id]);
      if (refresh) await db.query(`INSERT INTO mcp_oauth_tokens (token_hash, grant_id, kind, expires_at)
        SELECT $1, id, 'refresh', expires_at FROM user_mcp_grants WHERE id = $2`, [mcpTokenHash(refresh), row.id]);
      // Expired access tokens are expendable; consumed codes/refresh tokens remain for replay detection.
      await db.query("DELETE FROM mcp_oauth_tokens WHERE grant_id = $1 AND kind = 'access' AND expires_at <= NOW()", [row.id]);
      return { access_token: access, token_type: "Bearer", expires_in: accessRow.rows[0].expires_in, scope: row.scopes.join(" "),
        ...(refresh ? { refresh_token: refresh } : {}) };
    });
    if (!result) oauthFailure(400, "invalid_grant");
    return result;
  }

  async resolve(token) {
    if (!validToken(token)) oauthFailure(401, "invalid_token");
    const { rows } = await this.database.query(`UPDATE user_mcp_grants g SET last_used_at = NOW()
      FROM mcp_oauth_tokens t, users u WHERE t.grant_id = g.id AND u.id = g.user_id
        AND t.token_hash = $1 AND t.kind = 'access' AND t.expires_at > NOW()
        AND t.consumed_at IS NULL AND g.revoked_at IS NULL AND g.expires_at > NOW()
        AND g.resource = $2 AND u.account_status IN ('active', 'pending_deletion')
      RETURNING g.user_id::text, g.id::text, g.client_id, g.scopes`, [mcpTokenHash(token), this.config.resource]);
    if (!rows.length || !this.config.clients.some(client => client.client_id === rows[0].client_id)) oauthFailure(401, "invalid_token");
    return { userId: rows[0].user_id, grantId: rows[0].id, scopes: rows[0].scopes };
  }

  async list(owner) {
    const ownerId = publicWorkoutId(String(owner));
    const { rows } = await this.database.query(`SELECT id::text, client_name, scopes, created_at, expires_at, last_used_at,
      CASE WHEN revoked_at IS NOT NULL THEN 'revoked' WHEN expires_at <= NOW() THEN 'expired' ELSE 'active' END AS status
      FROM user_mcp_grants WHERE user_id = $1
      ORDER BY (revoked_at IS NULL AND expires_at > NOW()) DESC, created_at DESC, id DESC LIMIT 100`, [ownerId]);
    return rows;
  }

  async revoke(owner, id) {
    const ownerId = publicWorkoutId(String(owner));
    publicWorkoutId(id);
    const result = await this.database.query(`UPDATE user_mcp_grants SET revoked_at = COALESCE(revoked_at, NOW())
      WHERE user_id = $1 AND id = $2 RETURNING id`, [ownerId, id]);
    if (!result.rows.length) oauthFailure(404, "connection_not_found");
  }

  async revokeToken(token, client) {
    if (!validToken(token)) return;
    await this.database.query(`UPDATE user_mcp_grants g SET revoked_at = COALESCE(revoked_at, NOW())
      FROM mcp_oauth_tokens t WHERE t.grant_id = g.id AND t.token_hash = $1 AND g.client_id = $2 AND g.resource = $3`,
    [mcpTokenHash(token), client.client_id, this.config.resource]);
  }
}
