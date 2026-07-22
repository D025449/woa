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
