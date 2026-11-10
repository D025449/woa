import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import express from "express";
import Service, { parsePublicAnalyticsQuery, buildPublicAnalytics, PUBLIC_ANALYTICS_LIMITS } from "../src/services/publicAnalyticsApiService.js";
import ApiKeyService, { normalizeApiKeyScopes, API_KEY_SCOPES } from "../src/services/apiKeyService.js";
import apiKeyAuth from "../src/middleware/apiKeyAuth.js";
import { createPublicAnalyticsApiRouter } from "../src/routes/publicAnalyticsApiRoutes.js";
import { createPublicWorkoutApiRouter } from "../src/routes/publicWorkoutApiRoutes.js";

const now = Date.parse("2026-11-10T12:00:00Z");
const range = { from: "2026-11-09", to: "2026-11-11" };
const ftp = [{ period: 2026, ftp: 250 }];
const manual = (start, tss = 100) => ({ entity_type: "manual_activity", activity_type: "cycling", workout_type: "indoor",
  start_time: start, total_timer_time: 3600, avg_normalized_power: 200, tss_source: "manual", estimated_tss: tss });
const workout = (start, power = 200) => ({ entity_type: "workout", workout_type: "road", start_time: start,
  total_timer_time: 3600, avg_normalized_power: power });

test("analytics dates use actual calendar windows, exclusive end, UTC defaults and bounded scalar input", () => {
  assert.deepEqual(parsePublicAnalyticsQuery(new URLSearchParams(), now), { from: "2026-10-14", to: "2026-11-11" });
  assert.deepEqual(parsePublicAnalyticsQuery(new URLSearchParams("to=2026-10-01"), now), { from: "2026-09-03", to: "2026-10-01" });
  assert.deepEqual(parsePublicAnalyticsQuery(new URLSearchParams("from=2024-02-29&to=2024-03-01"), now),
    { from: "2024-02-29", to: "2024-03-01" });
  for (const query of ["from=2026-02-29", "from=2026-02-31", "from=0000-01-01", "from=2026-11-09T00:00:00Z",
    "from=2026-11-09&from=2026-11-10", "from[]=2026-11-09", "time_zone=Europe/Berlin", "userId=9", "type=indoor",
    "to=2026-11-12", "from=2026-11-11&to=2026-11-11", "from=", "limit=10"]) {
    assert.throws(() => parsePublicAnalyticsQuery(new URLSearchParams(query), now), { statusCode: 400 }, query);
  }
  assert.deepEqual(parsePublicAnalyticsQuery(new URLSearchParams('from=2024-01-01&to=2026-01-01'), now),
    { from: '2024-01-01', to: '2026-01-01' });
});

test("analytics combines recorded/manual cycling with other manual volume and identifies estimates/missing data", () => {
  const rows = [workout("2026-11-09T10:00:00Z"), manual("2026-11-09T11:00:00Z", 80),
    { ...manual("2026-11-09T12:00:00Z"), tss_source: "power_model", estimated_tss: 999 },
    { entity_type: "manual_activity", activity_type: "strength_training", start_time: "2026-11-09T13:00:00Z", total_timer_time: 1800 },
    workout("2026-11-10T08:00:00Z", null), { ...workout("2026-11-10T09:00:00Z"), workout_type: "motorsport" },
    workout("2026-11-10T23:00:00Z"), workout("2026-11-11T00:00:00Z"), { ...workout(null), total_timer_time: 100 }];
  const result = buildPublicAnalytics(rows, ftp, range, now);
  assert.equal(result.summary.activity_count, 5);
  assert.equal(result.summary.imported_activity_count, 2);
  assert.equal(result.summary.manual_activity_count, 3);
  assert.equal(result.summary.timer_time_seconds, 16200);
  assert.equal(result.summary.recorded_derived_tss, 64);
  assert.equal(result.summary.manual_estimated_tss, 144);
  assert.equal(result.summary.tss, 208);
  assert.equal(result.summary.known_tss_count, 3);
  assert.equal(result.summary.missing_tss_count, 1);
  assert.equal(result.summary.tss_not_applicable_count, 1);
  assert.equal(result.days[1].tss, null);
  assert.equal(result.meta.history_missing_tss_count, 1);
  assert.equal(result.meta.current_day_partial, true);
  assert.equal(result.days[0].current_day_partial, false);
  assert.equal(result.days[1].current_day_partial, true);
  assert.equal(result.summary.ftp_watts, 250);
});

