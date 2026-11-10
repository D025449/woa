import test from "node:test";
import assert from "node:assert/strict";
import Service, { parsePublicWorkoutQuery, projectPublicWorkout, runPublicGpsWorker } from "../src/services/publicWorkoutApiService.js";
import GpsTrackBlobService from "../src/services/gpsTrackBlobService.js";
import { decodePublicGps, PUBLIC_GPS_LIMITS } from "../src/services/publicApiGpsService.js";
import { gzipSync, brotliCompressSync } from "node:zlib";
import { buildGpsTrackBlock } from "../src/public/js/woa-format-compact.js";
import express from "express";
import ApiKeyService from "../src/services/apiKeyService.js";
import { createPublicWorkoutApiRouter } from "../src/routes/publicWorkoutApiRoutes.js";
import publicApiRateLimit from "../src/middleware/publicApiRateLimit.js";
import fs from "node:fs";

const contract = JSON.parse(fs.readFileSync(new URL("../docs/public-api-v1.openapi.json", import.meta.url), "utf8"));

test("OpenAPI describes the public workout and analytics paths and resolves all local references", () => {
  assert.equal(contract.info.version, '1.5.0');
  assert.deepEqual(contract['x-rate-limits'], { window_seconds: 60, ingress_per_ip: 480,
    authenticated_per_user: 240, gps_per_user: 40, fit_per_user: 40, analytics_per_user: 40 });
  assert.deepEqual(Object.keys(contract.paths).sort(), ["/analytics/ftp-history", "/analytics/power-profile", "/analytics/summary", "/analytics/training-load",
    "/workouts", "/workouts/{id}", "/workouts/{id}/export.fit", "/workouts/{id}/gps"]);
  const visit = value => {
    if (!value || typeof value !== "object") return;
    if (value.$ref) {
      assert.ok(value.$ref.startsWith("#/"));
      assert.ok(value.$ref.slice(2).split("/").reduce((target, key) => target?.[key], contract), value.$ref);
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(contract);
  for (const [name, path] of Object.entries(contract.paths)) {
    assert.deepEqual(path.get.security || contract.security, [{ PersonalApiKey: [] }]);
    assert.ok(path.get["x-required-scopes"].includes(name.startsWith("/analytics/") ? "analytics:read" : "workouts:read"));
  }
});

test("public workout projection preserves missing versus zero metrics and exposes exactly the contracted fields", () => {
  const row = { id: "9223372036854775807", start_time: "2026-11-09T10:00:00+01:00", workout_type: "road",
    avg_normalized_power: 200, total_timer_time: 3600, total_distance: "0", intensity_tags: 3,
    validgps: true, gps_source: "recorded", samplerategps: 5, uid: 99, email: "private", gps_bounds: "private",
    gps_track_blob: Buffer.from("private"), device_id: "private", processing_error: "private" };
  const projected = projectPublicWorkout(row, 250);
  assert.equal(Object.keys(projected).length, 34);
  assert.deepEqual(Object.keys(projected).sort(), contract.components.schemas.Workout.required.toSorted());
  assert.equal(projected.id, row.id);
  assert.equal(projected.start_time, "2026-11-09T09:00:00.000Z");
  assert.equal(projected.distance_meters, 0);
  assert.equal(projected.avg_power_watts, null);
  assert.equal(projected.intensity_factor, 0.8);
  assert.equal(projected.tss, 64);
  assert.equal(projected.ftp_used_watts, 250);
  assert.deepEqual(projected.intensity_tags, ["recovery", "endurance"]);
  assert.ok(!JSON.stringify(projected).includes("private"));
  assert.equal(projectPublicWorkout({ ...row, avg_normalized_power: 0 }, 250).tss, 0);
  assert.equal(projectPublicWorkout({ ...row, total_timer_time: 0 }, 250).tss, 0);
  assert.equal(projectPublicWorkout({ ...row, avg_normalized_power: null }, 250).tss, null);
  assert.equal(projectPublicWorkout(row).intensity_factor, null);
  assert.equal(projectPublicWorkout({ ...row, workout_type: "motorsport" }, 250).tss, null);
  assert.equal(projectPublicWorkout({ ...row, avg_normalized_power: Infinity }, 250).normalized_power_watts, null);
});

test("public API validates bounded scalar filters, duplicates, calendar dates and microsecond ranges", () => {
  assert.deepEqual(parsePublicWorkoutQuery(new URLSearchParams()), { limit: 50, cursor: null,
    filters: { from: null, to: null, type: null } });
  for (const query of ["userId=99", "limit=0", "limit=101", "limit=1&limit=2", "type=cycling", "type[]=road",
    "cursor=", "from=2026-02-31T00:00:00Z", "from=2026-01-01", "from=2026-01-01T24:00:00Z",
    "from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z"]) {
    assert.throws(() => parsePublicWorkoutQuery(new URLSearchParams(query)), { statusCode: 400 }, query);
  }
  const parsed = parsePublicWorkoutQuery(new URLSearchParams({ from: "2026-11-09T10:00:00.123456+01:00",
    to: "2026-11-09T09:00:00.123457Z", limit: "100", type: "road" }));
  assert.equal(parsed.filters.from, "2026-11-09T09:00:00.123456Z");
  assert.equal(parsed.filters.to, "2026-11-09T09:00:00.123457Z");
});

function databaseFixture(rows = []) {
  const calls = [];
  const client = { async query(sql, params) {
    calls.push({ sql, params });
    if (sql.includes("get_ftp_by_period2")) return { rows: [{ period: 2026, ftp: 250 }] };
    if (sql.includes("FROM workouts")) return { rows };
    return { rows: [] };
  }, release() { calls.push({ sql: "RELEASE" }); } };
  return { calls, async connect() { return client; } };
}

test("public list uses owned imported-workout columns and encrypted, user/filter-bound microsecond pagination", async () => {
  const database = databaseFixture([{ id: "9", start_time: new Date("2026-11-09T09:00:00.123Z"),
    cursor_start: "2026-11-09T09:00:00.123456Z", workout_type: "road", avg_normalized_power: 200, total_timer_time: 3600 },
  { id: "8" }]);
  const service = new Service({ database, cursorSecret: "test-only-stable-secret" });
  const result = await service.list("42", new URLSearchParams("limit=1&type=road"));
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0].tss, 64);
  assert.ok(result.next_cursor);
  assert.ok(!Buffer.from(result.next_cursor, "base64url").toString().includes("2026-11-09"));
  const query = database.calls.find(call => call.sql.includes("FROM workouts"));
  assert.deepEqual(query.params, ["42", "road", 2]);
  assert.match(query.sql, /WHERE uid = \$1/);
  assert.match(query.sql, /start_time DESC NULLS LAST, id DESC/);
  assert.match(query.sql, /SS.US/);
  assert.match(query.sql, /uploaded_at AT TIME ZONE 'UTC'/);
  assert.doesNotMatch(query.sql, /SELECT \*|gps_track_blob|stream|gps_bounds|email|JOIN/);
  assert.equal(database.calls[0].sql, "BEGIN READ ONLY");
  assert.equal(database.calls.at(-2).sql, "COMMIT");
  const filters = { from: null, to: null, type: "road" };
  assert.equal(service.decodeCursor(result.next_cursor, "42", filters).start, "2026-11-09T09:00:00.123456Z");
  assert.throws(() => service.decodeCursor(result.next_cursor, "99", filters), { statusCode: 400 });
  assert.throws(() => service.decodeCursor(result.next_cursor, "42", { ...filters, type: "indoor" }), { statusCode: 400 });
  assert.throws(() => service.decodeCursor(`A${result.next_cursor.slice(1)}`, "42", filters), { statusCode: 400 });
  await service.list("42", new URLSearchParams({ limit: "2", type: "road", cursor: result.next_cursor }));
  const nextQuery = database.calls.filter(call => call.sql.includes("FROM workouts")).at(-1);
  assert.ok(nextQuery.params.includes("2026-11-09T09:00:00.123456Z"));
  assert.match(nextQuery.sql, /start_time IS NULL OR \(start_time, id\) </);
});

