import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import express from 'express';
import session from 'express-session';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Duplex } from 'node:stream';
import { createMcpRouters } from '../src/routes/mcpRoutes.js';
import McpOAuthService from '../src/services/mcpOAuthService.js';
import { readMcpConfig } from '../src/services/mcpConfig.js';
import { createI18nMiddleware } from '../src/i18n/index.js';

test('HTTP MCP discovery, protocol, consent, CSRF and session-only revocation', async () => {
  const config = readMcpConfig({ MCP_PUBLIC_ORIGIN: 'https://woa.example', MCP_OAUTH_CLIENTS: JSON.stringify([
    { client_id: 'chatgpt', client_name: '<AI app>', redirect_uris: ['https://client.example/callback'] },
    { client_id: 'woa-codex', client_name: 'Codex', redirect_uris: ['http://127.0.0.1/callback'] }
  ]) });
  const code = 'woa_mcp_' + 'a'.repeat(43), context = { userId: '71', grantId: '123', scopes: ['workouts:read', 'analytics:read', 'offline_access'] };
  const authParams = new URLSearchParams({ response_type: 'code', client_id: 'chatgpt', redirect_uri: 'https://client.example/callback', resource: config.resource,
    code_challenge_method: 'S256', code_challenge: createHash('sha256').update('v'.repeat(43)).digest('base64url'), scope: context.scopes.join(' '), state: 'opaque-state' });
  const app = express(), budgets = [], events = []; const realOAuth = new McpOAuthService(config, {});
  const fakeOAuth = { authorization: params => realOAuth.authorization(params), client: (id, secret) => realOAuth.client(id, secret),
    resolve: async token => { if (token !== code) throw Object.assign(new Error(), { code: 'invalid_token' }); return context; },
    exchange: async (_body, client) => { events.push(['exchange', client.client_id]); return { access_token: code, token_type: 'Bearer' }; },
    authorize: async (owner, request) => { events.push(['allow', owner, request]); return code; },
    list: async owner => { events.push(['list', owner]); return [{ id: '123', client_name: '<AI app>', scopes: context.scopes }]; },
    revoke: async (owner, id) => { events.push(['revoke', owner, id]); }, revokeToken: async () => {} };
  const routers = createMcpRouters(config, { oauth: fakeOAuth, httpsOnly: false,
    rateLimit: (bucket, limit, identify) => (req, _res, next) => { budgets.push([bucket, limit, identify(req)]); next(); },
    serverOptions: { workouts: { list: async () => ({ data: [], next_cursor: null }) } } });
  app.set('views', new URL('../src/views', import.meta.url).pathname); app.set('view engine', 'ejs'); app.use(routers.publicRouter);
  app.use(session({ secret: 'isolated-test', resave: false, saveUninitialized: false })); app.use(express.urlencoded({ extended: false }));
  app.use((req, _res, next) => { if (req.session.user_id) req.user = { id: req.session.user_id }; next(); });
  app.use(createI18nMiddleware()); app.use(routers.browserRouter);
  app.get('/test-login', (req, res) => { req.session.user_id = '71'; res.send('ok'); }); app.use((_req, res) => res.status(404).send('ordinary fallback'));
  // Exercise real Express/SDK HTTP objects without opening a network socket.
  const request = (path, options = {}) => new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('HTTP fixture timed out: ' + path + ' ' + (options.method || 'GET') + ' ' + String(options.body || ''))), 3000);
    const chunks = [];
    const socket = new Duplex({ read() {}, write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
    socket.remoteAddress = '127.0.0.1';
    const req = new IncomingMessage(socket);
    req.method = options.method || 'GET'; req.url = path;
    req.headers = { host: 'woa.example', ...Object.fromEntries(Object.entries(options.headers || {}).map(([key, value]) => [key.toLowerCase(), value])) };
    const body = options.body === undefined ? '' : String(options.body);
    if (body) req.headers['content-length'] = String(Buffer.byteLength(body));
    req.rawHeaders = Object.entries(req.headers).flat(); req.httpVersion = '1.1'; req.complete = true;
    const res = new ServerResponse(req); res.assignSocket(socket);
    res.on('error', reject);
    res.on('finish', () => {
      clearTimeout(deadline);
      const raw = Buffer.concat(chunks), position = raw.indexOf(Buffer.from([13, 10, 13, 10]));
      const headers = new Headers();
      for (const [key, value] of Object.entries(res.getHeaders())) for (const entry of Array.isArray(value) ? value : [value]) headers.append(key, String(entry));
      resolve(new Response([204, 304].includes(res.statusCode) ? null : raw.subarray(position + 4), { status: res.statusCode, headers }));
      socket.destroy();
    });
    if (body) req.push(Buffer.from(body)); req.push(null);
    app.handle(req, res);
  });
    const metadata = await request('/.well-known/oauth-protected-resource/mcp'); assert.equal(metadata.headers.get('set-cookie'), null); assert.equal((await metadata.json()).resource, config.resource);
    assert.equal((await (await request('/.well-known/oauth-authorization-server')).json()).issuer, config.origin);
    const unauthorized = await request('/mcp'); assert.equal(unauthorized.status, 401); assert.ok(unauthorized.headers.get('www-authenticate').includes('resource_metadata='));
    assert.equal((await request('/mcp', { headers: { authorization: 'Bearer ' + code, origin: 'https://evil.example' } })).status, 403);
    assert.equal((await request('/mcp?api_key=SECRET', { headers: { authorization: 'Bearer ' + code } })).status, 400);
    const rpc = async body => { const response = await request('/mcp', { method: 'POST', headers: { authorization: 'Bearer ' + code,
      'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-03-26' }, body: JSON.stringify(body) }); return { response, body: await response.json() }; };
    const initialized = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    assert.equal(initialized.response.status, 200); assert.equal(initialized.body.result.serverInfo.name, 'woa-training'); assert.equal(initialized.response.headers.get('set-cookie'), null); assert.equal(initialized.response.headers.get('mcp-session-id'), null);
    assert.equal((await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).body.result.tools.length, 6);
    assert.deepEqual((await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_workouts', arguments: {} } })).body.result.structuredContent.data, []);
    assert.equal((await rpc([{ jsonrpc: '2.0', id: 4, method: 'tools/list' }])).response.status, 400);
    assert.equal((await request('/mcp', { headers: { authorization: 'Bearer ' + code } })).status, 405); assert.ok(budgets.some(row => row[0] === 'user' && row[2] === '71'));
    assert.equal((await request('/oauth/mcp/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'client_id=chatgpt' })).status, 200);
    assert.equal((await request('/oauth/mcp/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'client_id=chatgpt&client_id=private' })).status, 400);
    const loginRedirect = await request('/oauth/mcp/authorize?' + authParams); assert.equal(loginRedirect.status, 302); assert.ok(loginRedirect.headers.get('location').startsWith('/login?redirect='));
    const login = await request('/test-login'), cookie = login.headers.get('set-cookie').split(';')[0];
    const consent = await request('/oauth/mcp/authorize?' + authParams, { headers: { cookie } }), html = await consent.text(); assert.equal(consent.status, 200); assert.ok(html.includes('&lt;AI app&gt;')); assert.ok(consent.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
    const csrfToken = html.match(/name="csrf_token" value="([a-f0-9]{64})"/)[1];
    const postConsent = origin => request('/oauth/mcp/authorize', { method: 'POST', headers: { cookie, origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf_token: csrfToken, decision: 'allow' }) });
    assert.equal((await postConsent('https://evil.example')).status, 403); const allowed = await postConsent(config.origin); assert.equal(allowed.status, 303);
    const callback = new URL(allowed.headers.get('location')); assert.equal(callback.searchParams.get('code'), code); assert.equal(callback.searchParams.get('iss'), config.origin); assert.equal(callback.searchParams.get('state'), 'opaque-state'); assert.equal((await postConsent(config.origin)).status, 403);
    const nativeParams = new URLSearchParams(authParams); nativeParams.set('client_id', 'woa-codex'); nativeParams.set('redirect_uri', 'http://127.0.0.1:49152/callback');
    for (const decision of ['allow', 'deny']) {
      const nativeConsent = await request('/oauth/mcp/authorize?' + nativeParams, { headers: { cookie } });
      const nativeHtml = await nativeConsent.text(); assert.equal(nativeConsent.status, 200);
      const nativeCsrf = nativeHtml.match(/name="csrf_token" value="([a-f0-9]{64})"/)[1];
      const nativeResult = await request('/oauth/mcp/authorize', { method: 'POST', headers: { cookie, origin: config.origin, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf_token: nativeCsrf, decision }) });
      assert.equal(nativeResult.status, 303);
      const nativeCallback = new URL(nativeResult.headers.get('location'));
      assert.equal(nativeCallback.origin, 'http://127.0.0.1:49152'); assert.equal(nativeCallback.pathname, '/callback');
      assert.equal(nativeCallback.searchParams.get('iss'), config.origin); assert.equal(nativeCallback.searchParams.get('state'), 'opaque-state');
      if (decision === 'allow') assert.equal(nativeCallback.searchParams.get('code'), code);
      else { assert.equal(nativeCallback.searchParams.get('error'), 'access_denied'); assert.equal(nativeCallback.searchParams.has('code'), false); }
    }
    const connections = await request('/api/profile/mcp-connections', { headers: { cookie } }), payload = await connections.json(); assert.equal(connections.status, 200); assert.equal(payload.data[0].id, '123'); assert.ok(!JSON.stringify(payload).includes(code));
    assert.equal((await request('/api/profile/mcp-connections', { headers: { cookie, authorization: 'Bearer ' + code } })).status, 401);
    assert.equal((await request('/api/profile/mcp-connections/123', { method: 'DELETE', headers: { cookie, origin: config.origin, 'x-csrf-token': 'f'.repeat(64) } })).status, 403);
    assert.equal((await request('/api/profile/mcp-connections/123', { method: 'DELETE', headers: { cookie, origin: config.origin, 'x-csrf-token': payload.csrfToken } })).status, 204); assert.deepEqual(events.at(-1), ['revoke', '71', '123']);
});
