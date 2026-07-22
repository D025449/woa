import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { createWoa1FileFromCompactAsync } from "../src/public/js/woa-format-compact.js";
import GpsTrackBlobCodec from "../src/shared/GpsTrackBlobCodec.js";
import { FileDBService } from "../src/services/fileDBService.js";

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
