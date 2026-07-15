import assert from "node:assert/strict";
import test from "node:test";

import { groupWorkoutSegmentBestEffortItems } from "../src/services/segment-best-efforts-batches.js";

test("segment best-effort items are grouped into import-scoped batches", () => {
  const items = Array.from({ length: 958 }, (_, index) => ({
    uid: 49,
    workoutId: 1000 + index,
    importJobId: "377"
  }));
  const groups = groupWorkoutSegmentBestEffortItems(items, 100);
  assert.equal(groups.length, 10);
  assert.deepEqual(groups.map((group) => group.length), [...Array(9).fill(100), 58]);
});

test("segment best-effort batches do not cross import scope", () => {
  const groups = groupWorkoutSegmentBestEffortItems([
    { uid: 49, workoutId: 1, importJobId: "377" },
    { uid: 49, workoutId: 2, importJobId: "378" }
  ], 100);
  assert.deepEqual(groups.map((group) => group.map((item) => item.workoutId)), [[1], [2]]);
});