test('multi-year summary and daily load work without an annual cap and keep resource budgets', async () => {
  const service = new Service({ database: databaseFixture(), now: () => now });
  const params = new URLSearchParams({ from: '2024-01-01', to: '2026-01-01' });
  const summary = await service.summary('42', params);
  assert.equal(summary.meta.from, '2024-01-01');
  assert.equal(summary.data.activity_count, 0);
  const daily = await service.trainingLoad('42', params);
  assert.equal(daily.data.length, 731);
  assert.equal(daily.data[0].date, '2024-01-01');
  assert.equal(daily.data.at(-1).date, '2025-12-31');
  const longRange = new URLSearchParams({ from: '1976-01-01', to: '2026-01-01' });
  assert.equal((await service.summary('42', longRange)).data.activity_count, 0);
  await assert.rejects(service.trainingLoad('42', longRange), { statusCode: 422, code: 'analytics_response_too_large' });
  await assert.rejects(service.summary('42', new URLSearchParams({ from: '1900-01-01', to: '2026-01-01' })),
    { statusCode: 422, code: 'analytics_response_too_large' });
});

test("CTL/ATL retain history before from and decay on rest days through the requested end", () => {
  const result = buildPublicAnalytics([manual("2026-11-08T10:00:00Z")], [], range, now);
  assert.equal(result.summary.activity_count, 0);
  assert.equal(result.summary.tss, 0);
  assert.equal(result.meta.history_from, "2026-11-08");
  assert.deepEqual(result.days.map(day => [day.date, day.tss, day.ctl, day.atl, day.tsb]),
    [["2026-11-09", 0, 2, 12, -10], ["2026-11-10", 0, 2, 10, -8]]);
  assert.deepEqual(result.summary.latest_load, { date: "2026-11-10", ctl: 2, atl: 10, tsb: -8 });
  const historical = buildPublicAnalytics([manual("2026-11-08T10:00:00Z")], [],
    { from: "2026-11-07", to: "2026-11-10" }, now);
  assert.equal(historical.days[0].ctl, null);
  assert.equal(historical.days[1].ctl, 2);
  assert.equal(historical.meta.current_day_partial, false);
});

test("empty, unknown and valid zero data remain distinguishable without fabricated FTP or load", () => {
  const empty = buildPublicAnalytics([], [], range, now);
  assert.equal(empty.days.length, 2);
  assert.equal(empty.summary.activity_count, 0);
  assert.equal(empty.summary.tss, 0);
  assert.equal(empty.summary.ftp_watts, null);
  assert.equal(empty.meta.history_from, null);
  assert.ok(empty.days.every(day => day.ctl === null && day.tss === 0));
  const unknown = buildPublicAnalytics([workout("2026-11-09T10:00:00Z")], [], range, now);
  assert.equal(unknown.summary.tss, null);
  assert.equal(unknown.summary.missing_tss_count, 1);
  assert.equal(unknown.summary.latest_load.ctl, null);
  const zero = buildPublicAnalytics([workout("2026-11-09T10:00:00Z", 0)], ftp, range, now);
  assert.equal(zero.days[0].tss, 0);
  assert.equal(zero.days[0].ctl, 0);
  assert.equal(zero.days[0].known_tss_count, 1);
  const missingDuration = buildPublicAnalytics([{ ...workout("2026-11-09T10:00:00Z"), total_timer_time: null }], ftp, range, now);
  assert.equal(missingDuration.summary.timer_time_seconds, null);
  assert.equal(missingDuration.summary.missing_duration_count, 1);
});

test("daily attribution is UTC around midnight and ignores end-bound and future activities", () => {
  const result = buildPublicAnalytics([manual("2026-11-09T00:30:00+01:00", 100),
    manual("2026-11-10T00:30:00+01:00", 50), manual("2026-11-11T00:00:00Z", 60)], [], range, now);
  assert.equal(result.meta.history_from, "2026-11-08");
  assert.equal(result.days[0].tss, 50);
  assert.equal(result.days[1].tss, 0);
  assert.equal(result.summary.activity_count, 1);
});

test("yearly FTP interpolation uses UTC, ignores invalid estimates and never applies a future first year backwards", () => {
  const sample = [workout("2026-11-09T10:00:00Z")];
  assert.equal(buildPublicAnalytics(sample, [{ period: 2027, ftp: 300 }], range, now).summary.tss, null);
  assert.equal(buildPublicAnalytics(sample, [{ period: 2026, ftp: null }, { period: 2025, ftp: 0 }], range, now).summary.ftp_watts, null);
  const result = buildPublicAnalytics(sample, [{ period: 2026, ftp: 300 }, { period: 2025, ftp: 200 }], range, now);
  assert.equal(result.summary.ftp_watts, 300);
  const middle = buildPublicAnalytics([workout("2025-07-02T12:00:00Z")], [{ period: 2025, ftp: 200 }, { period: 2026, ftp: 300 }],
    { from: "2025-07-02", to: "2025-07-03" }, now);
  assert.ok(middle.summary.ftp_watts > 249 && middle.summary.ftp_watts < 251);
  assert.equal(middle.summary.tss, 64);
});