test("public pagination handles the NULL partition, expiry and malformed IDs without leaking ownership", async () => {
  const database = databaseFixture();
  const service = new Service({ database, cursorSecret: "test-only-stable-secret", now: () => 1000 });
  const filters = { from: null, to: null, type: null };
  const cursor = service.encodeCursor("42", filters, { id: "9223372036854775807", cursor_start: null });
  await service.list("42", new URLSearchParams({ cursor }));
  assert.match(database.calls.find(call => call.sql.includes("FROM workouts")).sql, /start_time IS NULL AND id </);
  const later = new Service({ cursorSecret: "test-only-stable-secret", now: () => 86402000 });
  assert.throws(() => later.decodeCursor(cursor, "42", filters), { statusCode: 400 });
  for (const id of ["0", "01", "-1", "1 OR true", "9223372036854775808"]) {
    await assert.rejects(service.detail("42", id), { statusCode: 400 });
  }
  await assert.rejects(service.detail("42", "7"), { statusCode: 404, code: "workout_not_found" });
  assert.equal(database.calls.at(-2).sql, "ROLLBACK");
});

test("bounded GPS decoding preserves gaps, longitude order and invalid-coordinate breaks with the existing decoder", () => {
  const blob = GpsTrackBlobService.encodeTrackBufferFromQuantized({
    latitudesQ: new Int32Array([4800000, 4810000, -0x80000000, 4900000, 4910000, 9500000, 4930000]),
    longitudesQ: new Int32Array([800000, 810000, -0x80000000, 900000, 910000, 920000, 930000]), scale: 100000
  });
  const feature = JSON.parse(decodePublicGps(blob, "identity", "7"));
  assert.deepEqual(feature.properties, { workout_id: "7" });
  assert.equal(feature.geometry.type, "MultiLineString");
  assert.equal(feature.geometry.coordinates.length, 2);
  assert.deepEqual(feature.geometry.coordinates[0][0], [8, 48]);
  assert.equal(feature.geometry.coordinates.flat().length, 4);
  assert.deepEqual(JSON.parse(decodePublicGps(gzipSync(blob), "gzip", "7")), feature);
  assert.throws(() => decodePublicGps(Buffer.alloc(PUBLIC_GPS_LIMITS.blobBytes + 1), "identity", "7"), { statusCode: 422 });
  assert.throws(() => decodePublicGps(gzipSync(Buffer.alloc(PUBLIC_GPS_LIMITS.rawBytes + 1)), "gzip", "7"), { statusCode: 422 });
  const excessive = Buffer.alloc(20);
  excessive.write("GPS2"); excessive.writeUInt16LE(1, 4); excessive.writeUInt32LE(PUBLIC_GPS_LIMITS.slots + 1, 8);
  assert.throws(() => decodePublicGps(excessive, "identity", "7"), { statusCode: 422 });
  assert.throws(() => decodePublicGps(Buffer.from("invalid"), "identity", "7"));
});

