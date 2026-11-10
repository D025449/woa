export const MCP_SCOPES = Object.freeze(["workouts:read", "analytics:read", "offline_access"]);

// Configuration is operator-controlled; never discover client URLs from requests.
export function readMcpConfig(env = process.env) {
  if (!env.MCP_PUBLIC_ORIGIN) return null;
  const url = new URL(env.MCP_PUBLIC_ORIGIN);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || url.pathname !== "/") throw new Error("MCP_PUBLIC_ORIGIN must be an HTTPS origin.");
  const clients = JSON.parse(env.MCP_OAUTH_CLIENTS || "[]");
  if (!Array.isArray(clients) || !clients.length || clients.length > 20) throw new Error("Configure MCP OAuth clients.");
  const ids = new Set();
  for (const client of clients) {
    if (!client || !/^[A-Za-z0-9_-]{1,100}$/.test(client.client_id) || ids.has(client.client_id)
      || typeof client.client_name !== "string" || !client.client_name.trim() || client.client_name.length > 80
      || Array.from(client.client_name).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
      || !Array.isArray(client.redirect_uris) || !client.redirect_uris.length || client.redirect_uris.length > 10
      || (client.secret_sha256 !== undefined && !/^[a-f0-9]{64}$/.test(client.secret_sha256))) {
      throw new Error("Invalid MCP OAuth client configuration.");
    }
    for (const redirect of client.redirect_uris) {
      const target = new URL(redirect);
      if (target.protocol !== "https:" || target.username || target.password || target.hash
        || target.href !== redirect || redirect.length > 2048) throw new Error("Invalid OAuth redirect URI.");
    }
    ids.add(client.client_id);
  }
  return { origin: url.origin, resource: `${url.origin}/mcp`, clients };
}

export function oauthFailure(statusCode, code) {
  throw Object.assign(new Error(code), { statusCode, code });
}

export function mcpScopes(value) {
  if (value === undefined) return ["workouts:read", "analytics:read"];
  if (typeof value !== "string" || value.length > 100) oauthFailure(400, "invalid_scope");
  const scopes = value.split(" ");
  if (scopes.some(scope => !MCP_SCOPES.includes(scope)) || new Set(scopes).size !== scopes.length
    || !scopes.some(scope => scope !== "offline_access")) oauthFailure(400, "invalid_scope");
  return MCP_SCOPES.filter(scope => scopes.includes(scope));
}
