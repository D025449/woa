import express from "express";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { MCP_SCOPES, oauthFailure, mcpRedirectMatches } from "../services/mcpConfig.js";
import McpOAuthService from "../services/mcpOAuthService.js";
import { createTrainingMcpServer } from "../services/mcpServerService.js";
import publicApiRateLimit from "../middleware/publicApiRateLimit.js";
import { publicApiDiagnostics, reportApiError } from "../middleware/publicApiDiagnostics.js";
import { PUBLIC_API_QUOTAS } from "../services/publicApiLimits.js";

const asyncRoute = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const csrf = () => randomBytes(32).toString("hex");
const sessionOwner = req => req.user?.id && req.session?.user_id
  && String(req.user.id) === String(req.session.user_id) && !req.get("authorization");
function verifiedCsrf(received, expected) {
  return typeof received === "string" && /^[a-f0-9]{64}$/.test(received) && typeof expected === "string"
    && expected.length === received.length && timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}
function saveSession(req) { return new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve())); }
function mcpError(req, res, status, code, error = undefined) {
  reportApiError(req, status, code, error);
  return res.status(status).json({ error: code });
}
function oauthError(error, req, res, _next) {
  const known = new Set(["invalid_request", "invalid_scope", "invalid_client", "invalid_grant", "invalid_target",
    "unsupported_grant_type", "access_denied", "connection_limit_reached", "connection_not_found"]);
  const code = known.has(error?.code) ? error.code : error?.type === "entity.too.large" ? "invalid_request" : "server_error";
  if (code === "invalid_client") res.set("WWW-Authenticate", 'Basic realm="woa-mcp-oauth"');
  const status = code === "server_error" ? 503 : error.statusCode || 400;
  mcpError(req, res, status, code, error);
}

