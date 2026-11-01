import express from "express";
import routes from "../src/routes/wahooImportRoutes.js";
import test from "node:test";
import assert from "node:assert/strict";
import Connection from "../src/services/wahooConnectionService.js";
import Service, { validateWahooFileUrl } from "../src/services/wahooImportService.js";

test("Wahoo list forwards user and pagination, normalizes metadata without leaking upstream fields", async t => {
  const calls = [];
  t.mock.method(Connection, "apiRequest", async (...args) => {
    calls.push(args);
    return { workouts: [{ id: 123, name: "Ride", starts: "2026-11-01T12:00:00Z", minutes: 60, workout_token: "private" }] };
  });
  assert.deepEqual(await Service.activities(42, 20), [{ id: "123", name: "Ride", startTime: "2026-11-01T12:00:00Z", duration: 3600, sport: "" }]);
  assert.deepEqual(calls, [[42, "/v1/workouts?page=2&per_page=20"]]);
  for (const value of [-1, 1, "20&x=1", [20], {}, "", Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(Service.activities(42, value), { statusCode: 400 });
  }
  assert.equal(calls.length, 1);
});

test("Wahoo download retrieves user-owned summary, validates CDN and FIT, never sends credentials to CDN", async t => {
  let fileUrl = "https://cdn.wahooligan.com/file.fit?signature=private";
  t.mock.method(Connection, "apiRequest", async (user, path) => {
    assert.equal(user, 42);
    assert.equal(path, "/v1/workouts/123/workout_summary");
    return { file: { url: fileUrl } };
  });
  const fit = Buffer.alloc(14); fit[0] = 14; fit.write(".FIT", 8);
  let body = fit;
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests++;
    assert.equal(url, fileUrl);
    assert.equal(options.headers, undefined);
    assert.equal(options.redirect, "error");
    return new Response(body);
  });
  assert.deepEqual(await Service.file(42, "123"), fit);
  body = Buffer.from("<html>Login</html>");
  await assert.rejects(Service.file(42, "123"), { code: "wahoo_file_unavailable" });
  for (const url of ["http://cdn.wahooligan.com/file.fit", "https://127.0.0.1/file.fit", "https://cdn.wahooligan.com.evil.test/file.fit", "https://user:pass@cdn.wahooligan.com/file.fit", "https://cdn.wahooligan.com:444/file.fit"]) {
    fileUrl = url;
    await assert.rejects(Service.file(42, "123"));
    assert.throws(() => validateWahooFileUrl(url));
  }
  assert.equal(requests, 2);
  await assert.rejects(Service.file(42, "../user"), { statusCode: 400 });
});

test("Wahoo missing summary file and malformed lists fail safely", async t => {
  t.mock.method(Connection, "apiRequest", async () => ({}));
  t.mock.method(globalThis, "fetch", async () => assert.fail("No CDN call without a file"));
  await assert.rejects(Service.file(42, "123"), { code: "wahoo_file_unavailable" });
  await assert.rejects(Service.activities(42), { code: "wahoo_unavailable" });
});

test("Wahoo routes isolate users, block inactive accounts and send FIT with no cache", async t => {
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
  app.use("/api/wahoo", routes);
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/wahoo`;
  assert.equal((await fetch(`${base}/activities`)).status, 401);
  assert.equal((await fetch(`${base}/activities/123/file`)).status, 401);
  assert.equal((await fetch(`${base}/activities`, { headers: { "x-test-user": "42", "x-test-status": "pending_deletion" } })).status, 423);
  assert.equal(calls.length, 0);
  const response = await fetch(`${base}/activities/123/file?userId=99`, { headers: { "x-test-user": "42" } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-disposition"), /123.fit/);
  assert.equal((await response.arrayBuffer()).byteLength, 4);
  assert.deepEqual(calls.at(-1), ["42", "123"]);
  activityFailure = Object.assign(new Error("private-key"), { statusCode: 502, code: "wahoo_unavailable",
    diagnostic: { stage: "token", upstreamStatus: 400, technicalCode: "HTTP_ERROR", body: "private-key" } });
  const failed = await fetch(`${base}/activities`, { headers: { "x-test-user": "42" } });
  const body = await failed.json();
  assert.equal(failed.status, 502);
  assert.deepEqual(body, { error: "Wahoo request failed", code: "wahoo_unavailable" });
  assert.ok(!JSON.stringify(body).includes("private-key"));
});
