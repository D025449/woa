import assert from "node:assert/strict";
import test from "node:test";

import { FileDBService } from "../src/services/fileDBService.js";

test("segment persistence builds batch columns without per-workout temporary arrays", () => {
  const firstSegments = [
    {
      rowstate: "CRE",
      start_offset: 10,
      end_offset: 20,
      segmenttype: "auto",
      duration: 10,
      avg_power: 200,
      avg_heart_rate: 150,
      avg_cadence: 90,
      avg_speed: 36,
      altimeters: 12,
      segmentname: "A"
    },
    { rowstate: "DEL" }
  ];
  const secondSegments = [{
    rowstate: "CRE",
    start_offset: 30,
    end_offset: 40,
    segmenttype: "crit",
    duration: 10,
    avg_power: 300,
    avg_heart_rate: 160,
    avg_cadence: 95,
    avg_speed: 40,
    altimeters: 15,
    segmentname: null
  }];

  const actual = FileDBService.buildSegmentsForWorkoutsBulkArrays(49, [
    { workoutId: 101, segments: firstSegments },
    { workoutId: 102, segments: secondSegments }
  ]);
  const first = FileDBService.buildSegmentBulkArrays(49, 101, [firstSegments[0]]);
  const second = FileDBService.buildSegmentBulkArrays(49, 102, secondSegments);
  const expectedValues = first.values.map((column, index) => [
    ...column,
    ...second.values[index]
  ]);

  assert.equal(actual.segmentCount, 2);
  assert.deepEqual(actual.values, expectedValues);
});
