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
