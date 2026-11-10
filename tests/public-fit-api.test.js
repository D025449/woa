import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import express from "express";
import { gzipSync, brotliCompressSync } from "node:zlib";
import Workout from "../src/shared/Workout.js";
import FitExportService from "../src/services/fitExportService.js";
import GpsTrackBlobService from "../src/services/gpsTrackBlobService.js";
import ApiKeyService from "../src/services/apiKeyService.js";
import Service from "../src/services/publicWorkoutApiService.js";
import { buildPublicFit, PUBLIC_FIT_LIMITS, runPublicFitWorker } from "../src/services/publicApiFitService.js";
import { buildWorkoutStreamBlockWst11, buildWorkoutStreamBlockWst11FromWorkout } from "../src/public/js/woa-format-compact.js";
import { parseFitBufferCompactBrowser } from "../src/public/js/fit-import-compact-browser.js";
import { createPublicWorkoutApiRouter } from "../src/routes/publicWorkoutApiRoutes.js";

const allScopes = ["workouts:read", "workouts:gps:read", "workouts:fit:read"];
const metadata = { version: 1, fileId: { type: 4, manufacturer: 1, product: 4440,
  productName: "Test device", serialNumber: 123456, timeCreated: "2024-01-02T03:04:05.000Z" }, devices: [] };

function fixture(embedded = true) {
  const compact = { recordCount: 6, baseTimestampSec: Date.UTC(2024, 0, 2, 3, 4, 5) / 1000,
    distancesQ: Uint32Array.from([0, 10, 20, 30, 40, 50]), powersW: Uint16Array.from([200, 204, 208, 212, 216, 220]),
    heartRatesBpm: Uint8Array.from([120, 121, 122, 123, 124, 125]), cadencesRpm: Uint8Array.from([80, 81, 82, 83, 84, 85]),
    speedsCmS: Uint16Array.from([500, 500, 500, 500, 500, 500]), altitudesQ: Int16Array.from([2000, 2004, 2008, 2012, 2016, 2020]),
    temperaturesC: Int8Array.from([18, 19, 18, 19, 18, 19]), leftRightBalancesPct: Uint8Array.from([51, 52, 127, 52, 51, 52]) };
  const stream = Buffer.from(buildWorkoutStreamBlockWst11(compact, embedded ? { fitDeviceMetadata: metadata } : {}).bytes);
  const coordinates = [{ lat: 48, lng: 8 }, { lat: 48.1, lng: 8.1 }];
  const gps = GpsTrackBlobService.encodeTrackBuffer(coordinates);
  const row = { id: "7", stream, stream_codec: "identity", validgps: true, samplerategps: 5, gps_source: "recorded",
    gps_track_blob: gps, gps_track_blob_codec: "identity", fit_device_metadata: metadata,
    avg_normalized_power: 219, total_calories: 321, workout_type: "road", stream_size: stream.length, gps_size: gps.length };
  const segments = [{ id: "11", start_offset: 1, end_offset: 4, segmenttype: "manual", structure_kind: "simple" }];
  return { row, segments, coordinates };
}

test("public FIT matches the existing generator and roundtrips GPS, measurements, devices and laps", () => {
  for (const embedded of [true, false]) {
    const { row, segments, coordinates } = fixture(embedded);
    const workout = Workout.fromBuffer(row.stream.buffer.slice(row.stream.byteOffset, row.stream.byteOffset + row.stream.byteLength));
    const expected = FitExportService.buildFitFromWorkout(workout, { serialNumber: 7, sampleRateGps: 5,
      gpsCoordinates: coordinates.map(point => [point.lat, point.lng]), includeGps: true, gpsSource: "recorded",
      fitDeviceMetadata: workout.fitDeviceMetadata || metadata, normalizedPower: 219, totalCalories: 321, workoutType: "road", segments });
    for (const codec of ["identity", "gzip", "brotli"]) {
      const stream = codec === "gzip" ? gzipSync(row.stream) : codec === "brotli" ? brotliCompressSync(row.stream) : row.stream;
      const result = buildPublicFit({ ...row, stream, stream_codec: codec }, segments);
      assert.deepEqual(result.bytes, expected);
      assert.equal(result.fileName, "2024-01-02-03-04-05.fit");
      assert.equal(result.bytes.subarray(8, 12).toString("ascii"), ".FIT");
      const parsed = parseFitBufferCompactBrowser(result.bytes);
      assert.equal(parsed.compactRecords.recordCount, 6);
      assert.deepEqual(Array.from(parsed.compactRecords.temperaturesC), [18, 19, 18, 19, 18, 19]);
      assert.equal(parsed.fitDeviceMetadata.fileId.serialNumber, 123456);
      assert.equal(parsed.sessions[0].normalized_power, 219);
      assert.equal(parsed.sessions[0].total_calories, 321);
      assert.equal(parsed.laps[0].total_timer_time, 3);
      assert.ok(parsed.compactRecords.positionLatsE6.some(value => value !== -2147483648));
    }
  }
});

