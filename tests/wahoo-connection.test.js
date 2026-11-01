import test from "node:test";
import assert from "node:assert/strict";
import pool from "../src/services/database.js";
import Service, { encryptWahooTokens, decryptWahooTokens } from "../src/services/wahooConnectionService.js";

function configure(t) {
  for (const [name, value] of Object.entries({ WAHOO_CLIENT_ID: "example-client", WAHOO_CLIENT_SECRET: "example-secret",
    WAHOO_REDIRECT_URI: "https://woa.example/auth/wahoo/callback", WAHOO_TOKEN_ENCRYPTION_KEY: "ab".repeat(32) })) {
    const previous = process.env[name];
    process.env[name] = value;
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  }
}
const tokens = { accessToken: "private-access", refreshToken: "private-refresh", expiresAt: 0 };
const response = () => ({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 7200, token_type: "Bearer" });

test("Wahoo encryption uses fresh IVs and authenticates user and ciphertext", t => {
  configure(t);
  const envelope = encryptWahooTokens(42, tokens);
  assert.notEqual(envelope, encryptWahooTokens(42, tokens));
  assert.deepEqual(decryptWahooTokens(42, envelope), tokens);
  assert.throws(() => decryptWahooTokens(43, envelope));
  const parts = envelope.split(":");
  const bytes = Buffer.from(parts[3], "base64");
  bytes[0] ^= 1;
  parts[3] = bytes.toString("base64");
  assert.throws(() => decryptWahooTokens(42, parts.join(":")));
  process.env.WAHOO_TOKEN_ENCRYPTION_KEY = "cd".repeat(32);
  assert.throws(() => decryptWahooTokens(42, envelope));
});

test("Wahoo authorization has fixed endpoint, minimal scope and validated configuration", t => {
  configure(t);
  const url = new URL(Service.authorizationUrl("example-state"));
  assert.equal(url.origin, "https://api.wahooligan.com");
  assert.equal(url.searchParams.get("scope"), "user_read workouts_read");
  assert.equal(url.searchParams.get("state"), "example-state");
  assert.equal(url.searchParams.get("client_secret"), null);
  for (const invalid of ["https://woa.example/other", "https://woa.example/auth/wahoo/callback?x=1", "http://woa.example/auth/wahoo/callback"]) {
    process.env.WAHOO_REDIRECT_URI = invalid;
    assert.throws(() => Service.config());
  }
});

test("Wahoo code exchange sends credentials only in POST body and persists ciphertext scoped to user", async t => {
  configure(t);
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://api.wahooligan.com/oauth/token");
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "error");
    const body = JSON.parse(options.body);
    assert.equal(body.client_secret, "example-secret");
    assert.equal(body.code, "code");
    return Response.json(response());
  });
  t.mock.method(pool, "query", async (sql, params) => {
    assert.match(sql, /INSERT INTO user_wahoo_connections/);
    assert.equal(params[0], 42);
    const stored = decryptWahooTokens(42, params[1]);
    assert.equal(stored.accessToken, "new-access");
    assert.equal(stored.refreshToken, "new-refresh");
    assert.ok(stored.expiresAt > Date.now());
    assert.ok(!params[1].includes("new-access"));
    return { rows: [] };
  });
  await Service.connect(42, "code");
});

test("Wahoo invalid responses, HTTP errors, redirects and large responses remain sanitized", async t => {
  configure(t);
  for (const payload of [{}, { ...response(), refresh_token: null }, { ...response(), expires_in: -1 }, { ...response(), access_token: "bad token" }]) {
    t.mock.method(globalThis, "fetch", async () => Response.json(payload));
    await assert.rejects(Service.exchange({}), /Invalid Wahoo token response/);
    t.mock.restoreAll();
  }
  for (const result of [new Response("private provider error", { status: 401 }), new Response("x".repeat(65537))]) {
    t.mock.method(globalThis, "fetch", async () => result);
    await assert.rejects(Service.exchange({}), { message: "Wahoo request failed" });
    t.mock.restoreAll();
  }
});

