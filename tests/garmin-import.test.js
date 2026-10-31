import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import express from "express";
import pool from "../src/services/database.js";
import { encryptGarminKey } from "../src/services/garminConnectionService.js";
import Service, { garminDiagnostic } from "../src/services/garminConnectService.js";
import routes from "../src/routes/garminRoutes.js";

function setup(t, userId) {
  const previous = process.env.GARMIN_API_ENCRYPTION_KEY;
  process.env.GARMIN_API_ENCRYPTION_KEY = randomBytes(32).toString("hex");
  t.after(() => {
    if (previous === undefined) delete process.env.GARMIN_API_ENCRYPTION_KEY;
    else process.env.GARMIN_API_ENCRYPTION_KEY = previous;
  });
  const state = { envelope: encryptGarminKey(userId, "private-key") };
  t.mock.method(pool, "query", async (sql, params) => {
    assert.match(sql, /WHERE user_id = \$1/);
    assert.deepEqual(params, [userId]);
    return { rows: state.envelope ? [{ api_key_encrypted: state.envelope }] : [] };
  });
  return state;
}
const json = data => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
const activity = { activityId: 24905253979, activityName: "Evening ride", startTimeLocal: "2026-10-30 17:00:00", activityType: { typeKey: "road_biking" }, duration: 3600 };

test("Garmin caches tokens, shares concurrent token requests, downloads original ZIP and detects key changes", async t => {
  const state = setup(t, 101);
  let tokenCount = 0;
  const zip = Buffer.from([0x50, 0x4b, 3, 4, 0]);
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.ok(url.startsWith("https://personal.connectapi.garmin.com/"));
    assert.equal(options.redirect, "error");
    if (url.includes("personalapitoken-service")) {
      tokenCount++;
      assert.equal(options.method, "POST");
      assert.match(options.headers.Authorization, /^ApiKey (private-key|replacement-key)$/);
      return json({ access_token: `token-${tokenCount}`, expires_in: 86400 });
    }
    assert.equal(options.headers.Authorization, `Bearer token-${tokenCount}`);
    if (url.includes("download-service")) return new Response(zip);
    assert.ok(url.includes("limit=20"));
    return json([activity]);
  });
  const [first, second] = await Promise.all([Service.activities(101), Service.activities(101)]);
  assert.deepEqual(first, second);
  assert.deepEqual(first[0], { id: "24905253979", name: "Evening ride", startTime: "2026-10-30 17:00:00", sport: "road_biking", duration: 3600 });
  assert.equal(tokenCount, 1);
  assert.deepEqual(await Service.file(101, first[0].id), zip);
  state.envelope = encryptGarminKey(101, "replacement-key");
  await Service.activities(101);
  assert.equal(tokenCount, 2);
  state.envelope = null;
  await assert.rejects(Service.activities(101), { code: "garmin_not_configured" });
});

test("Garmin renews a rejected or expired token, with only one retry", async t => {
  setup(t, 102);
  let tokens = 0;
  let requests = 0;
  let rejectAll = false;
  t.mock.method(globalThis, "fetch", async url => {
    if (url.includes("personalapitoken-service")) {
      tokens++;
      return json({ accessToken: `token-${tokens}`, expiresIn: 86400 });
    }
    requests++;
    if (requests === 1 || rejectAll) return new Response("", { status: 401 });
    return json([]);
  });
  assert.deepEqual(await Service.activities(102), []);
  assert.equal(tokens, 2);
  assert.equal(requests, 2);
  rejectAll = true;
  await assert.rejects(Service.activities(102), { code: "garmin_token_expired" });
  assert.equal(requests, 4);
  assert.equal(tokens, 3);
});

test("Garmin does not reuse a token close to expiration", async t => {
  setup(t, 103);
  let tokens = 0;
  t.mock.method(globalThis, "fetch", async url => {
    if (url.includes("personalapitoken-service")) return json({ access_token: `short-${++tokens}`, expires_in: 1 });
    return json([]);
  });
  await Service.activities(103);
  await Service.activities(103);
  assert.equal(tokens, 2);
});

test("Garmin validates IDs, bounds responses and hides upstream secrets", async t => {
  setup(t, 104);
  let mode = "key";
  t.mock.method(globalThis, "fetch", async url => {
    if (url.includes("personalapitoken-service")) {
      return mode === "key" ? new Response("private-key secret", { status: 401 }) : json({ access_token: "token" });
    }
    if (mode === "rate") return new Response("sensitive upstream body", { status: 429 });
    if (mode === "large") return new Response("", { headers: { "Content-Length": String(65 * 1024 * 1024) } });
    if (mode === "html") return new Response("<html>Login</html>");
    if (mode === "array") return json({ unexpected: true });
    return json([]);
  });
  await assert.rejects(Service.activities(104), error => {
    assert.equal(error.code, "garmin_invalid_key");
    assert.ok(!error.message.includes("private-key"));
    return true;
  });
  mode = "rate";
  await assert.rejects(Service.activities(104), { code: "garmin_rate_limit" });
  mode = "large";
  await assert.rejects(Service.file(104, "123"), { code: "garmin_too_large" });
  mode = "html";
  await assert.rejects(Service.file(104, "123"), { code: "garmin_invalid_response" });
  mode = "array";
  await assert.rejects(Service.activities(104), { code: "garmin_invalid_response" });
  for (const id of ["../123", "0", "12?x=1", "9223372036854775808"]) {
    await assert.rejects(Service.file(104, id), { code: "garmin_invalid_activity" });
  }
});

