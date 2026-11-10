import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createTrainingMcpServer, MCP_TOOL_NAMES } from '../src/services/mcpServerService.js';
import McpOAuthService, { mcpTokenHash } from '../src/services/mcpOAuthService.js';
import { readMcpConfig, mcpScopes, mcpRedirectMatches } from '../src/services/mcpConfig.js';

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
  assert.deepEqual(mcpScopes(undefined), ['workouts:read', 'analytics:read']);
  for (const scopes of ['offline_access', 'analytics:read analytics:read', 'workouts:gps:read', 'analytics:read ', '']) assert.throws(() => mcpScopes(scopes));
  const oauth = new McpOAuthService(config, {});
  for (const change of [{ client_id: 'unknown' }, { redirect_uri: 'https://evil.example/' }, { resource: config.origin }, { code_challenge_method: 'plain' }, { response_type: 'token' }, { code_challenge: 'bad' }, { scope: 'workouts:fit:read' }]) assert.throws(() => oauth.authorization(authParams(change)));
  const duplicate = authParams(); duplicate.append('client_id', 'chatgpt'); assert.throws(() => oauth.authorization(duplicate));
  const unknown = authParams(); unknown.append('owner', '72'); assert.throws(() => oauth.authorization(unknown));
  assert.equal(oauth.client('chatgpt').client_id, 'chatgpt'); assert.throws(() => oauth.client('private')); assert.throws(() => oauth.client('private', 'wrong'));
  assert.equal(oauth.client('private', 'test-secret').client_id, 'private'); assert.throws(() => oauth.client('chatgpt', 'test-secret'));
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

test('real MCP advertises exactly six scoped read-only tools with strict schemas', async () => {
  for (const [scopes, expected] of [[context.scopes, MCP_TOOL_NAMES], [['analytics:read'], ['get_training_summary', 'get_training_load', 'get_ftp_history']], [['workouts:read'], ['list_workouts', 'get_workout']]]) {
    const p = await protocol({ ...context, scopes }); try { assert.equal(p.client.getServerVersion().name, 'woa-training'); const { tools } = await p.client.listTools(); assert.deepEqual(tools.map(tool => tool.name), expected); for (const tool of tools) { assert.equal(tool.annotations.readOnlyHint, true); assert.equal(tool.annotations.destructiveHint, false); assert.equal(tool.inputSchema.additionalProperties, false); } assert.ok(!JSON.stringify(tools).includes('api_key')); } finally { await p.close(); }
  }
});

test('real MCP dispatches owned IDs, dates, paging and shared analytics budgets', async () => {
  const calls = [], budgets = []; const service = Object.fromEntries(['list', 'detail', 'summary', 'trainingLoad', 'powerProfile', 'ftpHistory'].map(method => [method, async (owner, params) => { calls.push([method, owner, params instanceof URLSearchParams ? Object.fromEntries(params) : params]); return { data: [], meta: { coverage: 'missing' }, next_cursor: null }; }]));
  const p = await protocol(context, { workouts: service, analytics: service, allowance: async (...args) => { budgets.push(args); return { allowed: true, retryAfter: 0 }; } });
  try {
    for (const name of MCP_TOOL_NAMES) { const args = name === 'get_workout' ? { workout_id: '9007199254740993' } : name === 'list_workouts' ? { limit: 12, cursor: 'opaque' } : { from: '2026-10-01', to: '2026-11-01', ...(name === 'get_power_profile' ? { durations: [5, 480] } : name === 'get_ftp_history' ? { grouping: 'week' } : {}) }; const result = await p.client.callTool({ name, arguments: args }); assert.ok(!result.isError); assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent); }
    assert.equal(calls.length, 6); assert.ok(calls.every(call => call[1] === '71')); assert.equal(calls.find(call => call[0] === 'detail')[2], '9007199254740993'); assert.equal(calls.find(call => call[0] === 'powerProfile')[2].durations, '5,480'); assert.equal(budgets.length, 4); assert.ok(budgets.every(args => args.join(',') === 'analytics,10,71'));
    for (const args of [{ owner: '72' }, { api_key: 'SECRET' }, { limit: 101 }, { limit: '20' }]) assert.equal((await p.client.callTool({ name: 'list_workouts', arguments: args })).isError, true);
    assert.equal((await p.client.callTool({ name: 'get_power_profile', arguments: { durations: [5, 5] } })).isError, true); assert.equal(calls.length, 6);
  } finally { await p.close(); }
});

test('MCP rechecks revocation and owner and safely reports quota, size and service failures', async () => {
  for (const [options, expected] of [[{ authorize: async () => { throw Object.assign(new Error('SECRET'), { code: 'invalid_token' }); } }, 'invalid_token'], [{ authorize: async () => ({ ...context, userId: '72' }) }, 'insufficient_scope'], [{ authorize: async () => ({ ...context, scopes: [] }) }, 'insufficient_scope'], [{ allowance: async () => ({ allowed: false, retryAfter: 31 }) }, 'rate_limited'], [{ allowance: async () => { throw new Error('SECRET redis URL'); } }, 'service_unavailable'], [{ allowance: async () => ({ allowed: true }), analytics: { summary: async () => { throw new Error('SECRET SQL'); } } }, 'service_unavailable'], [{ allowance: async () => ({ allowed: true }), analytics: { summary: async () => ({ data: 'x'.repeat(1024 * 1024) }) } }, 'response_too_large']]) {
    const p = await protocol(context, options); try { const result = await p.client.callTool({ name: 'get_training_summary', arguments: {} }); assert.equal(result.isError, true); assert.equal(JSON.parse(result.content[0].text).error.code, expected); assert.ok(!JSON.stringify(result).includes('SECRET')); } finally { await p.close(); }
  }
});

test('six locales render consent and connection list with escaping', async () => {
  const ejs = await import('ejs');
  for (const locale of ['de', 'en', 'es', 'fr', 'it', 'pt']) { const messages = JSON.parse(await readFile(new URL('../src/public/i18n/' + locale + '.json', import.meta.url))); const t = key => key.split('.').reduce((value, part) => value?.[part], messages); const html = await ejs.renderFile(new URL('../src/views/mcp-consent.ejs', import.meta.url).pathname, { locale, t, clientName: '<script>SECRET</script>', scopes: context.scopes, csrfToken: 'f'.repeat(64) }); assert.ok(html.includes('&lt;script&gt;')); assert.ok(!html.includes('<script>SECRET')); assert.ok(!html.includes('undefined')); const profile = await ejs.renderFile(new URL('../src/views/partials/profile/mcp-connections.ejs', import.meta.url).pathname, { t }); assert.ok(profile.includes('mcp-connections-list')); assert.ok(!profile.includes('profile.mcp.')); }
});
