import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import express from "express";
import ApiKeyService from "../src/services/apiKeyService.js";
import Service, { PUBLIC_ANALYTICS_LIMITS } from "../src/services/publicAnalyticsApiService.js";
import { createPublicAnalyticsApiRouter } from "../src/routes/publicAnalyticsApiRoutes.js";
import { parsePerformanceOptions, selectPublicPowerEfforts, buildPublicPowerProfile, buildPublicFtpHistory, ftpPeriod } from "../src/services/publicAnalyticsPowerService.js";

const now = Date.parse("2026-11-10T12:00:00Z"), range = { from: "2026-11-01", to: "2026-11-11" };
const effort = (id = "1", duration = 480, power = 300, time = "2026-11-05T10:00:00Z") => ({ workout_id: id, segment_id: id,
  duration, avg_power: power, start_time: time, start_offset: 0, end_offset: duration });

test('multi-year performance ranges keep all buckets and fail before oversized allocation', async () => {
  const ranges = { from: '2024-01-01', to: '2026-01-01' };
  const rows = [effort('1', 480, 300, '2024-07-01T00:00:00Z'), effort('2', 900, 280, '2024-07-01T00:00:00Z')];
  const db = { connect: async () => ({ query: async sql => ({ rows: sql.includes('FROM workouts') ? rows : [] }), release() {} }) };
  const service = new Service({ database: db, now: () => now });
  const power = await service.powerProfile('42', new URLSearchParams({ ...ranges, durations: '480' }));
  assert.equal(power.data[0].power_watts, 300);
  const ftp = await service.ftpHistory('42', new URLSearchParams({ ...ranges, grouping: 'year' }));
  assert.equal(ftp.data.length, 2);
  const weeks = await service.ftpHistory('42', new URLSearchParams({ ...ranges, grouping: 'week' }));
  assert.equal(weeks.data.length, 105);
  const schema = JSON.parse(fs.readFileSync(new URL('../docs/public-api-v1.openapi.json', import.meta.url), 'utf8'));
  assert.equal(schema.paths['/analytics/ftp-history'].get.responses['200'].content['application/json'].schema.properties.data.maxItems, undefined);
  assert.ok(ftp.data[0].ftp_watts > 0);
  assert.equal(ftp.data[1].ftp_watts, null);
  const exact = Buffer.byteLength(JSON.stringify(ftp));
  assert.deepEqual(buildPublicFtpHistory(rows, ranges, 'year', now, { ...PUBLIC_ANALYTICS_LIMITS, responseBytes: exact }), ftp);
  assert.throws(() => buildPublicFtpHistory(rows, ranges, 'year', now, { ...PUBLIC_ANALYTICS_LIMITS, responseBytes: exact - 1 }), { statusCode: 422 });
  assert.throws(() => buildPublicFtpHistory([], { from: '0001-01-01', to: '2026-01-01' }, 'week', now),
    { code: 'analytics_response_too_large' });
});

test("performance options strictly validate allowlisted distinct durations and FTP grouping", () => {
  assert.deepEqual(parsePerformanceOptions(new URLSearchParams("durations=1200,5,60"), "power-profile").durations, [5, 60, 1200]);
  assert.equal(parsePerformanceOptions(new URLSearchParams(), "ftp-history").grouping, "month");
  for (const query of ["durations=", "durations=5,5", "durations=05", "durations=5, 60", "durations=7", "durations=5&durations=60",
    "grouping=month", "owner=99", "durations[]=5"]) {
    assert.throws(() => parsePerformanceOptions(new URLSearchParams(query), "power-profile"), { statusCode: 400 });
  }
  assert.throws(() => parsePerformanceOptions(new URLSearchParams("grouping=day"), "ftp-history"), { statusCode: 400 });
  assert.throws(() => parsePerformanceOptions(new URLSearchParams("durations=480"), "ftp-history"), { statusCode: 400 });
});

test("power winners preserve exact BIGINT ties, microseconds, UTC bounds and missing versus zero", () => {
  const rows = [effort("9007199254740992"), effort("9007199254740993"), effort("7", 60, 0),
    effort("8", 480, 999, "2026-10-31T22:00:00Z"), effort("9", 480, 999, "2026-11-10T13:00:00Z"),
    { ...effort("5", 1200, 500), start_offset: -1 }, effort("10", 480, null)];
  const winners = selectPublicPowerEfforts(rows, range, [60, 480, 1200], now);
  assert.equal(winners.get(480).workout_id, "9007199254740993");
  const data = buildPublicPowerProfile(winners, [{ date: "2026-11-05", weight_kg: 75, source: "history" }], range, [60, 480, 1200], now).data;
  assert.equal(data[0].power_watts, 0); assert.equal(data[0].watts_per_kg, 0);
  assert.equal(data[1].power_watts, 300); assert.equal(data[1].watts_per_kg, 4);
  assert.equal(data[1].weight_source, "history"); assert.equal(data[2].power_watts, null); assert.equal(data[2].workout_id, null);
  const micro = selectPublicPowerEfforts([{ ...effort("99"), sort_start: "2026-11-05T10:00:00.123455Z" },
    { ...effort("1"), sort_start: "2026-11-05T10:00:00.123456Z" }], range, [480], now);
  assert.equal(micro.get(480).workout_id, "1");
});