test("GPS service bounds fetched blobs in SQL, denies foreign IDs and executes the real isolated worker", async () => {
  const blob = GpsTrackBlobService.encodeTrackBuffer([{ lat: 48, lng: 8 }, { lat: 48.1, lng: 8.1 }]);
  const database = databaseFixture([{ validgps: true, gps_track_blob: blob, gps_track_blob_codec: "identity", blob_size: blob.byteLength }]);
  const service = new Service({ database });
  const result = JSON.parse(await service.gps("42", "7"));
  assert.equal(result.geometry.type, "MultiLineString");
  const query = database.calls.find(call => call.sql.includes("FROM workouts"));
  assert.deepEqual(query.params, ["42", "7", PUBLIC_GPS_LIMITS.blobBytes]);
  assert.match(query.sql, /CASE WHEN validgps = true AND octet_length/);
  assert.match(query.sql, /WHERE uid = \$1 AND id = \$2/);
  assert.doesNotMatch(query.sql, /stream|manual_gps_lookup|JOIN/);
  assert.equal(JSON.parse(await new Service({ database: databaseFixture([{}]) }).gps("42", "7")).geometry, null);
  await assert.rejects(new Service({ database: databaseFixture() }).gps("42", "7"), { statusCode: 404 });
  await assert.rejects(new Service({ database: databaseFixture([{ validgps: true, blob_size: PUBLIC_GPS_LIMITS.blobBytes + 1 }]) })
    .gps("42", "7"), { statusCode: 422 });
  await assert.rejects(runPublicGpsWorker({ gps_track_blob: blob, gps_track_blob_codec: "identity" }, "7", 1), { statusCode: 422 });
});