test("public FIT handles GPS-free and legacy streams and preserves interval phases", () => {
  const { row } = fixture();
  const workout = Workout.fromRecords(Array.from({ length: 8 }, (_, index) => ({ power: 200, hr: 130, cadence: 80,
    speed: 20, altitude: 500, distance: index * 5 })), { startTime: Date.UTC(2024, 0, 2, 3, 4, 5) });
  const segments = [{ start_offset: 0, end_offset: 6, segmenttype: "auto", structure_kind: "intervals", phases: [
    { phase_kind: "work", start_offset: 0, end_offset: 2 }, { phase_kind: "recovery", start_offset: 3, end_offset: 5 }
  ] }];
  for (const stream of [Buffer.from(workout.toBuffer()), Buffer.from(buildWorkoutStreamBlockWst11FromWorkout(workout).bytes)]) {
    const result = buildPublicFit({ ...row, stream, validgps: false, gps_track_blob: null }, segments);
    const parsed = parseFitBufferCompactBrowser(result.bytes);
    assert.deepEqual(parsed.laps.slice(0, 2).map(lap => lap.intensity), [0, 4]);
    assert.ok(parsed.compactRecords.positionLatsE6.every(value => value === -2147483648));
  }
});

test("FIT source, decoded record, metadata, lap and output budgets fail without partial files", () => {
  const { row, segments } = fixture();
  for (const limits of [{ streamBytes: 1 }, { rawBytes: 1 }, { records: 1 }, { metadataBytes: 1 },
    { gpsBlobBytes: 1 }, { gpsRawBytes: 1 }, { gpsSlots: 1 }, { segments: 0 }, { responseBytes: 1 }]) {
    assert.throws(() => buildPublicFit(row, segments, { ...PUBLIC_FIT_LIMITS, ...limits }), { statusCode: 422 });
  }
  assert.throws(() => buildPublicFit(row, [{ ...segments[0], phases: [{}, {}] }], { ...PUBLIC_FIT_LIMITS, phases: 1 }), { statusCode: 422 });
  for (const stream of [Buffer.from("invalid"), row.stream.subarray(0, row.stream.length - 1)]) {
    assert.throws(() => buildPublicFit({ ...row, stream }, []));
  }
  assert.throws(() => buildPublicFit({ ...row, stream_codec: "unknown" }, []));
  assert.throws(() => buildPublicFit({ ...row, gps_track_blob: Buffer.from("invalid") }, []));
  assert.throws(() => buildPublicFit({ ...row, stream: gzipSync(Buffer.alloc(100)), stream_codec: "gzip" }, [],
    { ...PUBLIC_FIT_LIMITS, rawBytes: 50 }), { statusCode: 422 });
});

test("FIT GPS retains missing slots without shifting later positions or interpolating across gaps", () => {
  const { row } = fixture();
  const gps = GpsTrackBlobService.encodeTrackBufferFromQuantized({
    latitudesQ: new Int32Array([4800000, 4810000, -2147483648, -2147483648, 4900000, 4910000]),
    longitudesQ: new Int32Array([800000, 810000, -2147483648, -2147483648, 900000, 910000]), scale: 100000
  });
  const parsed = parseFitBufferCompactBrowser(buildPublicFit({ ...row, gps_track_blob: gps, samplerategps: 1 }, []).bytes);
  const latitude = parsed.compactRecords.positionLatsE6;
  assert.equal(latitude[2], -2147483648); assert.equal(latitude[3], -2147483648);
  assert.ok(Math.abs(latitude[4] / 1000000 - 49) < 0.00001);
  assert.ok(Math.abs(latitude[5] / 1000000 - 49.1) < 0.00001);
});

