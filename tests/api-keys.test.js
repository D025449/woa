import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import Service, { normalizeApiKeyScopes } from "../src/services/apiKeyService.js";
import express from "express";
import apiKeyAuth from "../src/middleware/apiKeyAuth.js";
import apiKeyRoutes from "../src/routes/apiKeyRoutes.js";
import AccountDeletionService from "../src/services/accountDeletionService.js";

const keyRow = { id: "9", name: "Local MCP", key_prefix: "woa_pk_example", scopes: ["workouts:read"],
  created_at: "2026-11-09T12:00:00Z", expires_at: "2027-02-07T12:00:00Z",
  revoked_at: null, last_used_at: null };

function creationDatabase({ status = "active", count = 0, insertError = null } = {}) {
  const calls = [];
  let released = false;
  const client = { release() { released = true; }, async query(sql, params) {
    calls.push({ sql, params });
    if (sql.includes("SELECT account_status")) return { rows: [{ account_status: status }] };
    if (sql.includes("COUNT(*)")) return { rows: [{ count }] };
    if (sql.includes("INSERT")) {
      if (insertError) throw insertError;
      return { rows: [{ ...keyRow, key_prefix: params[2], scopes: params[4] }] };
    }
    return { rows: [] };
  } };
  return { calls, get released() { return released; }, async connect() { return client; } };
}

test("API keys validate scope dependencies and reject unknown, duplicate and empty scopes", () => {
  assert.deepEqual(normalizeApiKeyScopes(["workouts:gps:read", "workouts:read"]), ["workouts:read", "workouts:gps:read"]);
  assert.deepEqual(normalizeApiKeyScopes(["workouts:fit:read", "workouts:gps:read", "workouts:read"]),
    ["workouts:read", "workouts:gps:read", "workouts:fit:read"]);
  for (const scopes of [null, [], ["analytics:write"], ["workouts:gps:read"], ["workouts:fit:read"],
    ["workouts:read", "workouts:fit:read"], ["*"], ["workouts:read", "workouts:read"]]) {
    assert.throws(() => normalizeApiKeyScopes(scopes), { statusCode: 400 });
  }
});

test("API key issuance stores only a hash, serializes the user limit and reveals fresh secrets once", async () => {
  const database = creationDatabase();
  const result = await Service.create(42, { name: " Local MCP ", scopes: ["workouts:read"] }, database);
  assert.match(result.secret, /^woa_pk_[A-Za-z0-9_-]{43}$/);
  const insertion = database.calls.find(call => call.sql.includes("INSERT"));
  assert.deepEqual(insertion.params, ["42", "Local MCP", result.secret.slice(0, 17),
    createHash("sha256").update(result.secret).digest("hex"), ["workouts:read"]]);
  assert.ok(!JSON.stringify(database.calls).includes(result.secret));
  assert.match(database.calls[1].sql, /FOR UPDATE/);
  assert.match(insertion.sql, /INTERVAL '90 days'/);
  assert.equal(database.calls.at(-1).sql, "COMMIT");
  assert.equal(database.released, true);
  assert.notEqual((await Service.create(42, { name: "Other", scopes: ["workouts:read"] }, database)).secret, result.secret);
  assert.ok(!("secret" in result.key));
  assert.ok(!("key_hash" in result.key));
});

test("API key issuance refuses inactive accounts and five active keys and rolls back failures", async () => {
  for (const [options, statusCode] of [[{ status: "pending_deletion" }, 423], [{ status: "deleted" }, 403],
    [{ status: "unexpected" }, 403], [{ count: 5 }, 409], [{ count: 6 }, 409]]) {
    const database = creationDatabase(options);
    await assert.rejects(Service.create(42, { name: "MCP", scopes: ["workouts:read"] }, database), { statusCode });
    assert.equal(database.calls.at(-1).sql, "ROLLBACK");
    assert.ok(!database.calls.some(call => call.sql.includes("INSERT")));
    assert.equal(database.released, true);
  }
  const failure = new Error("offline");
  const database = creationDatabase({ insertError: failure });
  await assert.rejects(Service.create(42, { name: "MCP", scopes: ["workouts:read"] }, database), failure);
  assert.equal(database.calls.at(-1).sql, "ROLLBACK");
  assert.equal(database.released, true);
});

test("new FIT keys store only explicitly selected normalized scopes", async () => {
  const database = creationDatabase();
  const scopes = ["workouts:fit:read", "workouts:gps:read", "workouts:read"];
  const result = await Service.create(42, { name: "FIT client", scopes }, database);
  const stored = database.calls.find(call => call.sql.includes("INSERT")).params[4];
  assert.deepEqual(stored, ["workouts:read", "workouts:gps:read", "workouts:fit:read"]);
  assert.deepEqual(result.key.scopes, stored);
});