test("power weight provenance stays nullable and uses the source date and displayed power", () => {
  const winners = selectPublicPowerEfforts([effort("1", 480, 300.5)], range, [480], now);
  const missing = buildPublicPowerProfile(winners, [], range, [480], now).data[0];
  assert.equal(missing.weight_kg, null); assert.equal(missing.watts_per_kg, null); assert.equal(missing.weight_date, "2026-11-05");
  const known = buildPublicPowerProfile(winners, [{ date: "2026-11-05", weight_kg: 75, source: "profile" }], range, [480], now).data[0];
  assert.equal(known.watts_per_kg, 4.007); assert.equal(known.weight_source, "profile");
  for (const weight of [0, -1, 501, Infinity]) assert.equal(buildPublicPowerProfile(winners,
    [{ date: "2026-11-05", weight_kg: weight, source: "history" }], range, [480], now).data[0].watts_per_kg, null);
});

test("FTP period percentiles match the CP8/CP15 formula and count missing anchors without fabricating zero", () => {
  const rows = [effort("1", 480, 300), effort("2", 480, 320), effort("1", 900, 280), effort("2", 900, 290),
    effort("3", 480, 999, "2026-10-31T22:00:00Z"), effort("4", 900, 999, "2026-11-11T00:00:00Z")];
  const response = buildPublicFtpHistory(rows, range, "month", now), point = response.data[0];
  assert.equal(point.cp8_watts, 319); assert.equal(point.cp15_watts, 289.5); assert.equal(point.confidence, 2);
  const expected = (319 + (Math.log(1200) - Math.log(480)) / (Math.log(900) - Math.log(480)) * (289.5 - 319)) * 0.95;
  assert.ok(Math.abs(point.ftp_watts - expected) < 0.001);
  assert.equal(point.partial_period, true); assert.equal(response.meta.ftp_method, "period_cp8_cp15_p95");
  const missing = buildPublicFtpHistory([effort()], range, "month", now).data[0];
  assert.equal(missing.cp8_watts, 300); assert.equal(missing.cp15_watts, null); assert.equal(missing.ftp_watts, null);
  const empty = buildPublicFtpHistory([], { from: "2026-08-01", to: "2026-11-01" }, "month", now);
  assert.equal(empty.data.length, 3); assert.ok(empty.data.every(row => row.ftp_watts === null && row.confidence === 0 && !row.partial_period));
});

test("FTP calendar grouping handles ISO Monday, year/quarter boundaries and early years in UTC", () => {
  const week = ftpPeriod(Date.parse("2026-01-01T12:00:00Z"), "week");
  assert.equal(new Date(week.start).toISOString().slice(0, 10), "2025-12-29");
  assert.equal(new Date(week.end).toISOString().slice(0, 10), "2026-01-05");
  const quarter = buildPublicFtpHistory([], { from: "2025-12-31", to: "2026-01-02" }, "quarter", now);
  assert.deepEqual(quarter.data.map(row => row.period_from), ["2025-10-01", "2026-01-01"]);
  assert.equal(new Date(ftpPeriod(Date.parse("0001-03-01T00:00:00Z"), "year").start).toISOString().slice(0, 10), "0001-01-01");
});

function fixture(rows = [], weights = []) {
  const calls = [];
  return { calls, async connect() { return { async query(sql, params) {
    calls.push({ sql, params });
    if (sql.includes("JOIN workout_segments")) return { rows };
    if (sql.includes("unnest")) return { rows: weights };
    return { rows: [] };
  }, release() { calls.push({ sql: "RELEASE" }); } }; } };
}

