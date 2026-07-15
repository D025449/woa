import assert from "node:assert/strict";
import test from "node:test";

import { groupSegmentPersistenceItems } from "../src/services/segment-persistence-batches.js";

test("segment persistence groups database recomputes into fixed-size batches", () => {
  const items = Array.from({ length: 2168 }, (_, index) => ({
    uid: 49,
    workoutId: 1000 + index,
    recomputeFromDb: true,
    importJobId: "374"
  }));

  const groups = groupSegmentPersistenceItems(items, 100);

  assert.equal(groups.length, 22);
  assert.deepEqual(groups.map((group) => group.items.length), [
    ...Array(21).fill(100),
    68
  ]);
  assert.ok(groups.every((group) => group.type === "batch"));
});

test("payload-backed persistence remains an individual job", () => {
  const groups = groupSegmentPersistenceItems([
    { uid: 49, workoutId: 1, recomputeFromDb: true, importJobId: "374" },
    { uid: 49, workoutId: 2, payloadPath: "/tmp/segments.json", importJobId: "374" },
    { uid: 49, workoutId: 3, recomputeFromDb: true, importJobId: "374" }
  ], 100);

  assert.deepEqual(groups.map((group) => group.type), ["batch", "single", "batch"]);
});