async function serve(context, app) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  context.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test("public HTTP routes require only Bearer identity, both GPS scopes and safe JSON without browser fallback", async context => {
  const logs = []; context.mock.method(console, 'error', text => logs.push(JSON.parse(text)));
  const original = ApiKeyService.resolve;
  context.after(() => { ApiKeyService.resolve = original; });
  ApiKeyService.resolve = async secret => {
    if (secret === "outage") throw new Error("SQL and secret must not leak");
    if (!["read", "gps"].includes(secret)) throw Object.assign(new Error("expired or revoked"), { statusCode: 401 });
    return { userId: "42", keyId: "9", scopes: secret === "gps" ? ["workouts:read", "workouts:gps:read"] : ["workouts:read"] };
  };
  const database = databaseFixture([{ id: "7", workout_type: "road", validgps: false }]);
  const app = express();
  let browserCalls = 0;
  app.use((req, res, next) => { req.user = { id: 99 }; next(); });
  app.use("/api/v1", createPublicWorkoutApiRouter({ service: new Service({ database }),
    rateLimit: () => (req, res, next) => next() }));
  app.use((req, res) => { browserCalls += 1; res.redirect("/login"); });
  const base = await serve(context, app);
  const get = (path, secret, options = {}) => fetch(`${base}/api/v1${path}`, {
    headers: secret ? { Authorization: `Bearer ${secret}` } : { Cookie: "session=browser" }, ...options, redirect: "manual"
  });
  const missing = await get("/workouts");
  assert.equal(missing.status, 401);
  assert.match(missing.headers.get("www-authenticate"), /Bearer/);
  assert.equal(missing.headers.get("cache-control"), "no-store");
  assert.equal((await get("/workouts?api_key=read")).status, 401);
  const list = await get("/workouts", "read");
  assert.equal(list.status, 200);
  assert.equal((await list.json()).data[0].id, "7");
  assert.equal(database.calls.find(call => call.sql.includes("FROM workouts")).params[0], "42");
  assert.equal((await get("/workouts?userId=99", "read")).status, 400);
  assert.equal((await get("/workouts/7?type=road", "read")).status, 400);
  assert.equal((await get("/workouts/7", "read")).status, 200);
  assert.equal((await get("/workouts/7/gps", "read")).status, 403);
  const gps = await get("/workouts/7/gps", "gps");
  assert.equal(gps.status, 200);
  assert.match(gps.headers.get("content-type"), /^application\/geo\+json/);
  assert.deepEqual(await gps.json(), { type: "Feature", properties: { workout_id: "7" }, geometry: null });
  const broken = await get("/workouts", "outage");
  assert.equal(broken.status, 503);
  const brokenBody = await broken.json();
  assert.equal(brokenBody.error.request_id, broken.headers.get('x-request-id'));
  assert.equal(logs.at(-1).request_id, brokenBody.error.request_id);
  assert.doesNotMatch(JSON.stringify({ logs, brokenBody }), /SQL|secret/);
  assert.equal((await get("/workouts", "revoked")).status, 401);
  assert.equal((await get("/unknown", "read")).status, 404);
  const post = await get("/workouts", "read", { method: "POST" });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET");
  assert.equal(browserCalls, 0);
  const source = fs.readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
  assert.ok(source.indexOf('app.use("/api/v1", publicWorkoutApiRoutes)') < source.indexOf("app.use(sessionMiddleware)"));
});

test("rolling Redis protection uses shared user buckets, Retry-After and fails closed", async context => {
  const calls = [];
  let response = [1, 0];
  const redis = { async eval(script, options) {
    calls.push({ script, options });
    if (response instanceof Error) throw response;
    return response;
  } };
  const app = express();
  app.use((req, res, next) => { req.apiAuth = { userId: "42", keyId: req.get("x-test-key") }; next(); });
  app.use(publicApiRateLimit("user", 60, req => req.apiAuth.userId, { getClient: async () => redis }));
  app.get("/", (req, res) => res.json({ ok: true }));
  const base = await serve(context, app);
  assert.equal((await fetch(base, { headers: { "x-test-key": "first" } })).status, 200);
  assert.equal((await fetch(base, { headers: { "x-test-key": "second" } })).status, 200);
  assert.equal(calls[0].options.keys[0], calls[1].options.keys[0]);
  assert.equal(calls[0].options.arguments[0], "60");
  assert.match(calls[0].script, /ZREMRANGEBYSCORE/);
  assert.match(calls[0].script, /redis.call\('TIME'\)/);
  assert.match(calls[0].script, /PEXPIRE/);
  response = [0, 12];
  const blocked = await fetch(base);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get("retry-after"), "12");
  response = new Error("private Redis configuration");
  const outage = await fetch(base);
  assert.equal(outage.status, 503);
  assert.doesNotMatch(await outage.text(), /private|configuration/);
  for (const malformed of [null, [], [1], [1, NaN], [1, 1], [0, Infinity], [0, 0], [0, 61], ["1", 0]]) {
    response = malformed;
    assert.equal((await fetch(base)).status, 503);
  }
});