test("performance SQL binds both owners, stored critical cycling only, calendar bounds and bounded history weights", async () => {
  const db = fixture([effort()], [{ date: "2026-11-05", weight_kg: 75, source: "history" }]);
  const service = new Service({ database: db, now: () => now });
  const response = await service.powerProfile("42", new URLSearchParams({ ...range, durations: "480,1200" }));
  assert.equal(response.data[0].watts_per_kg, 4);
  const query = db.calls.find(call => call.sql.includes("JOIN workout_segments"));
  assert.match(query.sql, /s.uid = [$]1/); assert.match(query.sql, /WHERE w.uid = [$]1/); assert.match(query.sql, /segmenttype = 'crit'/);
  assert.match(query.sql, /SS.US/); assert.match(query.sql, /LIMIT [$]6/);
  assert.deepEqual(query.params, ["42", "2026-11-01T00:00:00Z", "2026-11-11T00:00:00Z", new Date(now).toISOString(), [480, 1200], 50001]);
  assert.doesNotMatch(query.sql, /SELECT [*]|stream|gps|training_activities|notes|email/);
  const weight = db.calls.find(call => call.sql.includes("unnest"));
  assert.deepEqual(weight.params, ["42", ["2026-11-05"]]); assert.match(weight.sql, /valid_from <= d.date/);
  assert.equal(db.calls.at(-2).sql, "COMMIT"); assert.equal(db.calls.at(-1).sql, "RELEASE");
  const ftDb = fixture([effort(), effort("2", 900, 280)]);
  const history = await new Service({ database: ftDb, now: () => now }).ftpHistory("42", new URLSearchParams(range));
  assert.equal(history.data[0].confidence, 1); assert.ok(history.data[0].ftp_watts > 0);
  assert.ok(!ftDb.calls.some(call => call.sql.includes("unnest")));
  assert.deepEqual(ftDb.calls.find(call => call.sql.includes("JOIN workout_segments")).params[4], [480, 900]);
  assert.ok(!JSON.stringify(history).includes("workout_id"));
});

test("performance source limits roll back and release shared capacity without truncating", async () => {
  const db = fixture(Array(PUBLIC_ANALYTICS_LIMITS.rows + 1).fill(effort()));
  await assert.rejects(new Service({ database: db, now: () => now }).powerProfile("42", new URLSearchParams()), { statusCode: 422 });
  assert.equal(db.calls.at(-2).sql, "ROLLBACK"); assert.equal(db.calls.at(-1).sql, "RELEASE");
  const result = await new Service({ database: fixture(), now: () => now }).powerProfile("42", new URLSearchParams());
  assert.ok(result.data.every(row => row.power_watts === null));
});

test("performance HTTP requires both scopes for source IDs, shares the analytics bucket and keeps FTP analytics-only", async context => {
  const original = ApiKeyService.resolve;
  context.after(() => { ApiKeyService.resolve = original; });
  ApiKeyService.resolve = async key => ({ userId: "42", keyId: "9", scopes: key === "both" ? ["analytics:read", "workouts:read"] : ["analytics:read"] });
  const buckets = [];
  const app = express();
  app.use("/api/v1/analytics", createPublicAnalyticsApiRouter({ service: new Service({ database: fixture([effort(), effort("2", 900, 280)]), now: () => now }),
    rateLimit: (bucket, limit) => (req, res, next) => { buckets.push([bucket, limit]); next(); } }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  context.after(() => new Promise(resolve => server.close(resolve)));
  const base = "http://127.0.0.1:" + server.address().port + "/api/v1/analytics";
  const get = (path, key = "both") => fetch(base + path, { headers: { Authorization: "Bearer " + key } });
  const denied = await get("/power-profile", "analytics");
  assert.equal(denied.status, 403); assert.equal((await denied.json()).error.code, "insufficient_scope");
  assert.ok(!buckets.some(bucket => bucket[0] === "analytics")); buckets.length = 0;
  const power = await get("/power-profile?from=2026-11-01&to=2026-11-11&durations=480");
  assert.equal(power.status, 200); assert.equal((await power.json()).data[0].workout_id, "1");
  assert.deepEqual(buckets, [["ingress", 480], ["user", 240], ["analytics", 40]]);
  const history = await get("/ftp-history?from=2026-11-01&to=2026-11-11&grouping=month", "analytics");
  assert.equal(history.status, 200); assert.ok((await history.json()).data[0].ftp_watts > 0);
  assert.equal((await get("/power-profile?durations=5,5")).status, 400);
  assert.equal((await get("/ftp-history?grouping=day")).status, 400);
});

test("performance schemas match exact response fields and required scopes", () => {
  const contract = JSON.parse(fs.readFileSync(new URL("../docs/public-api-v1.openapi.json", import.meta.url), "utf8"));
  const profile = buildPublicPowerProfile(selectPublicPowerEfforts([effort()], range, [480], now), [], range, [480], now);
  const ftp = buildPublicFtpHistory([], range, "month", now);
  for (const [value, schema] of [[profile.meta, "PowerProfileMeta"], [profile.data[0], "PowerProfilePoint"], [ftp.meta, "FtpHistoryMeta"], [ftp.data[0], "FtpHistoryPoint"]]) {
    assert.deepEqual(Object.keys(value).sort(), contract.components.schemas[schema].required.toSorted());
  }
  assert.deepEqual(contract.paths["/analytics/power-profile"].get["x-required-scopes"], ["analytics:read", "workouts:read"]);
  assert.deepEqual(contract.paths["/analytics/ftp-history"].get["x-required-scopes"], ["analytics:read"]);
});