test("analytics fails closed at source/FTP/history/response budgets and nonfinite totals", () => {
  const sample = [manual("2026-11-09T10:00:00Z")];
  for (const limits of [{ rows: 0 }, { ftpRows: 0 }, { historyDays: 1 }, { responseBytes: 1 }]) {
    assert.throws(() => buildPublicAnalytics(sample, ftp, range, now, { ...PUBLIC_ANALYTICS_LIMITS, ...limits }), { statusCode: 422 });
  }
  assert.throws(() => buildPublicAnalytics([{ ...sample[0], estimated_tss: Number.MAX_VALUE },
    { ...sample[0], estimated_tss: Number.MAX_VALUE }], [], range, now), { statusCode: 422 });
  assert.throws(() => buildPublicAnalytics([{ ...manual("2026-11-08T10:00:00Z"), estimated_tss: Number.MAX_VALUE },
    { ...manual("2026-11-08T11:00:00Z"), estimated_tss: Number.MAX_VALUE }], [], range, now), { statusCode: 422 });
});

function databaseFixture(rows = [], ftpRows = ftp, failure = null) {
  const calls = [];
  return { calls, async connect() { return {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes("FROM workouts")) { if (failure) throw failure; return { rows }; }
      if (sql.includes("get_ftp_by_period2")) return { rows: ftpRows };
      return { rows: [] };
    }, release() { calls.push({ sql: "RELEASE" }); }
  }; } };
}

test("analytics queries bind both owners, bound full history and project only scalar inputs in one read snapshot", async () => {
  const db = databaseFixture([manual("2026-11-08T10:00:00Z")]);
  const service = new Service({ database: db, now: () => now });
  const result = await service.summary("9223372036854775807", new URLSearchParams(range));
  assert.equal(result.data.activity_count, 0);
  assert.equal(result.data.latest_load.atl, 10);
  const query = db.calls.find(call => call.sql.includes("FROM workouts"));
  assert.equal((query.sql.match(/WHERE uid = \$1/g) || []).length, 2);
  assert.match(query.sql, /UNION ALL/);
  assert.match(query.sql, /ORDER BY start_time LIMIT \$4/);
  assert.equal(query.params[0], "9223372036854775807");
  assert.equal(query.params[1], "2026-11-11T00:00:00Z");
  assert.equal(query.params[3], PUBLIC_ANALYTICS_LIMITS.rows + 1);
  assert.doesNotMatch(query.sql, /SELECT \*|stream|gps|title|notes|device|email|JOIN/);
  assert.match(db.calls[0].sql, /REPEATABLE READ READ ONLY/);
  assert.match(db.calls[1].sql, /statement_timeout = '5000ms'/);
  assert.deepEqual(db.calls.find(call => call.sql.includes("get_ftp_by_period2")).params,
    ["9223372036854775807", "year", 501]);
  assert.equal(db.calls.at(-2).sql, "COMMIT");
  assert.equal(db.calls.at(-1).sql, "RELEASE");
  const daily = await service.trainingLoad("42", new URLSearchParams(range));
  assert.equal(daily.data.length, 2);
  await assert.rejects(service.summary("01", new URLSearchParams()), { statusCode: 400 });
});

test("query failures and excessive source data roll back and release analytics capacity", async () => {
  for (const db of [databaseFixture([], [], new Error("private failure")),
    databaseFixture(Array(PUBLIC_ANALYTICS_LIMITS.rows + 1).fill({})),
    databaseFixture([], Array(PUBLIC_ANALYTICS_LIMITS.ftpRows + 1).fill({}))]) {
    await assert.rejects(new Service({ database: db, now: () => now }).summary("42", new URLSearchParams()));
    assert.equal(db.calls.at(-2).sql, "ROLLBACK");
    assert.equal(db.calls.at(-1).sql, "RELEASE");
  }
  assert.equal((await new Service({ database: databaseFixture(), now: () => now }).summary("42", new URLSearchParams())).data.activity_count, 0);
});