test("public classifications match the OpenAPI enums and only classified cycling receives load metrics", () => {
  const projected = projectPublicWorkout({ id: "7", workout_type: "private-future-value",
    terrain_profile: "private", intensity_profile: "private", intensity_structure: "private", intensity_dose: "private",
    avg_normalized_power: 200, total_timer_time: 3600 }, 250);
  for (const field of ["workout_type", "terrain_profile", "intensity_profile", "intensity_structure", "intensity_dose"]) {
    const property = contract.components.schemas.Workout.properties[field];
    const schema = property.$ref ? contract.components.schemas.WorkoutType : property;
    assert.ok(schema.enum.includes(projected[field]));
  }
  assert.doesNotMatch(JSON.stringify(projected), /private/);
  for (const workout_type of ["unknown", "motorsport", null]) {
    const result = projectPublicWorkout({ id: "7", workout_type, avg_normalized_power: 200, total_timer_time: 3600 }, 250);
    assert.equal(result.tss, null);
    assert.equal(result.intensity_factor, null);
    assert.equal(result.ftp_used_watts, null);
  }
});

test("public time filters normalize offsets across calendar boundaries and keep exact SQL bounds", async () => {
  const database = databaseFixture();
  const service = new Service({ database });
  const result = await service.list("42", new URLSearchParams({ from: "2026-01-01T00:30:00.123456+01:00",
    to: "2025-12-31T23:30:00.123457Z" }));
  assert.deepEqual(result, { data: [], next_cursor: null });
  const query = database.calls.find(call => call.sql.includes("FROM workouts"));
  assert.deepEqual(query.params, ["42", "2025-12-31T23:30:00.123456Z", "2025-12-31T23:30:00.123457Z", 51]);
  assert.ok(query.sql.includes("start_time >= $2::timestamptz"));
  assert.ok(query.sql.includes("start_time < $3::timestamptz"));
  assert.ok(!database.calls.some(call => call.sql.includes("get_ftp")));
});

test("public FTP uses one yearly series per page and nulls missing prerequisites", async () => {
  for (const ftpRows of [[], [{ period: 2026, ftp: null }], [{ period: 2026, ftp: Infinity }], [{ period: 2026, ftp: 250 }]]) {
    const database = databaseFixture();
    const client = await database.connect();
    const query = client.query;
    client.query = async (sql, params) => sql.includes("get_ftp") ? { rows: ftpRows } : query(sql, params);
    const rows = await new Service({ database }).projectRows(client, "42", [
      { id: "7", start_time: "2026-11-09T00:00:00Z", workout_type: "road", avg_normalized_power: 200, total_timer_time: 3600 },
      { id: "6", start_time: null, workout_type: "road", avg_normalized_power: 200, total_timer_time: 3600 }
    ]);
    assert.equal(rows[0].tss, ftpRows[0]?.ftp === 250 ? 64 : null);
    assert.equal(rows[1].ftp_used_watts, null);
    assert.equal(rows[1].tss, null);
  }
});

