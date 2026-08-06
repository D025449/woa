import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLogicalWorkoutChunkCollection,
  validateLogicalWorkoutChunkCollection,
  validateLogicalWorkoutChunkIndex
} from "../src/services/logicalWorkoutChunkFormat.js";

function descriptor(index, workoutCount) {
  return {
    index,
    workoutCount,
    key: `root/workouts/native/chunk-${index}.zip`,
    sizeBytes: 1234,
    sha256: "a".repeat(64)
  };
}

test("logical workout chunk index maps every workout to one declared chunk", () => {
  const collection = buildLogicalWorkoutChunkCollection([descriptor(0, 2), descriptor(1, 1)]);
  const chunks = validateLogicalWorkoutChunkCollection(collection, "native");
  const index = {
    workoutCount: 3,
    owners: [{ key: "owner-1" }],
    workouts: [
      [0, "2026-08-05T09:00:00.000Z", null, "10", 0],
      [0, "2026-08-05T10:00:00.000Z", null, "11", 0],
      [0, "2026-08-05T11:00:00.000Z", null, "12", 1]
    ]
  };

  assert.equal(validateLogicalWorkoutChunkIndex(index, chunks), index);
});

test("logical workout chunk index rejects count and mapping mismatches", () => {
  const chunks = validateLogicalWorkoutChunkCollection(
    buildLogicalWorkoutChunkCollection([descriptor(0, 2)]),
    "fit"
  );
  assert.throws(() => validateLogicalWorkoutChunkIndex({
    workoutCount: 1,
    owners: [{ key: "owner-1" }],
    workouts: [[0, null, "a".repeat(64), "10", 0]]
  }, chunks), /does not match chunk 0/u);
  assert.throws(() => validateLogicalWorkoutChunkIndex({
    workoutCount: 2,
    owners: [{ key: "owner-1" }],
    workouts: [[0, null, "a".repeat(64), "10", 0], [0, null, "b".repeat(64), "11", 4]]
  }, chunks), /invalid source or chunk mapping/u);
});