test("analytics capacity bounds simultaneous database work and recovers after connection failure", async () => {
  const pending = [];
  const service = new Service({ database: { connect: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) }, now: () => now });
  const first = service.summary("42", new URLSearchParams());
  const second = service.trainingLoad("42", new URLSearchParams());
  await assert.rejects(service.summary("43", new URLSearchParams()), { statusCode: 429 });
  for (const entry of pending) entry.reject(new Error("connection unavailable"));
  const settled = await Promise.allSettled([first, second]);
  assert.ok(settled.every(result => result.status === "rejected"));
  await new Service({ database: databaseFixture(), now: () => now }).summary("42", new URLSearchParams());
});

test("analytics-only scopes are valid, prerequisite combinations are exhaustive and mixed auth retains analytics", async () => {
  for (let mask = 0; mask < 16; mask += 1) {
    const scopes = API_KEY_SCOPES.filter((scope, index) => mask & (1 << index));
    const valid = scopes.length > 0 && (!scopes.includes("workouts:gps:read") || scopes.includes("workouts:read"))
      && (!scopes.includes("workouts:fit:read") || scopes.includes("workouts:gps:read"));
    if (valid) assert.deepEqual(normalizeApiKeyScopes([...scopes].reverse()), scopes);
    else assert.throws(() => normalizeApiKeyScopes(scopes), { statusCode: 400 });
  }
  assert.throws(() => normalizeApiKeyScopes(["analytics:read", "analytics:read"]), { statusCode: 400 });
  const sql = fs.readFileSync(new URL("../src/migrations/098_user_api_keys_analytics_scope.sql", import.meta.url), "utf8");
  assert.match(sql, /analytics:read/); assert.match(sql, /cardinality[(]scopes[)] >= 1/);
  assert.doesNotMatch(sql, /UPDATE user_api_keys|INSERT|DELETE|ALTER TABLE workouts/);
  const original = ApiKeyService.resolve;
  try {
    ApiKeyService.resolve = async () => ({ userId: "42", keyId: "9", scopes: API_KEY_SCOPES.filter(scope => scope !== "analytics:read") });
    const res = { set() {}, status(code) { this.code = code; return this; }, json() {} };
    let passed = false;
    await apiKeyAuth(["workouts:fit:read", "analytics:read"])({ get: () => "Bearer fixture" }, res, () => { passed = true; });
    assert.equal(passed, false); assert.equal(res.code, 403);
  } finally { ApiKeyService.resolve = original; }
});

async function serve(context, app) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  context.after(() => new Promise(resolve => server.close(resolve)));
  return "http://127.0.0.1:" + server.address().port;
}

test("public analytics HTTP isolates Bearer identity/scopes, shared buckets and safe errors before browser sessions", async context => {
  const original = ApiKeyService.resolve;
  context.after(() => { ApiKeyService.resolve = original; });
  ApiKeyService.resolve = async secret => {
    if (secret === "outage") throw new Error("private credential database");
    if (secret === "expired") throw Object.assign(new Error("expired"), { statusCode: 401 });
    return { userId: "42", keyId: "9", scopes: secret === "analytics" ? ["analytics:read"] : ["workouts:read"] };
  };
  const buckets = [], calls = [];
  let failure;
  const service = { async summary(owner, params) {
    calls.push({ owner, params: Object.fromEntries(params) });
    if (failure) throw failure;
    return new Service({ database: databaseFixture(), now: () => now }).summary(owner, params);
  }, async trainingLoad(owner, params) {
    calls.push({ owner, params: Object.fromEntries(params) });
    if (failure) throw failure;
    return new Service({ database: databaseFixture(), now: () => now }).trainingLoad(owner, params);
  } };
  const limiter = (bucket, limit, identity) => (req, res, next) => { buckets.push([bucket, limit, identity(req)]); next(); };
  const app = express();
  app.use((req, res, next) => { req.user = { id: 99 }; next(); });
  app.use("/api/v1/analytics", createPublicAnalyticsApiRouter({ service, rateLimit: limiter }));
  app.use("/api/v1", createPublicWorkoutApiRouter({ rateLimit: limiter }));
  let browserCalls = 0;
  app.use((req, res) => { browserCalls += 1; res.redirect("/login"); });
  const base = await serve(context, app);
  const get = (path, key = "analytics", options = {}) => fetch(base + "/api/v1" + path,
    { headers: key ? { Authorization: "Bearer " + key } : { Cookie: "session=browser" }, redirect: "manual", ...options });
  const missing = await get("/analytics/summary", null);
  assert.equal(missing.status, 401); assert.match(missing.headers.get("www-authenticate"), /Bearer/);
  buckets.length = 0;
  assert.equal((await get("/analytics/summary", "read")).status, 403);
  assert.deepEqual(buckets.map(bucket => bucket[0]), ["ingress"]);
  buckets.length = 0;
  const success = await get("/analytics/summary?from=2026-11-09&to=2026-11-11");
  assert.equal(success.status, 200); assert.equal(success.headers.get("cache-control"), "no-store");
  assert.equal(success.headers.get("referrer-policy"), "no-referrer");
  assert.equal(success.headers.get("x-content-type-options"), "nosniff");
  assert.equal((await success.json()).data.activity_count, 0);
  assert.equal(calls.at(-1).owner, "42");
  assert.deepEqual(buckets.map(bucket => bucket.slice(0, 2)), [["ingress", 480], ["user", 240], ["analytics", 40]]);
  assert.ok(buckets.slice(1).every(bucket => bucket[2] === "42"));
  const daily = await get("/analytics/training-load");
  assert.equal(daily.status, 200);
  assert.equal((await daily.json()).data.length, 28);
  assert.equal((await get("/workouts")).status, 403);
  for (const query of ["userId=99", "from=2026-02-31", "from=2026-11-09&from=2026-11-10", "time_zone=UTC"]) {
    assert.equal((await get("/analytics/summary?" + query)).status, 400);
  }
  assert.equal((await get("/analytics/not-implemented")).status, 404);
  assert.equal((await get("/analytics/summary", "analytics", { method: "POST" })).status, 405);
  assert.equal((await get("/analytics/summary", "analytics", { method: "HEAD" })).status, 405);
  assert.equal((await get("/analytics/summary", "expired")).status, 401);
  assert.equal((await get("/analytics/summary", "outage")).status, 503);
  for (const [status, code] of [[422, "analytics_response_too_large"], [429, "rate_limited"], [503, "private_sql_error"]]) {
    failure = Object.assign(new Error("private SQL, token, GPS"), { code });
    const response = await get("/analytics/summary");
    assert.equal(response.status, status);
    if (status === 429) assert.equal(response.headers.get("retry-after"), "1");
    const text = await response.text(); assert.ok(!text.includes("private"));
    assert.ok(JSON.parse(text).error.request_id);
    assert.equal(JSON.parse(text).error.request_id, response.headers.get('x-request-id'));
  }
  assert.equal(browserCalls, 0);
});

