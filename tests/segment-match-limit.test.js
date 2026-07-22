import assert from "node:assert/strict";
import test from "node:test";

import SegmentDBService from "../src/services/segmentDBService.js";

test("segment match limiting keeps the fastest efforts deterministically", () => {
  const matches = [
    { workout_id: 3, start_offset: 10, end_offset: 40 },
    { workout_id: 2, start_offset: 10, end_offset: 25 },
    { workout_id: 1, start_offset: 20, end_offset: 35 },
    { workout_id: 4, start_offset: 10, end_offset: 50 }
  ];

  SegmentDBService.keepFastestSegmentMatches(matches, 2);

  assert.deepEqual(matches, [
    { workout_id: 1, start_offset: 20, end_offset: 35 },
    { workout_id: 2, start_offset: 10, end_offset: 25 }
  ]);
});
