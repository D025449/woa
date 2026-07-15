import assert from "node:assert/strict";
import test from "node:test";

import { groupWorkoutSimilarityItems } from "../src/services/workout-similarity-batches.js";

test("similarity items are grouped into import-scoped fixed-size batches", () => {
  const items = Array.from({ length: 958 }, (_, index) => ({
    uid: 49,
    workoutId: 1000 + index,
    importJobId: "375"
  }));

  const groups = groupWorkoutSimilarityItems(items, 100);

  assert.equal(groups.length, 10);
  assert.deepEqual(groups.map((group) => group.length), [
    ...Array(9).fill(100),
    58
  ]);
});

test("similarity batches never mix users or imports", () => {
  const groups = groupWorkoutSimilarityItems([
    { uid: 49, workoutId: 1, importJobId: "375" },
    { uid: 49, workoutId: 2, importJobId: "376" },
    { uid: 50, workoutId: 3, importJobId: "376" }
  ], 100);

  assert.deepEqual(groups.map((group) => group.map((item) => item.workoutId)), [[1], [2], [3]]);
});