test("FIT worker uses the real generator and releases capacity on timeout, corruption and success", async () => {
  const { row, segments } = fixture();
  const expected = buildPublicFit(row, segments);
  const first = runPublicFitWorker(row, segments);
  const second = runPublicFitWorker(row, segments);
  await assert.rejects(runPublicFitWorker(row, segments), { statusCode: 429 });
  const results = await Promise.all([first, second]);
  assert.deepEqual(results[0].bytes, expected.bytes);
  await assert.rejects(runPublicFitWorker(row, segments, 1), { statusCode: 422, code: "fit_response_too_large" });
  await assert.rejects(runPublicFitWorker({ ...row, stream: Buffer.from("invalid") }, []), { statusCode: 503 });
  assert.deepEqual((await runPublicFitWorker(row, segments)).bytes, expected.bytes);
});

function databaseFixture({ row = fixture().row, segments = [], phases = [], fail = null } = {}) {
  const calls = [];
  const client = { async query(sql, params) {
    calls.push({ sql, params });
    if (sql.includes("FROM workouts")) {
      if (fail) throw fail;
      return { rows: row && params[0] === "42" && params[1] === row.id ? [row] : [] };
    }
    if (sql.includes("FROM workout_segment_phases")) return { rows: phases };
    if (sql.includes("FROM workout_segments")) return { rows: segments };
    return { rows: [] };
  }, release() { calls.push({ sql: "RELEASE" }); } };
  return { calls, async connect() { return client; } };
}

test("FIT SQL binds owners/BIGINT IDs and caps blobs/laps/phases before worker execution", async () => {
  const { row } = fixture();
  row.id = "9223372036854775807";
  const segments = [{ id: "11", start_offset: 0, end_offset: 5, structure_kind: "intervals", segmenttype: "auto" }];
  const database = databaseFixture({ row, segments, phases: [{ segment_id: "11", position: 0, phase_kind: "work", start_offset: 0, end_offset: 5 }] });
  let received;
  const service = new Service({ database, fitWorker: async (row, segments) => {
    assert.equal(database.calls.at(-2).sql, "COMMIT");
    assert.equal(database.calls.at(-1).sql, "RELEASE");
    received = { row, segments }; return { bytes: Buffer.from("fixture"), fileName: "workout.fit" };
  } });
  await service.fit("42", row.id);
  assert.equal(received.row.id, row.id);
  assert.equal(received.segments[0].phases.length, 1);
  const queries = database.calls.filter(call => call.sql.includes("FROM workout"));
  assert.deepEqual(queries[0].params, ["42", row.id, PUBLIC_FIT_LIMITS.streamBytes, PUBLIC_FIT_LIMITS.gpsBlobBytes, PUBLIC_FIT_LIMITS.metadataBytes]);
  assert.ok(queries[0].sql.includes("WHERE uid = $1 AND id = $2"));
  assert.ok(queries[0].sql.includes("CASE WHEN octet_length(stream) <= $3"));
  assert.ok(queries[1].sql.includes("WHERE uid = $1 AND wid = $2"));
  assert.equal(queries[1].params.at(-1), PUBLIC_FIT_LIMITS.segments + 1);
  assert.ok(queries[2].sql.includes("WHERE s.uid = $1 AND s.wid = $2"));
  assert.equal(queries[2].params.at(-1), PUBLIC_FIT_LIMITS.phases + 1);
  for (const query of queries) assert.doesNotMatch(query.sql, /SELECT [*]|email|segmentname|processing_error/);
  await assert.rejects(service.fit("43", row.id), { statusCode: 404 });
  await assert.rejects(service.fit("42", "999"), { statusCode: 404 });
  await assert.rejects(service.fit("42", "9223372036854775808"), { statusCode: 400 });
});