test("Garmin routes isolate users, block inactive accounts and send ZIP with no cache", async t => {
  const calls = [];
  let activityFailure = null;
  t.mock.method(Service, "activities", async id => {
    if (activityFailure) throw activityFailure;
    calls.push(id); return [];
  });
  t.mock.method(Service, "file", async (id, activityId) => {
    calls.push([id, activityId]);
    return Buffer.from([0x50, 0x4b, 3, 4]);
  });
  const app = express();
  app.use((req, res, next) => {
    req.cookies = {};
    if (req.headers["x-test-user"]) req.user = { id: req.headers["x-test-user"], account_status: req.headers["x-test-status"] || "active" };
    next();
  });
  app.use("/api/garmin", routes);
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/garmin`;
  assert.equal((await fetch(`${base}/activities`)).status, 401);
  assert.equal((await fetch(`${base}/activities/123/file`)).status, 401);
  assert.equal((await fetch(`${base}/activities`, { headers: { "x-test-user": "42", "x-test-status": "pending_deletion" } })).status, 423);
  assert.equal(calls.length, 0);
  const response = await fetch(`${base}/activities/123/file?userId=99`, { headers: { "x-test-user": "42" } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-disposition"), /123.zip/);
  assert.equal((await response.arrayBuffer()).byteLength, 4);
  assert.deepEqual(calls.at(-1), ["42", "123"]);
  activityFailure = Object.assign(new Error("private-key"), { statusCode: 502, code: "garmin_unavailable",
    diagnostic: { stage: "token", upstreamStatus: 400, technicalCode: "HTTP_ERROR", body: "private-key" } });
  const logs = [];
  t.mock.method(console, "warn", (...args) => logs.push(args));
  const failed = await fetch(`${base}/activities`, { headers: { "x-test-user": "42" } });
  const body = await failed.json();
  assert.equal(failed.status, 502);
  assert.deepEqual(body.diagnostic, { stage: "token", upstreamStatus: 400, technicalCode: "HTTP_ERROR" });
  assert.ok(!JSON.stringify([body, logs]).includes("private-key"));
});


test("Garmin diagnostics identify HTTP, network and token-format failures without exposing secrets", async t => {
  setup(t, 105);
  let mode = "http";
  t.mock.method(globalThis, "fetch", async () => {
    if (mode === "http") return new Response("private-key secret body", { status: 400 });
    if (mode === "network") throw Object.assign(new Error("secret URL and private-key"), { cause: { code: "ENOTFOUND" } });
    if (mode === "unknown") throw Object.assign(new Error("secret"), { cause: { code: "private-key" } });
    return json({ unexpected: "private-key" });
  });
  for (const [next, status, code] of [["http", 400, "HTTP_ERROR"], ["network", undefined, "ENOTFOUND"], ["unknown", undefined, "NETWORK_ERROR"], ["format", 200, "INVALID_RESPONSE"]]) {
    mode = next;
    await assert.rejects(Service.activities(105), error => {
      const diagnostic = garminDiagnostic(error);
      assert.deepEqual(diagnostic, { stage: "token", ...(status ? { upstreamStatus: status } : {}), technicalCode: code });
      assert.ok(!JSON.stringify(error).includes("private-key"));
      return true;
    });
  }
  assert.deepEqual(garminDiagnostic({ diagnostic: { stage: "private-key", technicalCode: "secret", upstreamStatus: "secret", body: "secret" } }), { stage: "internal", technicalCode: "INTERNAL_ERROR" });
});


test("Garmin token request accepts JSON objects, JSON strings and plain tokens without restricting Accept", async t => {
  const state = setup(t, 106);
  let body;
  let contentType;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url.includes("personalapitoken-service")) {
      assert.equal(options.headers.Accept, "*/*");
      return new Response(body, { headers: { "Content-Type": contentType } });
    }
    assert.equal(options.headers.Accept, "application/json");
    assert.equal(options.headers.Authorization, "Bearer example-token");
    return json([]);
  });
  for (const value of [
    [JSON.stringify({ access_token: "example-token" }), "application/json"],
    [JSON.stringify("example-token"), "application/json"],
    ["  example-token\n", "text/plain; charset=UTF-8"],
    ["example-token", "application/jwt"]
  ]) {
    [body, contentType] = value;
    state.envelope = encryptGarminKey(106, "private-key");
    assert.deepEqual(await Service.activities(106), []);
  }
});

test("Garmin rejects HTML, malformed JSON and multiline text instead of treating them as tokens", async t => {
  setup(t, 107);
  let body = "<html>Login</html>";
  let contentType = "text/html";
  t.mock.method(globalThis, "fetch", async () => new Response(body, { headers: { "Content-Type": contentType } }));
  for (const value of [["<html>Login</html>", "text/html"], ["bad token", "text/plain"], ["token\nother", "text/plain"], ["{bad}", "application/json"]]) {
    [body, contentType] = value;
    await assert.rejects(Service.activities(107), { code: "garmin_invalid_response" });
  }
});

test("Garmin pagination forwards offsets and rejects invalid pages", async t => {
  setup(t, 108);
  const offsets = [];
  t.mock.method(globalThis, "fetch", async url => {
    if (url.includes("personalapitoken-service")) return json({ access_token: "page-token", expires_in: 86400 });
    const params = new URL(url).searchParams;
    offsets.push(params.get("start"));
    assert.equal(params.get("limit"), "20");
    return json([]);
  });
  await Service.activities(108, "20");
  await Service.activities(108, 40);
  assert.deepEqual(offsets, ["20", "40"]);
  for (const offset of [-1, "1.5", "20&limit=999", ["20", "40"], ["20"], {}, Number.MAX_SAFE_INTEGER, ""]) {
    await assert.rejects(Service.activities(108, offset), { code: "garmin_invalid_page", statusCode: 400 });
  }
});