test("analytics keys can be issued and resolved independently without upgrading stored workout keys", async () => {
  const database = creationDatabase();
  const result = await Service.create(42, { name: "Analytics", scopes: ["analytics:read"] }, database);
  assert.deepEqual(result.key.scopes, ["analytics:read"]);
  const row = { id: "9", user_id: "42", scopes: ["analytics:read"], account_status: "active" };
  const resolved = await Service.resolve(result.secret, { async query() { return { rows: [row] }; } });
  assert.deepEqual(resolved.scopes, ["analytics:read"]);
  assert.deepEqual(normalizeApiKeyScopes(["workouts:read"]), ["workouts:read"]);
});

test("API key invalid inputs fail before acquiring a database client", async () => {
  const database = creationDatabase();
  for (const name of [undefined, null, {}, "", "  ", "x".repeat(81), "a\nb"]) {
    await assert.rejects(Service.create(42, { name, scopes: ["workouts:read"] }, database), { statusCode: 400 });
  }
  await assert.rejects(Service.create("90071992547409930000", { name: "MCP", scopes: ["workouts:read"] }, database), { statusCode: 401 });
  assert.equal(database.calls.length, 0);
});

test("API key lookup derives identity from the hashed secret and rechecks revocation and account state", async () => {
  const secret = `woa_pk_${"a".repeat(43)}`;
  const calls = [];
  const database = { async query(sql, params) {
    calls.push({ sql, params });
    return { rows: [{ id: "9", user_id: "42", scopes: ["workouts:read"], account_status: "pending_deletion" }] };
  } };
  assert.deepEqual(await Service.resolve(secret, database), { userId: "42", keyId: "9", scopes: ["workouts:read"] });
  assert.deepEqual(calls[0].params, [createHash("sha256").update(secret).digest("hex")]);
  for (const call of calls) {
    assert.match(call.sql, /revoked_at IS NULL/);
    assert.match(call.sql, /expires_at > NOW\(\)/);
  }
  assert.deepEqual(calls[1].params, ["9", "42"]);
  assert.match(calls[1].sql, /account_status IN/);
  assert.ok(!JSON.stringify(calls).includes(secret));
});

test("API key lookup fails closed for absent, deleted, malformed-scope and concurrently revoked keys", async () => {
  const secret = `woa_pk_${"a".repeat(43)}`;
  const row = { id: "9", user_id: "42", scopes: ["workouts:read"], account_status: "active" };
  for (const [rows, statusCode] of [[[], 401], [[{ ...row, account_status: "deleted" }], 403],
    [[{ ...row, scopes: ["analytics:write"] }], 401]]) {
    await assert.rejects(Service.resolve(secret, { async query() { return { rows }; } }), { statusCode });
  }
  let calls = 0;
  await assert.rejects(Service.resolve(secret, { async query() {
    return { rows: calls++ === 0 ? [row] : [] };
  } }), { statusCode: 401 });
  await assert.rejects(Service.resolve("bad", { query() { throw new Error("must not query"); } }), { statusCode: 401 });
});

test("API key metadata is allowlisted and revocation is bound to the owning user", async () => {
  const calls = [];
  const database = { async query(sql, params) {
    calls.push({ sql, params });
    if (sql.includes("SELECT account_status")) return { rows: [{ account_status: "pending_deletion" }] };
    return { rows: [{ ...keyRow, status: "revoked", key_hash: "must-not-leak" }] };
  } };
  const result = await Service.list(42, database);
  assert.equal(result.canCreate, false);
  assert.deepEqual(result.limits, { maxActiveKeys: 5, lifetimeDays: 90 });
  assert.ok(!JSON.stringify(result).includes("must-not-leak"));
  assert.match(calls[1].sql, /ORDER BY \(revoked_at IS NULL AND expires_at > NOW\(\)\) DESC/);
  await Service.revoke(42, "9", database);
  assert.deepEqual(calls.at(-1).params, ["9", "42"]);
  assert.match(calls.at(-1).sql, /k.user_id = \$2/);
  assert.match(calls.at(-1).sql, /pending_deletion/);
  await assert.rejects(Service.revoke(43, "9", { async query() { return { rows: [] }; } }), { statusCode: 404 });
});