test("FIT SQL rejects oversized sources/segments/phases and rolls back before worker execution", async () => {
  const { row } = fixture();
  const block = { id: "11", structure_kind: "intervals" };
  const cases = [{ row: { ...row, stream_size: PUBLIC_FIT_LIMITS.streamBytes + 1 } },
    { row: { ...row, gps_size: PUBLIC_FIT_LIMITS.gpsBlobBytes + 1 } },
    { row: { ...row, metadata_size: PUBLIC_FIT_LIMITS.metadataBytes + 1 } },
    { segments: Array(PUBLIC_FIT_LIMITS.segments + 1).fill(block) },
    { segments: [block], phases: Array(PUBLIC_FIT_LIMITS.phases + 1).fill({}) }];
  for (const options of cases) {
    const database = databaseFixture(options);
    const service = new Service({ database, fitWorker: () => assert.fail("worker must not run") });
    await assert.rejects(service.fit("42", "7"), { statusCode: 422, code: "fit_response_too_large" });
    assert.equal(database.calls.at(-2).sql, "ROLLBACK");
  }
});

async function serve(context, app) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  context.after(() => new Promise(resolve => server.close(resolve)));
  return "http://127.0.0.1:" + server.address().port;
}

test("public FIT HTTP returns only owned binary downloads with all scopes and safe errors", async context => {
  let scopes = allScopes;
  let authFailure = null;
  context.mock.method(ApiKeyService, "resolve", async () => {
    if (authFailure) throw Object.assign(new Error("private key"), { statusCode: authFailure });
    return { userId: "42", keyId: "9", scopes };
  });
  const { row } = fixture();
  const database = databaseFixture({ row });
  const buckets = [];
  const app = express();
  app.use("/api/v1", createPublicWorkoutApiRouter({ service: new Service({ database }),
    rateLimit: (bucket, limit, identify) => (req, res, next) => { buckets.push({ bucket, limit, identity: identify(req) }); next(); } }));
  const base = await serve(context, app);
  const url = base + "/api/v1/workouts/7/export.fit";
  const headers = { Authorization: "Bearer test-fixture" };
  assert.equal((await fetch(url)).status, 401);
  for (const candidate of [["workouts:read"], ["workouts:read", "workouts:gps:read"], ["workouts:read", "workouts:fit:read"]]) {
    scopes = candidate; buckets.length = 0;
    assert.equal((await fetch(url, { headers })).status, 403);
    assert.ok(!buckets.some(bucket => bucket.bucket === "fit"));
  }
  scopes = allScopes; buckets.length = 0;
  const download = await fetch(url, { headers });
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("content-type"), "application/octet-stream");
  assert.equal(download.headers.get("cache-control"), "no-store");
  assert.equal(download.headers.get("content-disposition"), 'attachment; filename="2024-01-02-03-04-05.fit"');
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), buildPublicFit(row, []).bytes);
  assert.deepEqual(buckets.map(({ bucket, limit }) => [bucket, limit]), [["ingress", 480], ["user", 240], ["fit", 40]]);
  assert.equal(buckets[2].identity, "42");
  for (const [suffix, status] of [["?timeZone=Europe/Berlin", 400], ["?gps=false", 400]]) {
    assert.equal((await fetch(url + suffix, { headers })).status, status);
  }
  for (const id of ["999", "9223372036854775807"]) assert.equal((await fetch(base + "/api/v1/workouts/" + id + "/export.fit", { headers })).status, 404);
  row.stream_size = PUBLIC_FIT_LIMITS.streamBytes + 1;
  const budget = await fetch(url, { headers });
  assert.equal(budget.status, 422);
  assert.ok(budget.headers.get("content-type").startsWith("application/json"));
  assert.equal(budget.headers.get("content-disposition"), null);
  assert.equal((await budget.json()).error.code, "fit_response_too_large");
  row.stream_size = row.stream.length; row.stream = Buffer.from("invalid");
  const invalid = await fetch(url, { headers });
  assert.equal(invalid.status, 503);
  assert.doesNotMatch(await invalid.text(), /stack|private|workout stream/);
  for (const status of [401, 403, 503]) {
    authFailure = status;
    assert.equal((await fetch(url, { headers })).status, status);
  }
});

test("FIT migration prepares explicit dependent scopes without updating existing keys", () => {
  const sql = fs.readFileSync(new URL("../src/migrations/097_user_api_keys_fit_scope.sql", import.meta.url), "utf8");
  assert.match(sql, /DROP CONSTRAINT user_api_keys_scopes_check/);
  assert.match(sql, /workouts:fit:read/);
  assert.match(sql, /cardinality[(]scopes[)] = 1/);
  assert.doesNotMatch(sql, /UPDATE user_api_keys|DELETE FROM|INSERT INTO/);
});
