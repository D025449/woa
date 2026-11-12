import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createTrainingMcpServer, MCP_TOOL_NAMES, MCP_WRITE_TOOL_NAMES } from '../src/services/mcpServerService.js';
import McpOAuthService, { mcpTokenHash } from '../src/services/mcpOAuthService.js';
import { readMcpConfig, mcpScopes, mcpRedirectMatches } from '../src/services/mcpConfig.js';
import AnalyticsService from '../src/services/publicAnalyticsApiService.js';

export const config = readMcpConfig({ MCP_PUBLIC_ORIGIN: 'https://woa.example', MCP_OAUTH_CLIENTS: JSON.stringify([
  { client_id: 'chatgpt', client_name: '<AI app>', redirect_uris: ['https://client.example/callback'] },
  { client_id: 'private', client_name: 'Private AI', redirect_uris: ['https://client.example/private'], secret_sha256: mcpTokenHash('test-secret') }
]) });
const verifier = 'v'.repeat(43), challenge = createHash('sha256').update(verifier).digest('base64url');
const code = 'woa_mcp_' + 'a'.repeat(43);
const context = { userId: '71', grantId: '123', scopes: ['workouts:read', 'analytics:read', 'offline_access'] };
const authParams = extra => new URLSearchParams({ response_type: 'code', client_id: 'chatgpt', redirect_uri: 'https://client.example/callback',
  resource: config.resource, code_challenge_method: 'S256', code_challenge: challenge, scope: context.scopes.join(' '), state: 'opaque-state', ...extra });
function scriptedDb(handler) {
  const calls = []; let released = false;
  const query = async (sql, args = []) => { calls.push({ sql, args }); return await handler(sql, args) || { rows: [] }; };
  return { calls, query, connect: async () => ({ query, release: () => { released = true; } }), get released() { return released; } };
}
const grantRow = extra => ({ id: '123', scopes: context.scopes, client_id: 'chatgpt', resource: config.resource, revoked_at: null,
  grant_valid: true, token_valid: true, consumed_at: null, redirect_uri: 'https://client.example/callback', code_challenge: challenge, account_status: 'active', ...extra });
const exchangeInput = { grant_type: 'authorization_code', resource: config.resource, code, code_verifier: verifier, redirect_uri: 'https://client.example/callback' };

test('MCP config validates HTTPS, exact callbacks, clients and minimal scopes', () => {
  assert.equal(readMcpConfig({}), null);
  for (const origin of ['http://localhost', 'https://x/path', 'https://u:p@x', 'https://x/?a=1']) assert.throws(() => readMcpConfig({ MCP_PUBLIC_ORIGIN: origin, MCP_OAUTH_CLIENTS: JSON.stringify(config.clients) }));
  for (const change of [{ redirect_uris: ['https://client.example/callback#fragment'] }, { redirect_uris: ['http://localhost/callback'] }, { secret_sha256: 'plaintext' }, { client_name: String.fromCharCode(10) }, { client_id: '' }]) {
    assert.throws(() => readMcpConfig({ MCP_PUBLIC_ORIGIN: config.origin, MCP_OAUTH_CLIENTS: JSON.stringify([{ ...config.clients[0], ...change }]) }));
  }
  assert.deepEqual(mcpScopes(undefined), ['workouts:read', 'analytics:read', 'activities:write']);
  for (const scopes of ['offline_access', 'analytics:read analytics:read', 'workouts:gps:read', 'analytics:read ', '']) assert.throws(() => mcpScopes(scopes));
  const oauth = new McpOAuthService(config, {});
  for (const change of [{ client_id: 'unknown' }, { redirect_uri: 'https://evil.example/' }, { resource: config.origin }, { code_challenge_method: 'plain' }, { response_type: 'token' }, { code_challenge: 'bad' }, { scope: 'workouts:fit:read' }]) assert.throws(() => oauth.authorization(authParams(change)));
  const duplicate = authParams(); duplicate.append('client_id', 'chatgpt'); assert.throws(() => oauth.authorization(duplicate));
  const unknown = authParams(); unknown.append('owner', '72'); assert.throws(() => oauth.authorization(unknown));
  assert.equal(oauth.client('chatgpt').client_id, 'chatgpt'); assert.throws(() => oauth.client('private')); assert.throws(() => oauth.client('private', 'wrong'));
  assert.equal(oauth.client('private', 'test-secret').client_id, 'private'); assert.throws(() => oauth.client('chatgpt', 'test-secret'));
});

