import assert from "node:assert/strict";
import test from "node:test";

import {
  correctCompactDistanceBatchingInPlace
} from "../src/public/js/fit-import-compact-browser.js";

function buildCompactRecords(distancesQ, speedsCmS) {
  return {
    recordCount: distancesQ.length,
    distancesQ: Uint32Array.from(distancesQ),
    speedsCmS: Uint16Array.from(speedsCmS)
  };
}

function assertPreservedAnchors(original, corrected) {
  assert.equal(corrected[0], original[0]);
  assert.equal(corrected.at(-1), original.at(-1));
  for (let index = 1; index < corrected.length; index += 1) {
    assert.ok(corrected[index] >= corrected[index - 1]);
  }
}

test("redistributes a delayed distance batch from FIT speed", () => {
  const original = [100, 109, 109, 127, 136];
  const compact = buildCompactRecords(original, [0, 450, 450, 450, 450]);

  correctCompactDistanceBatchingInPlace(compact);

  assert.deepEqual(Array.from(compact.distancesQ), [100, 109, 118, 127, 136]);
  assert.equal(compact.distanceBatchingCorrectionStats.correctedWindows, 1);
  assert.equal(compact.distanceBatchingCorrectionStats.mode, "fit-speed-assisted");
});

test("repairs a distance batch that arrives before the zero interval", () => {
  const original = [100, 109, 127, 127, 136];
  const compact = buildCompactRecords(original, [0, 450, 450, 450, 450]);

  correctCompactDistanceBatchingInPlace(compact);

  assert.deepEqual(Array.from(compact.distancesQ), [100, 109, 118, 127, 136]);
  assertPreservedAnchors(original, Array.from(compact.distancesQ));
});

test("repairs a multi-second delayed batch while preserving total distance", () => {
  const original = [100, 109, 109, 109, 136, 145];
  const compact = buildCompactRecords(original, [0, 450, 450, 450, 450, 450]);

  correctCompactDistanceBatchingInPlace(compact);

  assert.deepEqual(Array.from(compact.distancesQ), [100, 109, 118, 127, 136, 145]);
  assertPreservedAnchors(original, Array.from(compact.distancesQ));
});

test("uses the FIT speed shape instead of distributing uniformly", () => {
  const original = [100, 110, 110, 130, 140];
  const compact = buildCompactRecords(original, [0, 500, 400, 600, 500]);

  correctCompactDistanceBatchingInPlace(compact);

  assert.deepEqual(Array.from(compact.distancesQ), [100, 110, 118, 130, 140]);
});

test("repairs adjacent overlapping distance batches independently", () => {
  const original = [100, 109, 109, 127, 127, 144, 153];
  const compact = buildCompactRecords(
    original,
    [0, 450, 450, 450, 450, 450, 450]
  );

  correctCompactDistanceBatchingInPlace(compact);

  assert.deepEqual(
    Array.from(compact.distancesQ),
    [100, 109, 118, 127, 136, 144, 153]
  );
  assertPreservedAnchors(original, Array.from(compact.distancesQ));
});

test("repairs a pair within sub-meter FIT distance tolerance", () => {
  const original = [100, 109, 109, 128, 137];
  const compact = buildCompactRecords(
    original,
    [0, 450, 424, 455, 450]
  );

  correctCompactDistanceBatchingInPlace(compact);

  assert.deepEqual(Array.from(compact.distancesQ), [100, 109, 118, 128, 137]);
  assertPreservedAnchors(original, Array.from(compact.distancesQ));
});

test("preserves a real stop when FIT speed also reports zero", () => {
  const original = [100, 109, 109, 109, 118];
  const compact = buildCompactRecords(original, [0, 450, 0, 0, 450]);

  correctCompactDistanceBatchingInPlace(compact);

  assert.deepEqual(Array.from(compact.distancesQ), original);
  assert.equal(compact.distanceBatchingCorrectionStats.correctedWindows, 0);
});

test("preserves an unmatched distance dropout without a local catch-up", () => {
  const original = [100, 109, 109, 118, 127];
  const compact = buildCompactRecords(original, [0, 450, 450, 450, 450]);

  correctCompactDistanceBatchingInPlace(compact);

  assert.deepEqual(Array.from(compact.distancesQ), original);
});

test("does not use missing FIT speed as evidence", () => {
  const original = [100, 109, 109, 127, 136];
  const compact = buildCompactRecords(original, [0, 450, 0xffff, 0xffff, 450]);

  correctCompactDistanceBatchingInPlace(compact);

  assert.deepEqual(Array.from(compact.distancesQ), original);
});

test("falls back to distance-only batching repair when FIT has no speed series", () => {
  const original = [100, 109, 109, 127, 136];
  const compact = buildCompactRecords(
    original,
    [0xffff, 0xffff, 0xffff, 0xffff, 0xffff]
  );

  correctCompactDistanceBatchingInPlace(compact);

  assert.deepEqual(Array.from(compact.distancesQ), [100, 109, 118, 127, 136]);
  assert.equal(compact.distanceBatchingCorrectionStats.correctedWindows, 1);
  assert.equal(compact.distanceBatchingCorrectionStats.mode, "distance-only-fallback");
});

test("repairs batching at five km/h but ignores slower movement", () => {
  const repairable = buildCompactRecords(
    [100, 103, 103, 109, 112],
    [0, 139, 139, 139, 139]
  );
  const belowThreshold = buildCompactRecords(
    [100, 103, 103, 109, 112],
    [0, 130, 130, 130, 130]
  );

  correctCompactDistanceBatchingInPlace(repairable);
  correctCompactDistanceBatchingInPlace(belowThreshold);

  assert.deepEqual(Array.from(repairable.distancesQ), [100, 103, 106, 109, 112]);
  assert.deepEqual(Array.from(belowThreshold.distancesQ), [100, 103, 103, 109, 112]);
});

test("does not spread an extreme unmatched jump across neighboring intervals", () => {
  const original = [1000, 1010, 1010, 1574, 1574, 1585, 1601];
  const compact = buildCompactRecords(
    original,
    [0, 500, 500, 500, 500, 500, 500]
  );

  correctCompactDistanceBatchingInPlace(compact);

  assert.deepEqual(Array.from(compact.distancesQ), original);
  assert.equal(compact.distanceBatchingCorrectionStats.correctedWindows, 0);
});
