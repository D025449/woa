import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";

import {
  createWoa1FileFromCompactAsync,
  deriveElevationTotalsFromCompact
} from "../src/public/js/woa-format-compact.js";
import GpsTrackBlobCodec from "../src/shared/GpsTrackBlobCodec.js";
import Workout from "../src/shared/Workout.js";
import { FileDBService } from "../src/services/fileDBService.js";

test("derives missing session ascent from compact altitude records", () => {
  const altitudesQ = Int16Array.from([
    400, 404, 408, 404, 416, 412,
    -0x8000,
    800, 804,
    1_000 // ignored as an implausible single-record jump
  ]);

  assert.deepEqual(deriveElevationTotalsFromCompact({
    recordCount: altitudesQ.length,
    altitudesQ
  }), {
    totalAscent: 6,
    totalDescent: 2
  });
});

test("browser WOA1 keeps GPS2 raw while compressing the workout stream", async () => {
  const recordCount = 30;
  const baseTimestampSec = 1_700_000_000;
  const compactRecords = {
    recordCount,
    baseTimestampSec,
    lastTimestampSec: baseTimestampSec + recordCount - 1,
    distancesQ: Uint32Array.from({ length: recordCount }, (_, index) => index * 20),
    powersW: new Uint16Array(recordCount).fill(200),
    heartRatesBpm: new Uint8Array(recordCount).fill(140),
    cadencesRpm: new Uint8Array(recordCount).fill(90),
    speedsCmS: new Uint16Array(recordCount).fill(800),
    altitudesQ: new Int16Array(recordCount).fill(3000),
    positionLatsE6: Int32Array.from({ length: recordCount }, (_, index) => 48_137_150 + index),
    positionLongsE6: Int32Array.from({ length: recordCount }, (_, index) => 11_576_120 + index)
  };
  const sessions = [{
    start_time: new Date(baseTimestampSec * 1000).toISOString(),
    timestamp: new Date((baseTimestampSec + recordCount - 1) * 1000).toISOString(),
    total_elapsed_time: recordCount,
    total_timer_time: recordCount,
    total_distance: 600,
    avg_power: 200,
    avg_heart_rate: 140,
    avg_cadence: 90
  }];

  const woa = await createWoa1FileFromCompactAsync({ compactRecords, sessions }, {
    sourceName: "sample.fit",
    sampleRateSeconds: 5,
    streamCodec: "gzip",
    gpsTrackBlobCodec: "identity",
    compressWorkoutStream: async (bytes) => gzipSync(bytes),
    compressGpsTrack: null
  });

  assert.equal(new DataView(woa.bytes.buffer, woa.bytes.byteOffset, woa.bytes.byteLength).getUint8(4), 2);
  assert.equal(woa.meta.blockCodecs.workout_stream, "gzip");
  assert.equal(woa.meta.blockCodecs.gps_track, "identity");
  assert.equal(woa.meta.persistedRow.gps_track_blob_codec, "identity");
  assert.equal(woa.meta.persistedRow.total_calories, 6);
  assert.equal(woa.meta.persistedRow.avg_normalized_power, 200);
  assert.equal(woa.meta.normalizedPower, 200);
  assert.equal(woa.meta.persistedRow.total_work, 1);
  assert.equal(woa.meta.totalWork, 1);
  assert.equal(Buffer.from(woa.gpsTrackBytes).subarray(0, 4).toString("ascii"), "GPS2");
  assert.equal(woa.meta.blockBytes.gps_track_raw, woa.meta.blockBytes.gps_track_compressed);
  assert.equal(woa.gpsTrackBytes.byteLength, woa.meta.blockBytes.gps_track_raw);
  assert.equal(woa.workoutStreamBytes[0], 0x1f);
  assert.equal(woa.workoutStreamBytes[1], 0x8b);

  const prepared = FileDBService.preparePersistedWoaInsertPayload(woa.meta, {
    uid: 1,
    workoutStreamStoredBytes: woa.workoutStreamBytes,
    gpsTrackStoredBytes: woa.gpsTrackBytes
  });
  assert.equal(prepared.streamCodec, "gzip");
  assert.equal(prepared.gpsTrackBlobCodec, "identity");
  assert.deepEqual(prepared.compressedGpsTrackBlob, Buffer.from(woa.gpsTrackBytes));

  const decodedGps = await GpsTrackBlobCodec.decodeCompressed(woa.gpsTrackBytes, {
    codec: "identity"
  });
  assert.equal(decodedGps.validGps, true);
  assert.equal(decodedGps.sampleRateGps, 5);
  assert.ok(decodedGps.pointCount > 0);
});