test('ChatGPT ui_locales is optional, bounded and ignored without relaxing OAuth validation', () => {
  const webConfig = readMcpConfig({ MCP_PUBLIC_ORIGIN: config.origin, MCP_OAUTH_CLIENTS: JSON.stringify([{
    client_id: 'woa-chatgpt', client_name: 'ChatGPT',
    redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'], secret_sha256: mcpTokenHash('test-secret')
  }]) });
  const oauth = new McpOAuthService(webConfig, {});
  const params = extra => authParams({ client_id: 'woa-chatgpt',
    redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect', ...extra });
  const baseline = oauth.authorization(params());
  for (const ui_locales of ['', 'de', 'de-DE en-US', 'x'.repeat(256), '<script>locale</script>']) {
    assert.deepEqual(oauth.authorization(params({ ui_locales })), baseline);
  }
  assert.ok(!JSON.stringify(oauth.authorization(params({ ui_locales: 'do-not-store-this-locale' }))).includes('do-not-store-this-locale'));
  assert.throws(() => oauth.authorization(params({ ui_locales: 'x'.repeat(257) })), { code: 'invalid_request' });
  const duplicate = params({ ui_locales: 'de' }); duplicate.append('ui_locales', 'en');
  assert.throws(() => oauth.authorization(duplicate), { code: 'invalid_request' });
  const repeatedClient = params({ ui_locales: 'de' }); repeatedClient.append('client_id', 'woa-chatgpt');
  assert.throws(() => oauth.authorization(repeatedClient), { code: 'invalid_request' });
  for (const extra of [{ owner: '72' }, { redirect_uri: 'https://evil.example/' }, { client_id: 'other' },
    { resource: 'https://other.example/mcp' }, { response_type: 'token' }, { code_challenge_method: 'plain' },
    { code_challenge: 'bad' }, { state: '' }]) {
    assert.throws(() => oauth.authorization(params({ ui_locales: 'de', ...extra })), { code: 'invalid_request' });
  }
  assert.throws(() => oauth.authorization(params({ ui_locales: 'de', scope: 'workouts:gps:read' })), { code: 'invalid_scope' });
});

test('consent locks owner/quota, stores only hashes and rejects pending deletion', async () => {
  const request = { ...new McpOAuthService(config, {}).authorization(authParams()), consentNonce: 'f'.repeat(64) };
  for (const [status, count, expected] of [['active', 0, null], ['pending_deletion', 0, 'access_denied'], ['deleted', 0, 'access_denied'], ['active', 5, 'connection_limit_reached']]) {
    const db = scriptedDb(sql => sql.includes('SELECT account_status') ? { rows: [{ account_status: status }] } : sql.includes('COUNT(*)') ? { rows: [{ count }] } : sql.includes('INSERT INTO user_mcp_grants') ? { rows: [{ id: '123' }] } : null);
    const oauth = new McpOAuthService(config, db);
    if (expected) { await assert.rejects(oauth.authorize('71', request), { code: expected }); assert.equal(db.calls.at(-1).sql, 'ROLLBACK'); }
    else { const result = await oauth.authorize('71', request); assert.equal(db.calls.find(call => call.sql.includes('INSERT INTO mcp_oauth_tokens')).args[0], mcpTokenHash(result)); assert.ok(!JSON.stringify(db.calls).includes(result)); assert.equal(db.calls.find(call => call.sql.includes('INSERT INTO user_mcp_grants')).args[0], '71'); assert.equal(db.calls.at(-1).sql, 'COMMIT'); }
    assert.ok(db.calls.some(call => call.sql.includes('FOR UPDATE'))); assert.ok(db.released);
  }
});

test('Codex public clients bind literal loopback host/path/query while allowing ephemeral ports', () => {
  const nativeClient = { client_id: 'woa-codex', client_name: 'Codex', redirect_uris: ['http://127.0.0.1/callback'] };
  const nativeConfig = readMcpConfig({ MCP_PUBLIC_ORIGIN: config.origin, MCP_OAUTH_CLIENTS: JSON.stringify([nativeClient]) });
  const oauth = new McpOAuthService(nativeConfig, {});
  assert.equal(oauth.client('woa-codex').secret_sha256, undefined);
  for (const redirect of ['http://127.0.0.1/callback', 'http://127.0.0.1:49152/callback', 'http://127.0.0.1:65535/callback']) {
    const params = authParams({ client_id: 'woa-codex', redirect_uri: redirect });
    assert.equal(oauth.authorization(params).redirectUri, redirect);
  }
  for (const redirect of ['http://localhost:49152/callback', 'http://127.0.0.2:49152/callback', 'http://[::1]:49152/callback',
    'http://2130706433:49152/callback', 'http://127.0.0.1.evil.example:49152/callback', 'http://127.0.0.1:49152/other',
    'http://127.0.0.1:49152/callback/extra', 'http://127.0.0.1:49152/callback?extra=1', 'http://127.0.0.1:49152/callback#fragment',
    'http://user@127.0.0.1:49152/callback', 'https://127.0.0.1:49152/callback', 'http://127.0.0.1:49152/c%61llback']) {
    assert.equal(mcpRedirectMatches(nativeClient, redirect), false, redirect);
    assert.throws(() => oauth.authorization(authParams({ client_id: 'woa-codex', redirect_uri: redirect })));
  }
  const fixed = { ...nativeClient, redirect_uris: ['http://127.0.0.1:49152/callback'] };
  assert.equal(mcpRedirectMatches(fixed, fixed.redirect_uris[0]), true);
  assert.equal(mcpRedirectMatches(fixed, 'http://127.0.0.1:49153/callback'), false);
  const queryBound = { ...nativeClient, redirect_uris: ['http://127.0.0.1/callback?registered=1'] };
  assert.equal(mcpRedirectMatches(queryBound, 'http://127.0.0.1:49153/callback?registered=1'), true);
  assert.equal(mcpRedirectMatches(queryBound, 'http://127.0.0.1:49153/callback?registered=2'), false);
  assert.equal(mcpRedirectMatches(config.clients[0], 'https://client.example:49152/callback'), false);
  assert.throws(() => readMcpConfig({ MCP_PUBLIC_ORIGIN: config.origin, MCP_OAUTH_CLIENTS: JSON.stringify([{ ...nativeClient, secret_sha256: mcpTokenHash('secret') }]) }));
});

test('Codex exchange binds the actual consented callback port as well as PKCE and client', async () => {
  const nativeClient = { client_id: 'woa-codex', client_name: 'Codex', redirect_uris: ['http://127.0.0.1/callback'] };
  const nativeConfig = readMcpConfig({ MCP_PUBLIC_ORIGIN: config.origin, MCP_OAUTH_CLIENTS: JSON.stringify([nativeClient]) });
  for (const port of [49152, 49153]) {
    const db = scriptedDb(sql => sql.includes('FOR UPDATE OF') ? { rows: [grantRow({ client_id: 'woa-codex', redirect_uri: 'http://127.0.0.1:49152/callback' })] }
      : sql.includes('RETURNING GREATEST') ? { rows: [{ expires_in: 900 }] } : null);
    const input = { ...exchangeInput, redirect_uri: 'http://127.0.0.1:' + port + '/callback' };
    const oauth = new McpOAuthService(nativeConfig, db);
    if (port === 49152) { assert.equal((await oauth.exchange(input, nativeClient)).token_type, 'Bearer'); assert.equal(db.calls.at(-1).sql, 'COMMIT'); }
    else { await assert.rejects(oauth.exchange(input, nativeClient), { code: 'invalid_grant' }); assert.ok(!db.calls.some(call => call.sql.includes('SET consumed_at'))); }
  }
});

test('exchange rejects wrong client, expiry, account, redirect, PKCE, scope and resource before consumption', async () => {
  for (const [rowChanges, inputChanges] of [[{ client_id: 'other' }, {}], [{ revoked_at: new Date() }, {}], [{ grant_valid: false }, {}], [{ token_valid: false }, {}], [{ account_status: 'deleted' }, {}], [{ resource: 'https://other.example/mcp' }, {}], [{}, { code_verifier: 'x'.repeat(43) }], [{}, { redirect_uri: 'https://evil.example' }], [{}, { resource: config.origin }], [{}, { scope: 'workouts:read' }]]) {
    const db = scriptedDb(sql => sql.includes('FOR UPDATE OF') ? { rows: [grantRow(rowChanges)] } : null);
    await assert.rejects(new McpOAuthService(config, db).exchange({ ...exchangeInput, ...inputChanges }, config.clients[0])); assert.ok(!db.calls.some(call => call.sql.includes('SET consumed_at')));
  }
});

test('tokens rotate and replay commits revocation; no offline scope means no refresh token', async () => {
  for (const kind of ['authorization_code', 'refresh_token']) {
    const db = scriptedDb(sql => sql.includes('FOR UPDATE OF') ? { rows: [grantRow({ account_status: 'pending_deletion' })] } : sql.includes('RETURNING GREATEST') ? { rows: [{ expires_in: 42 }] } : null);
    const result = await new McpOAuthService(config, db).exchange({ ...exchangeInput, grant_type: kind, refresh_token: code }, config.clients[0]);
    assert.equal(result.expires_in, 42); assert.notEqual(result.access_token, result.refresh_token); assert.equal(db.calls.at(-1).sql, 'COMMIT'); assert.ok(!JSON.stringify(db.calls).includes(result.access_token)); assert.ok(!JSON.stringify(db.calls).includes(result.refresh_token));
    const replayDb = scriptedDb(sql => sql.includes('FOR UPDATE OF') ? { rows: [grantRow({ consumed_at: new Date() })] } : null);
    await assert.rejects(new McpOAuthService(config, replayDb).exchange({ ...exchangeInput, grant_type: kind, refresh_token: code }, config.clients[0]), { code: 'invalid_grant' }); assert.ok(replayDb.calls.some(call => call.sql.includes('SET revoked_at'))); assert.equal(replayDb.calls.at(-1).sql, 'COMMIT');
  }
  const db = scriptedDb(sql => sql.includes('FOR UPDATE OF') ? { rows: [grantRow({ scopes: ['analytics:read'] })] } : sql.includes('RETURNING GREATEST') ? { rows: [{ expires_in: 900 }] } : null);
  assert.equal((await new McpOAuthService(config, db).exchange(exchangeInput, config.clients[0])).refresh_token, undefined);
});

test('duplicate consent and database failures roll back and release without leaking secrets', async () => {
  const request = { ...new McpOAuthService(config, {}).authorization(authParams()), consentNonce: 'f'.repeat(64) };
  const db = scriptedDb(sql => {
    if (sql.includes('SELECT account_status')) return { rows: [{ account_status: 'active' }] };
    if (sql.includes('COUNT(*)')) return { rows: [{ count: 0 }] };
    if (sql.includes('INSERT INTO user_mcp_grants')) throw Object.assign(new Error('duplicate'), { code: '23505' });
  });
  await assert.rejects(new McpOAuthService(config, db).authorize('71', request), { code: 'access_denied' });
  assert.equal(db.calls.at(-1).sql, 'ROLLBACK'); assert.ok(db.released);
  assert.equal(db.calls.find(call => call.sql.includes('INSERT INTO user_mcp_grants')).args[5], mcpTokenHash(request.consentNonce));
  const failed = scriptedDb(sql => {
    if (sql.includes('FOR UPDATE OF')) return { rows: [grantRow()] };
    if (sql.includes('INSERT INTO mcp_oauth_tokens')) throw new Error('database unavailable');
  });
  await assert.rejects(new McpOAuthService(config, failed).exchange(exchangeInput, config.clients[0]));
  assert.equal(failed.calls.at(-1).sql, 'ROLLBACK'); assert.ok(failed.released);
});

test('resolve/revoke binds owner/resource and checks live token/grant/account state', async () => {
  const db = scriptedDb(sql => sql.startsWith('UPDATE user_mcp_grants g SET last_used') ? { rows: [{ user_id: '71', id: '123', client_id: 'chatgpt', scopes: context.scopes }] } : { rows: [{ id: '123' }] });
  const oauth = new McpOAuthService(config, db); assert.deepEqual(await oauth.resolve(code), context); const call = db.calls.at(-1);
  assert.deepEqual(call.args, [mcpTokenHash(code), config.resource]);
  for (const clause of ["t.kind = 'access'", 't.expires_at > NOW()', 'g.revoked_at IS NULL', 'g.expires_at > NOW()', "u.account_status IN ('active', 'pending_deletion')"]) assert.ok(call.sql.includes(clause));
  await oauth.revoke('71', '123'); assert.deepEqual(db.calls.at(-1).args, ['71', '123']); assert.ok(db.calls.at(-1).sql.includes('user_id = $1 AND id = $2'));
  await oauth.revokeToken(code, config.clients[0]); assert.deepEqual(db.calls.at(-1).args, [mcpTokenHash(code), 'chatgpt', config.resource]);
  await assert.rejects(oauth.resolve('woa_pk_' + 'a'.repeat(43)), { code: 'invalid_token' });
  const empty = new McpOAuthService(config, scriptedDb(() => ({ rows: [] }))); await assert.rejects(empty.resolve(code), { code: 'invalid_token' }); await assert.rejects(empty.revoke('72', '123'), { code: 'connection_not_found' });
});

async function protocol(ctx, options = {}) {
  const server = createTrainingMcpServer(ctx, { authorize: async () => ctx, ...options }); const client = new Client({ name: 'test-client', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(); await server.connect(serverTransport); await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

test('real MCP advertises exactly eleven scoped read-only tools with strict schemas', async () => {
  for (const [scopes, expected] of [[context.scopes, MCP_TOOL_NAMES], [['analytics:read'], ['get_training_summary', 'get_training_load', 'get_ftp_history']], [['workouts:read'], ['list_workouts', 'get_workout', 'get_workout_gps', 'get_workout_map', 'get_workout_segments', 'export_workout_fit']]]) {
    const p = await protocol({ ...context, scopes }); try { assert.equal(p.client.getServerVersion().name, 'woa-training'); const { tools } = await p.client.listTools(); assert.deepEqual(tools.map(tool => tool.name), expected); for (const tool of tools) { assert.equal(tool.annotations.readOnlyHint, true); assert.equal(tool.annotations.destructiveHint, false); assert.equal(tool.inputSchema.additionalProperties, false); } assert.ok(!JSON.stringify(tools).includes('api_key')); assert.ok(!JSON.stringify(tools).includes('366')); } finally { await p.close(); }
  }
});

test('real MCP dispatches owned IDs, dates, paging and shared analytics budgets', async () => {
  const calls = [], budgets = []; const service = { ...Object.fromEntries(['list', 'detail', 'summary', 'trainingLoad', 'powerProfile', 'ftpHistory', 'gps'].map(method => [method, async (owner, params) => { calls.push([method, owner, params instanceof URLSearchParams ? Object.fromEntries(params) : params]); return method === 'gps' ? JSON.stringify({ type: 'Feature', properties: { workout_id: params }, geometry: null }) : { data: [], meta: { coverage: 'missing' }, next_cursor: null }; }])), map: async (owner, id) => { calls.push(['map', owner, id]); return Buffer.from('fake-webp'); } };
  const p = await protocol(context, { workouts: service, analytics: service, allowance: async (...args) => { budgets.push(args); return { allowed: true, retryAfter: 0 }; } });
  try {
    const definitionNames = MCP_TOOL_NAMES.filter(n => !['get_workout_gps', 'get_workout_map', 'get_workout_segments', 'export_workout_fit', 'get_recent_efforts'].includes(n));
    for (const name of definitionNames) { const args = name === 'get_workout' ? { workout_id: '9007199254740993' } : name === 'list_workouts' ? { limit: 12, cursor: 'opaque' } : { from: '2026-10-01', to: '2026-11-01', ...(name === 'get_power_profile' ? { durations: [5, 480] } : name === 'get_ftp_history' ? { grouping: 'week' } : {}) }; const result = await p.client.callTool({ name, arguments: args }); assert.ok(!result.isError); assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent); }
    assert.equal(calls.length, 6); assert.ok(calls.every(call => call[1] === '71')); assert.equal(calls.find(call => call[0] === 'detail')[2], '9007199254740993'); assert.equal(calls.find(call => call[0] === 'powerProfile')[2].durations, '5,480'); assert.equal(budgets.length, 4); assert.ok(budgets.every(args => args.join(',') === 'analytics,40,71'));
    for (const args of [{ owner: '72' }, { api_key: 'SECRET' }, { limit: 101 }, { limit: '20' }]) assert.equal((await p.client.callTool({ name: 'list_workouts', arguments: args })).isError, true);
    assert.equal((await p.client.callTool({ name: 'get_power_profile', arguments: { durations: [5, 5] } })).isError, true); assert.equal(calls.length, 6);
    const gpsResult = await p.client.callTool({ name: 'get_workout_gps', arguments: { workout_id: '99' } });
    assert.ok(!gpsResult.isError); assert.equal(gpsResult.structuredContent.type, 'Feature'); assert.equal(gpsResult.structuredContent.properties.workout_id, '99');
    assert.equal(budgets.at(-1).join(','), 'gps,40,71');
    const mapResult = await p.client.callTool({ name: 'get_workout_map', arguments: { workout_id: '99' } });
    assert.ok(!mapResult.isError); assert.equal(mapResult.content[1].type, 'image'); assert.equal(mapResult.content[1].mimeType, 'image/webp');
    assert.equal(mapResult.content[1].data, Buffer.from('fake-webp').toString('base64'));
    assert.equal(budgets.at(-1).join(','), 'gps,40,71');
  } finally { await p.close(); }
});

test('real MCP analytics dispatch accepts multi-year ranges through the shared services', async () => {
  const analytics = new AnalyticsService({ database: scriptedDb(() => ({ rows: [] })), now: () => Date.parse('2026-11-10T12:00:00Z') });
  const p = await protocol(context, { analytics, allowance: async (_bucket, limit) => { assert.equal(limit, 40); return { allowed: true }; } });
  try {
    for (const name of ['get_training_summary', 'get_training_load', 'get_power_profile', 'get_ftp_history']) {
      const result = await p.client.callTool({ name, arguments: { from: '2024-01-01', to: '2026-01-01' } });
      assert.equal(result.isError, undefined);
      assert.equal(result.structuredContent.meta.from, '2024-01-01');
      if (name === 'get_training_load') assert.equal(result.structuredContent.data.length, 731);
    }
  } finally { await p.close(); }
});

test('MCP returns selected grouped CP history through one shared service call', async () => {
  const db = scriptedDb(sql => sql.includes('JOIN workout_segments') ? { rows: [
    { workout_id: '1', segment_id: '1', duration: 300, avg_power: 400, start_time: '2024-01-20T10:00:00Z',
      history_start: '2024-01-02T00:00:00Z', start_offset: 0, end_offset: 300 },
    { workout_id: '2', segment_id: '2', duration: 1200, avg_power: 300, start_time: '2026-11-05T10:00:00Z',
      history_start: '2024-01-02T00:00:00Z', start_offset: 0, end_offset: 1200 }
  ] } : null);
  let requests = 0;
  const analytics = new AnalyticsService({ database: db, now: () => Date.parse('2026-11-10T12:00:00Z') });
  const p = await protocol(context, { analytics, allowance: async () => { requests++; return { allowed: true }; } });
  try {
    const { tools } = await p.client.listTools();
    assert.deepEqual(tools.find(tool => tool.name === 'get_power_profile').inputSchema.properties.grouping.enum, ['week', 'month', 'quarter', 'year']);
    const result = await p.client.callTool({ name: 'get_power_profile', arguments: { grouping: 'year', durations: [300, 1200] } });
    assert.equal(result.isError, undefined);
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    assert.equal(result.structuredContent.meta.from, '2024-01-02');
    assert.equal(result.structuredContent.meta.grouping, 'year');
    assert.deepEqual(result.structuredContent.data.map(period => period.points.map(point => point.power_watts)),
      [[400, null], [null, null], [null, 300]]);
    assert.equal(requests, 1);
    assert.equal(db.calls.filter(call => call.sql.includes('JOIN workout_segments')).length, 1);
    assert.equal(db.calls.filter(call => call.sql.includes('unnest')).length, 1);
    for (const args of [{ grouping: 'day' }, { grouping: 'month', durations: [300, 300] }, { grouping: 'year', owner: '72' }]) {
      assert.equal((await p.client.callTool({ name: 'get_power_profile', arguments: args })).isError, true);
    }
    assert.equal(requests, 1);
  } finally { await p.close(); }
});

test('MCP rechecks revocation and owner and safely reports quota, size and service failures', async t => {
  const logs = []; t.mock.method(console, 'error', text => logs.push(JSON.parse(text)));
  for (const [options, expected] of [[{ authorize: async () => { throw Object.assign(new Error('SECRET'), { code: 'invalid_token' }); } }, 'invalid_token'], [{ authorize: async () => ({ ...context, userId: '72' }) }, 'insufficient_scope'], [{ authorize: async () => ({ ...context, scopes: [] }) }, 'insufficient_scope'], [{ allowance: async () => ({ allowed: false, retryAfter: 31 }) }, 'rate_limited'], [{ allowance: async () => { throw new Error('SECRET redis URL'); } }, 'service_unavailable'], [{ allowance: async () => ({ allowed: true }), analytics: { summary: async () => { throw new Error('SECRET SQL'); } } }, 'service_unavailable'], [{ allowance: async () => ({ allowed: true }), analytics: { summary: async () => ({ data: 'x'.repeat(1024 * 1024) }) } }, 'response_too_large']]) {
    const p = await protocol(context, options); try { const result = await p.client.callTool({ name: 'get_training_summary', arguments: {} }); assert.equal(result.isError, true); const payload = JSON.parse(result.content[0].text); assert.equal(payload.error.code, expected); assert.equal(payload.error.request_id, logs.at(-1).request_id); assert.ok(!JSON.stringify({ result, logs }).includes('SECRET')); } finally { await p.close(); }
  }
});

test('six locales render consent and connection list with escaping', async () => {
  const ejs = await import('ejs');
  for (const locale of ['de', 'en', 'es', 'fr', 'it', 'pt']) { const messages = JSON.parse(await readFile(new URL('../src/public/i18n/' + locale + '.json', import.meta.url))); const t = key => key.split('.').reduce((value, part) => value?.[part], messages); const html = await ejs.renderFile(new URL('../src/views/mcp-consent.ejs', import.meta.url).pathname, { locale, t, clientName: '<script>SECRET</script>', scopes: context.scopes, csrfToken: 'f'.repeat(64) }); assert.ok(html.includes('&lt;script&gt;')); assert.ok(!html.includes('<script>SECRET')); assert.ok(!html.includes('undefined')); const profile = await ejs.renderFile(new URL('../src/views/partials/profile/mcp-connections.ejs', import.meta.url).pathname, { t }); assert.ok(profile.includes('mcp-connections-list')); assert.ok(!profile.includes('profile.mcp.')); }
});

test('create_training_activity registers only with activities:write scope', async () => {
  assert.deepEqual(MCP_WRITE_TOOL_NAMES, ['create_training_activity', 'sync_workouts_from_providers', 'import_workout_file', 'delete_workout', 'update_workout']);
  for (const scopes of [['workouts:read'], ['analytics:read'], context.scopes]) {
    const p = await protocol({ ...context, scopes }); try {
      const { tools } = await p.client.listTools();
      assert.ok(!tools.some(t => t.name === 'create_training_activity'));
      assert.ok(!tools.some(t => t.name === 'sync_workouts_from_providers'));
    } finally { await p.close(); }
  }
  const p = await protocol({ ...context, scopes: ['activities:write'] }); try {
    const { tools } = await p.client.listTools();
    assert.equal(tools.length, 5);
    assert.ok(tools.some(t => t.name === 'create_training_activity'));
    assert.ok(tools.some(t => t.name === 'sync_workouts_from_providers'));
    assert.ok(tools.some(t => t.name === 'import_workout_file'));
    assert.ok(tools.some(t => t.name === 'delete_workout'));
    assert.ok(tools.some(t => t.name === 'update_workout'));
    const syncTool = tools.find(t => t.name === 'sync_workouts_from_providers');
    assert.equal(syncTool.annotations.readOnlyHint, false);
    assert.equal(syncTool.annotations.destructiveHint, true);
    assert.equal(syncTool.inputSchema.additionalProperties, false);
    const fileTool = tools.find(t => t.name === 'import_workout_file');
    assert.equal(fileTool.annotations.readOnlyHint, false);
    assert.equal(fileTool.annotations.destructiveHint, true);
    assert.equal(fileTool.inputSchema.additionalProperties, false);
  } finally { await p.close(); }
});

test('create_training_activity dispatches create, maps fields and propagates validation errors', async () => {
  const writeCtx = { ...context, scopes: ['activities:write'] };
  const row = { id: 42, activity_type: 'cycling', start_time: new Date('2026-11-11T08:00:00Z'),
    duration_seconds: 3600, workout_type: 'indoor', title: null, estimated_tss: 65.2,
    tss_source: 'power_model', average_power: 200, avg_normalized_power: 210 };
  let captured = null;
  const activities = { create: async (uid, payload) => {
    if (payload.activityType === 'cycling' && !payload.baselinePowerValue) {
      const e = new Error('Cycling activities require a baseline power'); e.statusCode = 400; throw e;
    }
    captured = { uid, payload }; return row;
  } };
  const p = await protocol(writeCtx, { activities }); try {
    const args = { activity_type: 'cycling', start_time: '2026-11-11T08:00:00Z', duration_seconds: 3600,
      workout_type: 'indoor', baseline_power_mode: 'watts', baseline_power_value: 200 };
    const result = await p.client.callTool({ name: 'create_training_activity', arguments: args });
    assert.ok(!result.isError);
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.id, '42'); assert.equal(body.activity_type, 'cycling');
    assert.equal(body.estimated_tss, 65.2); assert.equal(body.normalized_power, 210);
    assert.ok(!('title' in body));
    assert.equal(captured.uid, '71'); assert.equal(captured.payload.activityType, 'cycling');
    assert.equal(captured.payload.baselinePowerValue, 200);
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    const bad = await p.client.callTool({ name: 'create_training_activity', arguments: { activity_type: 'cycling',
      start_time: '2026-11-11T08:00:00Z', duration_seconds: 3600, workout_type: 'indoor',
      baseline_power_mode: 'watts' } });
    assert.equal(bad.isError, true);
    assert.equal(JSON.parse(bad.content[0].text).error.code, 'invalid_request');
    assert.ok(JSON.parse(bad.content[0].text).error.message.length > 0);
  } finally { await p.close(); }
});

test('create_training_activity rechecks auth and rejects revoked/wrong owner', async t => {
  const logs = []; t.mock.method(console, 'error', text => logs.push(JSON.parse(text)));
  const writeCtx = { ...context, scopes: ['activities:write'] };
  for (const [options, expected] of [
    [{ authorize: async () => { throw Object.assign(new Error('SECRET'), { code: 'invalid_token' }); } }, 'invalid_token'],
    [{ authorize: async () => ({ ...writeCtx, userId: '99' }) }, 'insufficient_scope'],
    [{ authorize: async () => ({ ...writeCtx, scopes: ['workouts:read'] }) }, 'insufficient_scope']
  ]) {
    const p = await protocol(writeCtx, { ...options, activities: { create: async () => { throw new Error('should not reach'); } } });
    try {
      const result = await p.client.callTool({ name: 'create_training_activity', arguments: {
        activity_type: 'mobility', start_time: '2026-11-11T08:00:00Z', duration_seconds: 3600 } });
      assert.equal(result.isError, true);
      assert.equal(JSON.parse(result.content[0].text).error.code, expected);
      assert.ok(!JSON.stringify(result).includes('SECRET'));
    } finally { await p.close(); }
  }
});

test('get_workout_gps returns GeoJSON and uses gps rate limit bucket', async () => {
  const geoJson = { type: 'Feature', properties: { workout_id: '42' }, geometry: null };
  const workouts = { gps: async (owner, id) => { if (id === '99') { const e = new Error(); e.code = 'workout_not_found'; throw e; } assert.equal(owner, '71'); assert.equal(id, '42'); return JSON.stringify(geoJson); } };
  const budgets = [];
  const p = await protocol(context, { workouts, allowance: async (...args) => { budgets.push(args); return { allowed: true, retryAfter: 0 }; } });
  try {
    const result = await p.client.callTool({ name: 'get_workout_gps', arguments: { workout_id: '42' } });
    assert.ok(!result.isError); assert.deepEqual(result.structuredContent, geoJson);
    assert.deepEqual(JSON.parse(result.content[0].text), geoJson);
    assert.equal(budgets.length, 1); assert.equal(budgets[0].join(','), 'gps,40,71');
    const notFound = await p.client.callTool({ name: 'get_workout_gps', arguments: { workout_id: '99' } });
    assert.ok(notFound.isError); assert.equal(JSON.parse(notFound.content[0].text).error.code, 'workout_not_found');
  } finally { await p.close(); }
});

test('delete_workout deletes owned workout and returns confirmation', async t => {
  const logs = []; t.mock.method(console, 'error', text => logs.push(JSON.parse(text)));
  const writeCtx = { ...context, scopes: ['activities:write'] };
  let deleted = null;
  const db = { deleteWorkout: async (uid, id) => { if (id === '999') throw new Error('Workout not found'); deleted = { uid, id }; } };
  const p = await protocol(writeCtx, { db });
  try {
    const result = await p.client.callTool({ name: 'delete_workout', arguments: { workout_id: '123' } });
    assert.ok(!result.isError); assert.deepEqual(result.structuredContent, { deleted: true, workout_id: '123' });
    assert.deepEqual(deleted, { uid: '71', id: '123' });
    const notFound = await p.client.callTool({ name: 'delete_workout', arguments: { workout_id: '999' } });
    assert.ok(notFound.isError); assert.equal(JSON.parse(notFound.content[0].text).error.code, 'workout_not_found');
  } finally { await p.close(); }
});

test('get_workout_map returns WebP image content and uses gps rate limit bucket', async () => {
  const fakeWebp = Buffer.from('fake-webp-data');
  const workouts = { map: async (owner, id) => { if (id === '99') { const e = new Error(); e.code = 'map_unavailable'; throw e; } assert.equal(owner, '71'); assert.equal(id, '42'); return fakeWebp; } };
  const budgets = [];
  const p = await protocol(context, { workouts, allowance: async (...args) => { budgets.push(args); return { allowed: true, retryAfter: 0 }; } });
  try {
    const result = await p.client.callTool({ name: 'get_workout_map', arguments: { workout_id: '42' } });
    assert.ok(!result.isError);
    assert.equal(result.content.length, 2);
    assert.equal(result.content[1].type, 'image'); assert.equal(result.content[1].mimeType, 'image/webp');
    assert.equal(result.content[1].data, fakeWebp.toString('base64'));
    const meta = JSON.parse(result.content[0].text);
    assert.equal(meta.workout_id, '42'); assert.equal(meta.width, 640); assert.equal(meta.height, 400);
    assert.equal(meta.data_url, `data:image/webp;base64,${fakeWebp.toString('base64')}`);
    assert.equal(budgets.length, 1); assert.equal(budgets[0].join(','), 'gps,40,71');
    const unavailable = await p.client.callTool({ name: 'get_workout_map', arguments: { workout_id: '99' } });
    assert.ok(unavailable.isError); assert.equal(JSON.parse(unavailable.content[0].text).error.code, 'map_unavailable');
  } finally { await p.close(); }
});