test("analytics response fields match the OpenAPI schema and reveal no source identity or raw data", () => {
  const contract = JSON.parse(fs.readFileSync(new URL("../docs/public-api-v1.openapi.json", import.meta.url), "utf8"));
  const result = buildPublicAnalytics([{ ...manual("2026-11-09T10:00:00Z"), uid: 99, id: "7", notes: "private", gps: "private" }], ftp, range, now);
  for (const [value, name] of [[result.meta, "AnalyticsMeta"], [result.summary, "AnalyticsSummary"], [result.days[0], "AnalyticsDay"]]) {
    assert.deepEqual(Object.keys(value).sort(), contract.components.schemas[name].required.toSorted());
  }
  assert.ok(!JSON.stringify(result).includes("private"));
  for (const name of ["summary", "training-load"]) assert.deepEqual(contract.paths["/analytics/" + name].get["x-required-scopes"], ["analytics:read"]);
  const app = fs.readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
  assert.ok(app.indexOf('app.use("/api/v1/analytics"') < app.indexOf('app.use("/api/v1", publicWorkoutApiRoutes)'));
});

test("analytics HTTP enforces HTTPS and response budgets with the documented JSON error envelope", async context => {
  const original = ApiKeyService.resolve;
  context.after(() => { ApiKeyService.resolve = original; });
  ApiKeyService.resolve = async () => ({ userId: "42", keyId: "9", scopes: ["analytics:read"] });
  const app = express();
  const rateLimit = () => (req, res, next) => next();
  app.use("/secure", createPublicAnalyticsApiRouter({ httpsOnly: true, rateLimit }));
  app.use("/large", createPublicAnalyticsApiRouter({ rateLimit, service: { summary: async () => ({ data: "x".repeat(PUBLIC_ANALYTICS_LIMITS.responseBytes) }) } }));
  const base = await serve(context, app);
  const secure = await fetch(base + "/secure/summary", { headers: { Authorization: "Bearer fixture" } });
  assert.equal(secure.status, 400);
  assert.equal((await secure.json()).error.code, "invalid_request");
  const large = await fetch(base + "/large/summary", { headers: { Authorization: "Bearer fixture" } });
  assert.equal(large.status, 422);
  assert.match(large.headers.get("content-type"), /application.json/);
  assert.equal(large.headers.get("cache-control"), "no-store");
  assert.equal((await large.json()).error.code, "analytics_response_too_large");
});