test("browser WOA1 removes meaningless GPS bounce tracks from indoor workouts", async () => {
  const recordCount = 600;
  const baseTimestampSec = 1_700_000_000;
  const compactRecords = {
    recordCount,
    baseTimestampSec,
    lastTimestampSec: baseTimestampSec + recordCount - 1,
    distancesQ: Uint32Array.from(
      { length: recordCount },
      (_, index) => Math.round((index / (recordCount - 1)) * 60_000)
    ),
    powersW: new Uint16Array(recordCount).fill(200),
    heartRatesBpm: new Uint8Array(recordCount).fill(140),
    cadencesRpm: new Uint8Array(recordCount).fill(90),
    speedsCmS: new Uint16Array(recordCount).fill(5_000),
    altitudesQ: new Int16Array(recordCount).fill(1_200),
    positionLatsE6: Int32Array.from(
      { length: recordCount },
      (_, index) => 48_137_150 + (index % 10)
    ),
    positionLongsE6: Int32Array.from(
      { length: recordCount },
      (_, index) => 11_576_120 + (index % 10)
    )
  };
  const sessions = [{
    start_time: new Date(baseTimestampSec * 1000).toISOString(),
    timestamp: new Date((baseTimestampSec + recordCount - 1) * 1000).toISOString(),
    total_elapsed_time: recordCount,
    total_timer_time: recordCount,
    total_distance: 30_000,
    avg_speed: 50,
    avg_power: 200,
    avg_heart_rate: 140,
    avg_cadence: 90
  }];

  const woa = await createWoa1FileFromCompactAsync({ compactRecords, sessions }, {
    sourceName: "indoor.fit",
    sampleRateSeconds: 5,
    compressWorkoutStream: null,
    compressGpsTrack: null
  });
  const decodedGps = await GpsTrackBlobCodec.decodeCompressed(woa.gpsTrackBytes, {
    codec: "identity"
  });
  const decodedWorkout = Workout.decodeWst3Buffer(woa.workoutStreamBytes);

  assert.equal(woa.meta.persistedRow.workout_type, "indoor");
  assert.equal(woa.meta.persistedRow.validGps, false);
  assert.equal(woa.meta.persistedRow.points_count, 0);
  assert.equal(woa.meta.persistedRow.bounds, null);
  assert.equal(woa.meta.validGps, false);
  assert.equal(woa.meta.pointsCount, 0);
  assert.equal(decodedGps.validGps, false);
  assert.equal(decodedGps.pointCount, 0);
  assert.equal(decodedWorkout.altitudesM.every((altitude) => altitude === 300), true);
});

test("browser WOA1 removes barometric drift from stationary indoor workouts", async () => {
  const recordCount = 600;
  const baseTimestampSec = 1_700_000_000;
  const compactRecords = {
    recordCount,
    baseTimestampSec,
    lastTimestampSec: baseTimestampSec + recordCount - 1,
    distancesQ: new Uint32Array(recordCount),
    powersW: new Uint16Array(recordCount).fill(200),
    heartRatesBpm: new Uint8Array(recordCount).fill(140),
    cadencesRpm: new Uint8Array(recordCount).fill(90),
    speedsCmS: new Uint16Array(recordCount),
    altitudesQ: Int16Array.from(
      { length: recordCount },
      (_, index) => 1_200 + (index % 8)
    ),
    positionLatsE6: new Int32Array(recordCount).fill(-0x80000000),
    positionLongsE6: new Int32Array(recordCount).fill(-0x80000000)
  };
  const sessions = [{
    start_time: new Date(baseTimestampSec * 1000).toISOString(),
    timestamp: new Date((baseTimestampSec + recordCount - 1) * 1000).toISOString(),
    total_elapsed_time: recordCount,
    total_timer_time: recordCount,
    total_distance: 0,
    total_ascent: 8,
    total_descent: 7,
    avg_power: 200,
    avg_heart_rate: 140,
    avg_cadence: 90
  }];

  const woa = await createWoa1FileFromCompactAsync({ compactRecords, sessions }, {
    sourceName: "stationary-indoor.fit",
    sampleRateSeconds: 5,
    compressWorkoutStream: null,
    compressGpsTrack: null
  });
  const decodedWorkout = Workout.decodeWst3Buffer(woa.workoutStreamBytes);

  assert.equal(woa.meta.persistedRow.workout_type, "indoor");
  assert.equal(woa.meta.persistedRow.total_ascent, 0);
  assert.equal(woa.meta.persistedRow.total_descent, 0);
  assert.equal(woa.meta.totalAscent, 0);
  assert.equal(woa.meta.totalDescent, 0);
  assert.equal(decodedWorkout.altitudesM.every(Number.isNaN), true);
  assert.ok(woa.stats.workoutStream.blockBytes.altitudes < 32);
});

test("browser GPS reader trusts a raw GPS2 signature over stale Brotli metadata", async () => {
  const rawGps2 = new Uint8Array(24);
  rawGps2.set([0x47, 0x50, 0x53, 0x32], 0);
  const view = new DataView(rawGps2.buffer);
  view.setUint16(4, 5, true);
  view.setUint16(6, 5, true);
  view.setUint32(8, 0, true);
  view.setFloat64(12, 0, true);
  view.setUint32(20, 0, true);

  const decoded = await GpsTrackBlobCodec.decodeCompressed(rawGps2, {
    codec: "brotli"
  });
  assert.equal(decoded.pointCount, 0);
  assert.equal(decoded.sampleRateGps, 5);
});