test("public GPS supports stored codecs and rejects incomplete legacy blocks instead of fabricating zero coordinates", () => {
  const slots = [{ lat: 48, lng: 8 }, { lat: 48.00001, lng: 8.00002 },
    { lat: NaN, lng: NaN }, { lat: 49, lng: 9 }, { lat: 49.00001, lng: 9.00002 }];
  for (const coordinateEncoding of ["int16-escape", "tiered-int8", "bitmap-columnar"]) {
    const blob = Buffer.from(buildGpsTrackBlock({ slots, slotCount: slots.length, sampleRateSeconds: 5 }, { coordinateEncoding }));
    const feature = JSON.parse(decodePublicGps(blob, null, "7"));
    assert.equal(feature.geometry.coordinates.length, 2);
    assert.deepEqual(feature.geometry.coordinates[0][0], [8, 48]);
    for (const [encoded, codec] of [[gzipSync(blob), "gzip"], [brotliCompressSync(blob), "brotli"]]) {
      assert.deepEqual(JSON.parse(decodePublicGps(encoded, codec, "7")), feature);
    }
    assert.throws(() => decodePublicGps(blob.subarray(0, 20), "identity", "7"));
    assert.throws(() => decodePublicGps(blob.subarray(0, blob.length - 1), "identity", "7"));
    assert.throws(() => decodePublicGps(Buffer.concat([blob, Buffer.from([0])]), "identity", "7"));
  }
  for (const layout of [1, 2, 3, 4]) {
    const header = Buffer.alloc(20);
    header.write("GPS2"); header.writeUInt16LE(layout, 4); header.writeUInt32LE(2, 8);
    assert.throws(() => decodePublicGps(header, "identity", "7"));
    const raw = Buffer.alloc(19);
    raw.writeUInt16LE(2, 1);
    for (let index = 0; index < 4; index += 1) raw.writeInt32LE((index % 2 ? 8 : 48) * 1000000, 3 + index * 4);
    // For layouts >= 2 the raw block is columnar. Equal positions make both layouts equivalent.
    if (layout >= 2) { raw.writeInt32LE(48000000, 7); raw.writeInt32LE(8000000, 11); }
    const feature = JSON.parse(decodePublicGps(Buffer.concat([header, raw]), "identity", "7"));
    assert.deepEqual(feature.geometry.coordinates[0], [[8, 48], [8, 48]]);
    raw.writeUInt16LE(3, 1);
    assert.throws(() => decodePublicGps(Buffer.concat([header, raw]), "identity", "7"));
  }
  const legacy = Buffer.alloc(48);
  legacy[0] = 1; legacy.writeUInt32BE(2, 4); legacy.writeUInt32BE(100000, 12);
  legacy.writeInt32LE(4800000, 32); legacy.writeInt32LE(4810000, 36);
  legacy.writeInt32LE(800000, 40); legacy.writeInt32LE(810000, 44);
  assert.deepEqual(JSON.parse(decodePublicGps(legacy, null, "7")).geometry.coordinates[0], [[8, 48], [8.1, 48.1]]);
});

test("GPS worker capacity is bounded and released after success and timeout", async () => {
  const row = { gps_track_blob: GpsTrackBlobService.encodeTrackBuffer([{ lat: 48, lng: 8 }, { lat: 49, lng: 9 }]),
    gps_track_blob_codec: "identity" };
  const first = runPublicGpsWorker(row, "7");
  const second = runPublicGpsWorker(row, "8");
  await assert.rejects(runPublicGpsWorker(row, "9"), { statusCode: 429 });
  await Promise.all([first, second]);
  await assert.rejects(runPublicGpsWorker(row, "7", 1), { statusCode: 422 });
  assert.equal(JSON.parse(await runPublicGpsWorker(row, "7")).properties.workout_id, "7");
  await assert.rejects(runPublicGpsWorker({ gps_track_blob: Buffer.from("invalid") }, "7"), { statusCode: 503 });
});

test("public GPS accepts the slot boundary and rejects oversized GeoJSON without truncation", () => {
  const count = PUBLIC_GPS_LIMITS.slots;
  const raw = Buffer.alloc(32 + count * 8);
  raw[0] = 1; raw.writeUInt32BE(count, 4); raw.writeUInt32BE(100000, 12);
  for (let index = 0; index < count; index += 1) {
    raw.writeInt32LE(100000 + index, 32 + index * 4);
    raw.writeInt32LE(200000 + index, 32 + count * 4 + index * 4);
  }
  const feature = JSON.parse(decodePublicGps(raw, "identity", "7"));
  assert.equal(feature.geometry.coordinates[0].length, count);
  // A legacy fine scale increases decimal text size without increasing blob size.
  raw.writeUInt32BE(4294967295, 12);
  assert.throws(() => decodePublicGps(raw, "identity", "7"), { statusCode: 422, code: "gps_response_too_large" });
});

