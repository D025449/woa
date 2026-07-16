import assert from "node:assert/strict";
import test from "node:test";
import SegmentMatcher from "../src/services/SegmentMatcher.js";
import { benchmarkGpsSegmentBestEfforts } from "../src/shared/BrowserGpsSegmentMatcher.js";

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