async function serve(t, app) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test("Bearer middleware uses only key identity, enforces both GPS scopes and hides outages", async t => {
  const app = express();
  let context = { userId: "42", keyId: "9", scopes: ["workouts:read"] };
  let failure;
  const secrets = [];
  t.mock.method(Service, "resolve", async secret => {
    secrets.push(secret);
    if (failure) throw failure;
    return context;
  });
  app.use((req, res, next) => { req.user = { id: 99 }; next(); });
  app.get("/read", apiKeyAuth(["workouts:read"]), (req, res) => res.json(req.apiAuth));
  app.get("/gps", apiKeyAuth(["workouts:gps:read"]), (req, res) => res.json(req.apiAuth));
  app.get("/fit", apiKeyAuth(["workouts:fit:read"]), (req, res) => res.json(req.apiAuth));
  const base = await serve(t, app);
  const secret = `woa_pk_${"a".repeat(43)}`;
  const headers = { Authorization: `Bearer ${secret}` };
  assert.equal((await fetch(`${base}/read?userId=99`)).status, 401);
  assert.equal(secrets.length, 0);
  const response = await fetch(`${base}/read?userId=99`, { headers });
  assert.deepEqual(await response.json(), context);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(secrets[0], secret);
  assert.equal((await fetch(`${base}/gps`, { headers })).status, 403);
  context = { ...context, scopes: ["workouts:read", "workouts:gps:read"] };
  assert.equal((await fetch(`${base}/gps`, { headers })).status, 200);
  assert.equal((await fetch(base + "/fit", { headers })).status, 403);
  context = { ...context, scopes: ["workouts:read", "workouts:gps:read", "workouts:fit:read"] };
  assert.equal((await fetch(base + "/fit", { headers })).status, 200);
  for (const statusCode of [401, 403, 503]) {
    failure = Object.assign(new Error(`private ${secret}`), { statusCode });
    const denied = await fetch(`${base}/read`, { headers });
    assert.equal(denied.status, statusCode);
    assert.ok(!(await denied.text()).includes(secret));
    if (statusCode === 401) assert.match(denied.headers.get("www-authenticate"), /Bearer/);
  }
  assert.throws(() => apiKeyAuth(["analytics:write"]), TypeError);
});

test("key management requires browser identity, same origin and a session-bound CSRF token", async t => {
  const app = express();
  app.use(express.json());
  const session = { user_id: 42, apiKeyCsrfToken: undefined };
  app.use((req, res, next) => {
    req.cookies = {};
    req.session = req.headers["x-session"] ? session : {};
    if (req.headers["x-user"]) req.user = { id: Number(req.headers["x-user"]) };
    next();
  });
  app.use("/api/profile/api-keys", apiKeyRoutes);
  const calls = [];
  t.mock.method(Service, "list", async owner => {
    calls.push({ method: "list", owner });
    return { keys: [], canCreate: true, limits: { maxActiveKeys: 5, lifetimeDays: 90 } };
  });
  t.mock.method(Service, "create", async (owner, input) => {
    calls.push({ method: "create", owner, input });
    return { key: { id: "9" }, secret: "shown-once" };
  });
  t.mock.method(Service, "revoke", async (owner, id) => { calls.push({ method: "revoke", owner, id }); });
  const base = await serve(t, app);
  const url = `${base}/api/profile/api-keys`;
  const headers = { "x-user": "42", "x-session": "1", "Content-Type": "application/json" };
  for (const candidate of [{}, { "x-user": "42" }, { "x-user": "99", "x-session": "1" },
    { ...headers, Authorization: "Bearer any-key" }]) {
    assert.equal((await fetch(url, { headers: candidate })).status, 401);
  }
  assert.equal(calls.length, 0);
  const listed = await fetch(url, { headers });
  assert.equal(listed.headers.get("cache-control"), "no-store");
  const { csrfToken } = await listed.json();
  assert.match(csrfToken, /^[a-f0-9]{64}$/);
  const body = JSON.stringify({ name: "MCP", scopes: ["workouts:read"], userId: 99 });
  for (const protection of [{}, { Origin: base }, { Origin: "https://foreign.invalid", "x-csrf-token": csrfToken },
    { Origin: base, "x-csrf-token": "b".repeat(64) }]) {
    assert.equal((await fetch(url, { method: "POST", headers: { ...headers, ...protection }, body })).status, 403);
  }
  const protectedHeaders = { ...headers, Origin: base, "x-csrf-token": csrfToken };
  const minted = await fetch(url, { method: "POST", headers: protectedHeaders, body });
  assert.equal(minted.status, 201);
  assert.equal((await minted.json()).data.secret, "shown-once");
  assert.deepEqual(calls.at(-1), { method: "create", owner: 42, input: { name: "MCP", scopes: ["workouts:read"] } });
  assert.equal((await fetch(`${url}/9`, { method: "DELETE", headers: protectedHeaders })).status, 204);
  assert.deepEqual(calls.at(-1), { method: "revoke", owner: 42, id: "9" });
  t.mock.method(Service, "list", async () => { throw new Error("SQL and private credentials"); });
  const unavailable = await fetch(url, { headers });
  assert.equal(unavailable.status, 503);
  assert.ok(!(await unavailable.text()).includes("SQL"));
});

test("final account deletion removes API keys in the same transaction", async () => {
  const calls = [];
  const database = { async query(sql, params) {
    calls.push({ sql, params });
    if (sql.includes("SELECT id")) return { rowCount: 1, rows: [{ id: 42 }] };
    return { rowCount: 1, rows: [{ account_status: "deleted" }] };
  } };
  await AccountDeletionService.executeDeletion(42, database);
  const removal = calls.find(call => call.sql.includes("DELETE FROM user_api_keys"));
  assert.deepEqual(removal.params, [42]);
  assert.equal(calls[0].sql, "BEGIN");
  assert.equal(calls.at(-1).sql, "COMMIT");
});