test("public HTTP errors stay within the contract across all paths and protective gates", async context => {
  const original = ApiKeyService.resolve;
  context.after(() => { ApiKeyService.resolve = original; });
  ApiKeyService.resolve = async secret => {
    if (secret === "deleted") throw Object.assign(new Error("private"), { statusCode: 403 });
    if (["expired", "revoked"].includes(secret)) throw Object.assign(new Error("private"), { statusCode: 401 });
    if (secret === "outage") throw new Error("private");
    return { userId: "42", keyId: "9", scopes: secret === "read" ? ["workouts:read"] : ["workouts:read", "workouts:gps:read"] };
  };
  const buckets = [];
  let serviceError = null;
  let blockedBucket = null;
  const fail = async () => { throw serviceError || Object.assign(new Error("private foreign/shared/absent workout"), { code: "workout_not_found" }); };
  const rateLimit = (bucket, limit, identify) => (req, res, next) => {
    buckets.push({ bucket, limit, identity: identify(req) });
    if (blockedBucket === bucket) {
      res.set("Retry-After", "10");
      return res.status(429).json({ error: { code: "rate_limited", message: "Request allowance exceeded.", request_id: "fixture" } });
    }
    next();
  };
  const app = express();
  app.use("/api/v1", createPublicWorkoutApiRouter({ service: { list: fail, detail: fail, gps: fail }, rateLimit }));
  app.use("/secure/v1", createPublicWorkoutApiRouter({ httpsOnly: true, rateLimit }));
  const base = await serve(context, app);
  const check = async (path, secret, status, code, options = {}) => {
    const response = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${secret}` }, ...options });
    assert.equal(response.status, status, `${path}: ${secret}`);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.ok(response.headers.get("content-type").startsWith("application/json"));
    const body = await response.json();
    assert.deepEqual(Object.keys(body), ["error"]);
    assert.deepEqual(Object.keys(body.error).sort(), ["code", "message", "request_id"]);
    assert.equal(body.error.code, code);
    assert.ok(contract.components.schemas.Error.properties.error.properties.code.enum.includes(code));
    assert.doesNotMatch(JSON.stringify(body), /private|foreign|shared/);
    if (status === 401) assert.match(response.headers.get("www-authenticate"), /Bearer/);
    if (status === 429) assert.ok(Number(response.headers.get("retry-after")) >= 1);
  };
  for (const path of ["/api/v1/workouts", "/api/v1/workouts/7", "/api/v1/workouts/7/gps"]) {
    for (const secret of ["expired", "revoked"]) await check(path, secret, 401, "unauthorized");
    await check(path, "deleted", 403, "account_unavailable");
    await check(path, "outage", 503, "service_unavailable");
    await check(path, "pending", 404, "workout_not_found");
    serviceError = new Error("private SQL dependency error");
    await check(path, "gps", 503, "service_unavailable");
    serviceError = null;
  }
  buckets.length = 0;
  await check("/api/v1/workouts/7/gps", "read", 403, "insufficient_scope");
  assert.deepEqual(buckets.map(({ bucket, limit }) => [bucket, limit]), [["ingress", 480], ["user", 240]]);
  buckets.length = 0;
  await check("/api/v1/workouts/7/gps", "gps", 404, "workout_not_found");
  assert.deepEqual(buckets.map(({ bucket, limit }) => [bucket, limit]), [["ingress", 480], ["user", 240], ["gps", 40]]);
  assert.equal(buckets[1].identity, "42");
  assert.equal(buckets[2].identity, "42");
  serviceError = Object.assign(new Error("private"), { code: "gps_response_too_large" });
  await check("/api/v1/workouts/7/gps", "gps", 422, "gps_response_too_large");
  serviceError = Object.assign(new Error("private"), { code: "rate_limited" });
  await check("/api/v1/workouts/7/gps", "gps", 429, "rate_limited");
  serviceError = null;
  for (const bucket of ["ingress", "user", "gps"]) {
    blockedBucket = bucket;
    await check("/api/v1/workouts/7/gps", "gps", 429, "rate_limited");
  }
  blockedBucket = null;
  await check("/api/v1/workouts/%ZZ", "gps", 400, "invalid_request");
  await check("/api/v1/workouts/7/gps?limit=1", "gps", 400, "invalid_request");
  await check("/api/v1/analytics", "gps", 404, "not_found");
  for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
    await check("/api/v1/workouts", "gps", 405, "method_not_allowed", { method });
  }
  const head = await fetch(`${base}/api/v1/workouts`, { method: "HEAD" });
  assert.equal(head.status, 405);
  assert.equal(head.headers.get("allow"), "GET");
  assert.equal(head.headers.get("cache-control"), "no-store");
  assert.equal(await head.text(), "");
  await check("/secure/v1/workouts", "gps", 400, "invalid_request");
});
