import assert from "node:assert/strict";
import test from "node:test";

import SegmentMatcher from "../src/services/SegmentMatcher.js";

test("null sample offsets fall back to GPS slot progress", () => {
  assert.equal(SegmentMatcher.getPointProgress({ sampleOffset: null, slotIndex: 831 }), 831);
});

test("segment matching preserves slot progress when sample offsets are absent", () => {
  const workout = {
    wid: 42,
    sampleRate: 5,
    segments: [[
      { lat: 50, lng: 8, slotIndex: 100 },
      { lat: 50, lng: 8.001, slotIndex: 101 },
      { lat: 50, lng: 8.002, slotIndex: 102 },
      { lat: 50, lng: 8.003, slotIndex: 103 }
    ]]
  };
  const segment = {
    id: 7,
    track: [
      { lat: 50, lng: 8.0002 },
      { lat: 50, lng: 8.0028 }
    ]
  };

  const matches = SegmentMatcher.findMatches(workout, segment);

  assert.equal(matches.length, 1);
  assert.equal(matches[0].workout_id, 42);
  assert.equal(matches[0].segment_id, 7);
  assert.ok(matches[0].start_offset >= 500);
  assert.ok(matches[0].end_offset > matches[0].start_offset);
});

test("object callers use exactly the E5 matcher even at rounding boundaries", async () => {
  const { matchCompactGpsSegmentBestEfforts, prepareCompactGpsSegmentDefinitions, toCompactGpsTrack } = await import(
    "../src/shared/CompactGpsSegmentMatcher.js"
  );
  let seed = 7;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let run = 0; run < 30; run += 1) {
    const points = Array.from({ length: 40 }, (_, slotIndex) => ({
      lat: 48 + Math.round((random() - 0.5) * 10) / 1e5,
      lng: 8 + slotIndex * 0.0001,
      slotIndex
    }));
    const segment = { id: 11, track: [
      { lat: 48, lng: 8.0005 + random() * 0.0001 },
      { lat: 48, lng: 8.0025 + random() * 0.0001 }
    ] };
    const expected = matchCompactGpsSegmentBestEfforts(
      toCompactGpsTrack({ segments: [points], sampleRateSeconds: 5 }),
      prepareCompactGpsSegmentDefinitions([segment])
    ).matches;
    assert.deepEqual(
      SegmentMatcher.findMatches({ wid: 42, segments: [points], sampleRate: 5 }, segment),
      expected.map((match) => ({ workout_id: 42, segment_id: 11, start_offset: match.startOffset, end_offset: match.endOffset }))
    );
  }
});

test("single-segment scan delegates options to the shared bulk scan", async () => {
  const { default: Service } = await import("../src/services/segmentDBService.js");
  const original = Service.scanWorkoutsForSegments;
  const result = { matches: [], profile: { matcherMode: "compact-e5" } };
  const options = { includeProfile: true, includeExistingBestEfforts: true };
  Service.scanWorkoutsForSegments = async (uid, ids, receivedOptions) => {
    assert.equal(uid, 49);
    assert.deepEqual(ids, [11]);
    assert.equal(receivedOptions, options);
    return result;
  };
  try {
    assert.equal(await Service.scanWorkoutsForSegment(49, { id: 11 }, options), result);
  } finally {
    Service.scanWorkoutsForSegments = original;
  }
});
