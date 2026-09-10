import assert from "node:assert/strict";
import test from "node:test";
import SegmentMatcher from "../src/services/SegmentMatcher.js";
import { benchmarkGpsSegmentBestEfforts } from "../src/shared/BrowserGpsSegmentMatcher.js";
import {
  matchCompactGpsSegmentBestEfforts,
  prepareCompactGpsSegmentDefinitions
} from "../src/shared/CompactGpsSegmentMatcher.js";

test("browser GPS segment matcher preserves backend match offsets", () => {
  const points = Array.from({ length: 20 }, (_, slotIndex) => ({
    lat: 48,
    lng: 8 + slotIndex * 0.0001,
    slotIndex
  }));
  const segmentTrack = points.slice(4, 13).map(({ lat, lng }) => ({ lat, lng }));
  const bounds = { minLat: 48, maxLat: 48, minLng: 8, maxLng: 8.002 };
  const gpsTrack = {
    sampleRateSeconds: 5,
    bbox: bounds,
    segments: [points]
  };
  const definitions = [{ id: 7, distance: 400, bounds, track: segmentTrack }];
  const compactRecords = {
    recordCount: 100,
    powersW: new Uint16Array(100).fill(200),
    heartRatesBpm: new Uint8Array(100).fill(140),
    cadencesRpm: new Uint8Array(100).fill(90)
  };

  const backend = SegmentMatcher.findMatches({
    wid: 1,
    segments: [points],
    sampleRate: 5
  }, { id: 7, track: segmentTrack });
  const browser = benchmarkGpsSegmentBestEfforts(gpsTrack, definitions, compactRecords).matches;

  assert.deepEqual(
    browser.map(({ segmentId, startOffset, endOffset }) => ({ segmentId, startOffset, endOffset })),
    backend.map((match) => ({
      segmentId: match.segment_id,
      startOffset: match.start_offset,
      endOffset: match.end_offset
    }))
  );
  assert.equal(browser[0].avgPower, 200);
  assert.equal(browser[0].avgHeartRate, 140);
  assert.equal(browser[0].avgCadence, 90);
});

test("compact E5 GPS matcher preserves object matcher offsets across invalid slots", () => {
  const points = Array.from({ length: 20 }, (_, slotIndex) => ({
    lat: 48,
    lng: 8 + slotIndex * 0.0001,
    slotIndex: slotIndex >= 10 ? slotIndex + 3 : slotIndex
  }));
  const segmentTrack = points.slice(12, 19).map(({ lat, lng }) => ({ lat, lng }));
  const definitions = [{ id: 9, track: segmentTrack }];
  const compactTrack = {
    sampleRateGps: 5,
    latitudesE5: Int32Array.from(points, (point) => Math.round(point.lat * 100000)),
    longitudesE5: Int32Array.from(points, (point) => Math.round(point.lng * 100000)),
    slotIndices: Uint32Array.from(points, (point) => point.slotIndex)
  };

  const objectMatches = benchmarkGpsSegmentBestEfforts({
    sampleRateSeconds: 5,
    bbox: { minLat: 48, maxLat: 48, minLng: 8, maxLng: 8.002 },
    segments: [points.slice(0, 10), points.slice(10)]
  }, [{
    ...definitions[0],
    bounds: { minLat: 48, maxLat: 48, minLng: 8, maxLng: 8.002 }
  }]).matches;
  const compactMatches = matchCompactGpsSegmentBestEfforts(
    compactTrack,
    prepareCompactGpsSegmentDefinitions(definitions)
  ).matches;

  assert.deepEqual(compactMatches, objectMatches.map(({ segmentId, startOffset, endOffset }) => ({
    segmentId,
    startOffset,
    endOffset
  })));
});

test("GPS matchers interpolate endpoint times between five-second track samples", () => {
  const points = Array.from({ length: 12 }, (_, slotIndex) => ({
    lat: 48,
    lng: 8 + slotIndex * 0.0002,
    slotIndex
  }));
  const segmentTrack = [
    { lat: 48, lng: 8.00044 },
    { lat: 48, lng: 8.00152 }
  ];
  const bounds = { minLat: 48, maxLat: 48, minLng: 8, maxLng: 8.0022 };
  const definition = { id: 11, distance: 100, bounds, track: segmentTrack };

  const backend = SegmentMatcher.findMatches({
    wid: 2,
    segments: [points],
    sampleRate: 5
  }, { id: definition.id, track: segmentTrack });
  const browser = benchmarkGpsSegmentBestEfforts({
    sampleRateSeconds: 5,
    bbox: bounds,
    segments: [points]
  }, [definition]).matches;
  const compact = matchCompactGpsSegmentBestEfforts({
    sampleRateGps: 5,
    latitudesE5: Int32Array.from(points, (point) => Math.round(point.lat * 100000)),
    longitudesE5: Int32Array.from(points, (point) => Math.round(point.lng * 100000)),
    slotIndices: Uint32Array.from(points, (point) => point.slotIndex)
  }, prepareCompactGpsSegmentDefinitions([definition])).matches;

  assert.deepEqual(backend.map(({ start_offset, end_offset }) => ({ start_offset, end_offset })), [
    { start_offset: 11, end_offset: 38 }
  ]);
  assert.deepEqual(browser.map(({ startOffset, endOffset }) => ({ startOffset, endOffset })), [
    { startOffset: 11, endOffset: 38 }
  ]);
  assert.deepEqual(compact.map(({ startOffset, endOffset }) => ({ startOffset, endOffset })), [
    { startOffset: 11, endOffset: 38 }
  ]);
});

