import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import router, { wahooCallback } from "../src/routes/wahooRoutes.js";
import Service from "../src/services/wahooConnectionService.js";

const state = "a".repeat(64);
function request(query = { state, code: "example-code" }) {
  return { user: { id: 42 }, query, session: {
    wahooOAuth: { state, userId: 42, createdAt: Date.now() },
    save(callback) { callback(); }
  } };
}

test("Wahoo callback consumes state before exchange; rejects replay, foreign users, expiry and invalid parameters", async t => {
  const calls = [];
  t.mock.method(Service, "connect", async (...args) => calls.push(args));
  let target;
  const res = { redirect(value) { target = value; } };
  const req = request();
  await wahooCallback(req, res);
  assert.equal(target, "/profile?wahoo=connected#wahoo-settings");
  assert.deepEqual(calls, [[42, "example-code"]]);
  assert.equal(req.session.wahooOAuth, undefined);
  await wahooCallback(req, res);
  assert.equal(target, "/profile?wahoo=error#wahoo-settings");
  for (const mutate of [
    r => { r.query.state = "b".repeat(64); },
    r => { r.query.state = [state]; },
    r => { r.query.code = {}; },
    r => { r.session.wahooOAuth.userId = 43; },
    r => { r.session.wahooOAuth.createdAt -= 600001; },
    r => { delete r.session.wahooOAuth; },
    r => { r.session.save = cb => cb(new Error("private session failure")); }
  ]) {
    const invalid = request();
    mutate(invalid);
    await wahooCallback(invalid, res);
    assert.equal(target, "/profile?wahoo=error#wahoo-settings");
  }
  const denied = request({ state, error: "access_denied", error_description: "private provider text" });
  await wahooCallback(denied, res);
  assert.equal(target, "/profile?wahoo=denied#wahoo-settings");
  assert.equal(calls.length, 1);
});

test("Wahoo provider failures never escape into redirect parameters", async t => {
  t.mock.method(Service, "connect", async () => { throw new Error("private token"); });
  let target;
  await wahooCallback(request(), { redirect(value) { target = value; } });
  assert.equal(target, "/profile?wahoo=error#wahoo-settings");
});

test("Wahoo endpoints enforce login, active account, Origin, safe status and session persistence", async t => {
  const previous = process.env.WAHOO_REDIRECT_URI;
  process.env.WAHOO_REDIRECT_URI = "https://woa.example/auth/wahoo/callback";
  t.after(() => { if (previous === undefined) delete process.env.WAHOO_REDIRECT_URI; else process.env.WAHOO_REDIRECT_URI = previous; });
  t.mock.method(Service, "authorizationUrl", value => `https://api.wahooligan.com/oauth/authorize?state=${value}`);
  t.mock.method(Service, "status", async userId => {
    assert.equal(userId, 42);
    return { configured: true, available: true, updatedAt: null };
  });
  const removed = [];
  t.mock.method(Service, "remove", async id => removed.push(id));
  const settings = [];
  t.mock.method(Service, "setAutoImport", async (...args) => settings.push(args));
  const app = express();
  app.use(express.json());
  const session = { save(callback) { callback(); } };
  app.use((req, res, next) => {
    req.cookies = {};
    req.session = session;
    if (req.headers["x-user"]) req.user = { id: 42, account_status: req.headers["x-status"] || "active" };
    next();
  });
  app.use("/auth/wahoo", router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/auth/wahoo`;
  for (const [path, method] of [["status", "GET"], ["start", "POST"], ["connection", "DELETE"], ["callback", "GET"], ["auto-import", "PUT"]]) {
    assert.equal((await fetch(`${base}/${path}`, { method })).status, 401);
  }
  for (const [path, method] of [["start", "POST"], ["connection", "DELETE"], ["auto-import", "PUT"]]) {
    assert.equal((await fetch(`${base}/${path}`, { method, headers: { "x-user": "1", "x-status": "pending_deletion" } })).status, 423);
    for (const origin of [undefined, "https://attacker.example"]) {
      const headers = { "x-user": "1" };
      if (origin) headers.Origin = origin;
      assert.equal((await fetch(`${base}/${path}`, { method, headers })).status, 403);
    }
  }
  const headers = { "x-user": "1", Origin: "https://woa.example" };
  assert.equal((await fetch(`${base}/auto-import`, { method: "PUT", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ enabled: true, userId: 99 }) })).status, 204);
  assert.deepEqual(settings, [[42, true]]);
  assert.equal((await fetch(`${base}/auto-import`, { method: "PUT", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ enabled: "true" }) })).status, 400);
  const status = await fetch(`${base}/status`, { headers });
  assert.equal(status.headers.get("cache-control"), "no-store");
  assert.equal(status.headers.get("referrer-policy"), "no-referrer");
  assert.deepEqual(await status.json(), { data: { configured: true, available: true, updatedAt: null } });
  const start = await fetch(`${base}/start`, { method: "POST", headers });
  assert.equal(start.status, 200);
  assert.match((await start.json()).url, /^https:\/\/api.wahooligan.com\/oauth\/authorize\?state=[a-f0-9]{64}$/);
  assert.equal(session.wahooOAuth.userId, 42);
  assert.equal((await fetch(`${base}/connection`, { method: "DELETE", headers })).status, 204);
  assert.deepEqual(removed, [42]);
  assert.equal(session.wahooOAuth, undefined);
});