export function createMcpRouters(config, { oauth = new McpOAuthService(config), rateLimit = publicApiRateLimit,
  serverOptions = {}, httpsOnly = true, allowedOrigins = [config.origin] } = {}) {
  const publicRouter = express.Router();
  const browserRouter = express.Router();
  publicRouter.use((req, _res, next) => next(["/mcp", "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-authorization-server",
    "/oauth/mcp/token", "/oauth/mcp/revoke"].includes(req.path) || req.path.startsWith("/mcp/") ? undefined : "router"));
  browserRouter.use((req, _res, next) => next(req.path === "/oauth/mcp/authorize"
    || req.path.startsWith("/api/profile/mcp-connections") ? undefined : "router"));
  publicRouter.use(publicApiDiagnostics("mcp"));
  browserRouter.use(publicApiDiagnostics("mcp_oauth"));
  const headers = (req, res, next) => {
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" });
    if (httpsOnly && !req.secure) return mcpError(req, res, 400, "https_required");
    next();
  };
  publicRouter.use(headers);
  browserRouter.use(headers);
  const resourceMetadata = `${config.origin}/.well-known/oauth-protected-resource/mcp`;
  const challenge = (res, error = null) => res.set("WWW-Authenticate", `Bearer resource_metadata="${resourceMetadata}"${error ? `, error="${error}"` : ""}`);
  for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
    publicRouter.get(path, (_req, res) => {
      res.set("Access-Control-Allow-Origin", "*");
      res.json({ resource: config.resource, authorization_servers: [config.origin], scopes_supported: MCP_SCOPES,
        bearer_methods_supported: ["header"], resource_name: "WOA Training" });
    });
  }
  publicRouter.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.json({ issuer: config.origin, authorization_endpoint: `${config.origin}/oauth/mcp/authorize`,
      token_endpoint: `${config.origin}/oauth/mcp/token`, revocation_endpoint: `${config.origin}/oauth/mcp/revoke`,
      response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"], scopes_supported: MCP_SCOPES,
      token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
      authorization_response_iss_parameter_supported: true });
  });

  const authenticateClient = req => {
    let id = req.body?.client_id, secret;
    const header = req.get("authorization");
    if (header) {
      if (req.body?.client_secret !== undefined || !/^Basic [A-Za-z0-9+/]+=*$/.test(header)) oauthFailure(401, "invalid_client");
      const decoded = Buffer.from(header.slice(6), "base64").toString("utf8"), separator = decoded.indexOf(":");
      if (separator < 0) oauthFailure(401, "invalid_client");
      const basicId = decodeURIComponent(decoded.slice(0, separator).replace(/\+/g, " "));
      secret = decodeURIComponent(decoded.slice(separator + 1).replace(/\+/g, " "));
      if (id !== undefined && id !== basicId) oauthFailure(401, "invalid_client");
      id = basicId;
    } else secret = req.body?.client_secret;
    return oauth.client(id, secret);
  };
  for (const path of ["/oauth/mcp/token", "/oauth/mcp/revoke"]) {
    publicRouter.post(path, rateLimit("mcp-oauth", PUBLIC_API_QUOTAS.oauth, req => req.ip),
      (req, _res, next) => { if (!req.is("application/x-www-form-urlencoded")) oauthFailure(400, "invalid_request"); next(); },
      express.urlencoded({ extended: false, limit: "16kb", parameterLimit: 12 }), asyncRoute(async (req, res) => {
        const allowed = path.endsWith("token")
          ? ["client_id", "client_secret", "grant_type", "code", "redirect_uri", "code_verifier", "resource", "refresh_token", "scope"]
          : ["client_id", "client_secret", "token", "token_type_hint"];
        if (!req.body || Object.entries(req.body).some(([key, value]) => !allowed.includes(key) || typeof value !== "string")) oauthFailure(400, "invalid_request");
        const client = authenticateClient(req);
        if (path.endsWith("token")) res.json(await oauth.exchange(req.body, client));
        else { if (typeof req.body.token !== "string") oauthFailure(400, "invalid_request"); await oauth.revokeToken(req.body.token, client); res.status(200).end(); }
      }));
  }

  publicRouter.use("/mcp", (req, res, next) => {
    if (req.path !== "/" || req.originalUrl.includes("?")) return mcpError(req, res, 400, "invalid_request");
    const origin = req.get("origin");
    if (origin && !allowedOrigins.includes(origin)) return mcpError(req, res, 403, "invalid_origin");
    if (origin) {
      res.set({ "Access-Control-Allow-Origin": origin, "Access-Control-Expose-Headers": "WWW-Authenticate, MCP-Protocol-Version, Retry-After, X-Request-ID" });
      res.vary("Origin");
    }
    if (req.method === "OPTIONS") {
      res.set({ "Access-Control-Allow-Methods": "POST, GET, DELETE",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, MCP-Protocol-Version, MCP-Session-Id" });
      return res.status(204).end();
    }
    next();
  }, rateLimit("ingress", PUBLIC_API_QUOTAS.ingress, req => req.ip), asyncRoute(async (req, _res, next) => {
    const match = /^Bearer (\S+)$/i.exec(req.get("authorization") || "");
    if (!match) oauthFailure(401, "invalid_token");
    req.mcpAuth = await oauth.resolve(match[1]);
    req.mcpBearer = match[1];
    next();
  }), rateLimit("user", PUBLIC_API_QUOTAS.user, req => req.mcpAuth.userId));
  publicRouter.post("/mcp", express.json({ limit: "16kb" }), asyncRoute(async (req, res) => {
    if (!req.body || Array.isArray(req.body)) return mcpError(req, res, 400, "invalid_request");
    const server = createTrainingMcpServer(req.mcpAuth, { ...serverOptions, errorRequest: req, authorize: () => oauth.resolve(req.mcpBearer) });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.once("close", () => { server.close().catch(() => {}); });
    try { await server.connect(transport); await transport.handleRequest(req, res, req.body); }
    finally { await server.close(); }
  }));
  publicRouter.all("/mcp", (req, res) => mcpError(req, res.set("Allow", "POST"), 405, "method_not_allowed"));
  publicRouter.use((req, res) => mcpError(req, res, 405, "method_not_allowed"));
  publicRouter.use((error, req, res, next) => {
    if (req.path === "/mcp") {
      if (error?.code === "invalid_token") {
        challenge(res, req.get("authorization") ? "invalid_token" : null); return mcpError(req, res, 401, "invalid_token", error);
      }
      const status = error?.type === "entity.too.large" || error instanceof SyntaxError ? 400 : 503;
      return mcpError(req, res, status, "request_failed", error);
    }
    oauthError(error, req, res, next);
  });

  browserRouter.get("/oauth/mcp/authorize", asyncRoute(async (req, res) => {
    if (req.originalUrl.length > 8192) oauthFailure(400, "invalid_request");
    const request = oauth.authorization(new URL(req.originalUrl, config.origin).searchParams);
    if (!sessionOwner(req)) return res.redirect(`/login?redirect=${encodeURIComponent(req.originalUrl)}`);
    const token = csrf();
    req.session.mcpConsent = { request, token, owner: String(req.user.id), expires: Date.now() + 10 * 60 * 1000 };
    await saveSession(req);
    // Preserve the Origin on the same-origin form POST without exposing cross-origin referrers.
    // Browsers also apply form-action to redirects; permit only the validated callback origin/port.
    const callbackOrigin = new URL(request.redirectUri).origin;
    res.set({ "Referrer-Policy": "same-origin",
      "Content-Security-Policy": `default-src 'none'; style-src 'self'; form-action 'self' ${callbackOrigin}; base-uri 'none'; frame-ancestors 'none'`,
      "X-Frame-Options": "DENY" });
    res.render("mcp-consent", { clientName: request.clientName, scopes: request.scopes, csrfToken: token });
  }));
  browserRouter.post("/oauth/mcp/authorize", asyncRoute(async (req, res) => {
    const pending = req.session?.mcpConsent;
    if (!sessionOwner(req) || req.get("origin") !== config.origin || !pending || pending.owner !== String(req.user.id)
      || pending.expires <= Date.now() || !verifiedCsrf(req.body?.csrf_token, pending.token)
      || !["allow", "deny"].includes(req.body?.decision)) oauthFailure(403, "access_denied");
    delete req.session.mcpConsent;
    await saveSession(req);
    const request = pending.request;
    const client = config.clients.find(client => client.client_id === request.clientId);
    if (!mcpRedirectMatches(client, request.redirectUri)) oauthFailure(400, "invalid_request");
    const target = new URL(request.redirectUri);
    target.searchParams.set("iss", config.origin);
    if (request.state !== null) target.searchParams.set("state", request.state);
    if (req.body.decision === "deny") target.searchParams.set("error", "access_denied");
    else target.searchParams.set("code", await oauth.authorize(req.user.id, { ...request, consentNonce: pending.token }));
    res.redirect(303, target.href);
  }));
  browserRouter.use("/api/profile/mcp-connections", (req, res, next) => {
    if (!sessionOwner(req)) return mcpError(req, res, 401, "session_required");
    next();
  });
  browserRouter.get("/api/profile/mcp-connections", asyncRoute(async (req, res) => {
    if (!req.session.mcpCsrfToken) req.session.mcpCsrfToken = csrf();
    const connections = await oauth.list(req.user.id);
    await saveSession(req);
    res.json({ data: connections, csrfToken: req.session.mcpCsrfToken, serverUrl: config.resource });
  }));
  browserRouter.delete("/api/profile/mcp-connections/:id", asyncRoute(async (req, res) => {
    if (req.get("origin") !== config.origin || !verifiedCsrf(req.get("x-csrf-token"), req.session.mcpCsrfToken)) oauthFailure(403, "access_denied");
    await oauth.revoke(req.user.id, req.params.id);
    res.status(204).end();
  }));
  browserRouter.use((req, res) => mcpError(req, res, 405, "method_not_allowed"));
  browserRouter.use(oauthError);
  return { publicRouter, browserRouter };
}