test("browser best efforts match on-demand after GPS and workout serialization", async () => {
  const { createWoa1FileFromCompactAsync } = await import("../src/public/js/woa-format-compact.js");
  const { default: GpsTrackBlobService } = await import("../src/services/gpsTrackBlobService.js");
  const { default: Workout } = await import("../src/shared/Workout.js");
  const { gzipSync } = await import("node:zlib");
  const { encodeBrowserGpsBestEffortsTransport, decodeBrowserGpsBestEffortsTransport } = await import(
    "../src/shared/BrowserGpsBestEffortsTransport.js"
  );
  const recordCount = 150;
  const records = {
    recordCount,
    baseTimestampSec: 1700000000,
    lastTimestampSec: 1700000149,
    powersW: Uint16Array.from({ length: recordCount }, (_, i) => i % 17 === 0 ? 0xffff : i * 4),
    heartRatesBpm: Uint8Array.from({ length: recordCount }, (_, i) => i % 19 === 0 ? 0xff : 90 + i % 90),
    cadencesRpm: Uint8Array.from({ length: recordCount }, (_, i) => i % 23 === 0 ? 0xff : 60 + i % 60),
    distancesQ: Uint32Array.from({ length: recordCount }, (_, i) => i * 10),
    speedsCmS: new Uint16Array(recordCount).fill(500),
    altitudesQ: new Int16Array(recordCount).fill(1200),
    positionLatsE6: new Int32Array(recordCount).fill(48000000),
    positionLongsE6: Int32Array.from({ length: recordCount }, (_, i) => 8000000 + i * 50)
  };
  const bounds = { minLat: 48, maxLat: 48, minLng: 8, maxLng: 8.01 };
  const definitions = [{ id: 11, distance: 400, bounds, track: [
    { lat: 48, lng: 8.00108 }, { lat: 48, lng: 8.00532 }
  ] }];
  for (const gpsCoordinateEncoding of ["bitmap-columnar", "int16-escape", "tiered-int8"]) {
    const woa = await createWoa1FileFromCompactAsync({ compactRecords: records, sessions: [] }, {
      sampleRateSeconds: 5, gpsCoordinateEncoding,
      streamCodec: "gzip", compressWorkoutStream: async (bytes) => gzipSync(bytes),
      compressGpsTrack: null
    });
    const browser = benchmarkGpsSegmentBestEfforts(woa.gpsTrack, definitions, records).matches;
    const compact = await GpsTrackBlobService.decodeCompressedCompact(woa.gpsTrackBytes, {
      codec: "identity", includeSlotIndices: true
    });
    const live = matchCompactGpsSegmentBestEfforts(compact, prepareCompactGpsSegmentDefinitions(definitions)).matches;
    assert.equal(browser.length, 1);
    assert.deepEqual(browser.map(({ segmentId, startOffset, endOffset }) => ({ segmentId, startOffset, endOffset })), live);
    const raw = await Workout.decompress(woa.workoutStreamBytes, "gzip");
    for (const match of browser) {
      const averages = Workout.getWst9RangeAverages(raw, match.startOffset, match.endOffset);
      assert.equal(match.avgPower, Math.round(averages.power));
      assert.equal(match.avgHeartRate, Math.round(averages.hr));
      assert.equal(match.avgCadence, Math.round(averages.cadence));
      assert.equal(match.avgSpeed, Math.round(400 * 3.6 / (match.endOffset - match.startOffset) * 10) / 10);
    }
    const transport = decodeBrowserGpsBestEffortsTransport(encodeBrowserGpsBestEffortsTransport([
      { startTimeSec: records.baseTimestampSec, matches: browser }
    ]));
    assert.deepEqual(transport.workouts[0].matches, browser);
  }
});