test("Wahoo status and deletion return no credentials and use only requested user", async t => {
  configure(t);
  const calls = [];
  t.mock.method(pool, "query", async (sql, params) => { calls.push([sql, params]); return { rows: [{ updated_at: "date" }] }; });
  assert.deepEqual(await Service.status(42), { configured: true, available: true, updatedAt: "date" });
  await Service.remove(43);
  assert.deepEqual(calls.map(call => call[1]), [[42], [43]]);
  assert.match(calls[0][0], /^SELECT updated_at/);
  assert.match(calls[1][0], /^DELETE/);
});

for (const expired of [false, true]) {
  test(`Wahoo API access ${expired ? "rotates expired tokens before an API call" : "reuses valid tokens"}`, async t => {
    configure(t);
    const calls = [];
    const client = {
      async query(sql, params) {
        calls.push([sql, params]);
        if (sql.startsWith("SELECT")) return { rows: [{ tokens_encrypted: encryptWahooTokens(42, { ...tokens, expiresAt: expired ? 0 : Date.now() + 3600000 }) }] };
        return { rows: [] };
      },
      release() { calls.push(["release"]); }
    };
    t.mock.method(pool, "connect", async () => client);
    const urls = [];
    t.mock.method(globalThis, "fetch", async (url, options) => {
      urls.push(url);
      if (url.endsWith("/oauth/token")) {
        assert.equal(JSON.parse(options.body).refresh_token, "private-refresh");
        return Response.json(response());
      }
      assert.equal(options.headers.Authorization, `Bearer ${expired ? "new-access" : "private-access"}`);
      return Response.json({ id: 123 });
    });
    assert.deepEqual(await Service.readUser(42), { id: 123 });
    assert.match(calls[1][0], /WHERE user_id = \$1 FOR UPDATE/);
    assert.deepEqual(calls[1][1], [42]);
    assert.equal(urls.length, expired ? 2 : 1);
    assert.equal(calls.some(call => call[0].startsWith("UPDATE")), expired);
    if (expired) assert.equal(decryptWahooTokens(42, calls[2][1][1]).refreshToken, "new-refresh");
    assert.equal(calls.at(-1)[0], "release");
  });
}

test("Wahoo keeps rotated credentials after an API failure and always releases its database client", async t => {
  configure(t);
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push([sql, params]);
      return { rows: sql.startsWith("SELECT") ? [{ tokens_encrypted: encryptWahooTokens(42, tokens) }] : [] };
    },
    release() { calls.push(["release"]); }
  };
  t.mock.method(pool, "connect", async () => client);
  t.mock.method(globalThis, "fetch", async url => url.endsWith("/oauth/token")
    ? Response.json(response()) : new Response("private error", { status: 500 }));
  await assert.rejects(Service.readUser(42), { message: "Wahoo request failed" });
  assert.equal(decryptWahooTokens(42, calls.find(call => call[0].startsWith("UPDATE"))[1][1]).refreshToken, "new-refresh");
  assert.ok(calls.some(call => call[0] === "COMMIT"));
  assert.ok(!calls.some(call => call[0] === "ROLLBACK"));
  assert.equal(calls.at(-1)[0], "release");
});

test("Wahoo missing connection rolls back without external requests", async t => {
  const calls = [];
  const client = {
    async query(sql) { calls.push(sql); return { rows: [] }; },
    release() { calls.push("release"); }
  };
  t.mock.method(pool, "connect", async () => client);
  t.mock.method(globalThis, "fetch", async () => assert.fail("No external call for disconnected user"));
  await assert.rejects(Service.readUser(42), { message: "Wahoo request failed" });
  assert.equal(calls.at(-2), "ROLLBACK");
  assert.equal(calls.at(-1), "release");
});
