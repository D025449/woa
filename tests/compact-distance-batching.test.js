import assert from "node:assert/strict";
import test from "node:test";

import {
  correctCompactDistanceBatchingInPlace,
  repairCompactSentinelPowerCorruptionInPlace,
  trimCompactCorruptTerminalTail
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

function buildTerminalPowerRecords({ corrupt = true } = {}) {
  const normalPower = [240, 250, 245, 255, 260, 268];
  const normalCadence = [92, 94, 93, 95, 96, 96];
  const tailPower = corrupt
    ? [636, 1000, 1432, 1284, 1456, 1520, 900, 460, 20, 1136, 736, 1600, 1784, 1700, 1788, 1800, 0, 0, 0, 0, 0]
    : [650, 900, 1100, 950, 700, 500, 300, 180, 80, 0, 0, 0];
  const tailCadence = corrupt
    ? [148, 148, 148, 148, 148, 148, 160, 96, 32, 32, 152, 152, 152, 152, 152, 152, 0, 0, 0, 0, 0]
    : [125, 130, 135, 130, 120, 110, 100, 90, 70, 0, 0, 0];
  const count = normalPower.length + tailPower.length;
  const speeds = corrupt
    ? [900, 920, 940, 950, 960, 970, 1000, 1500, 1400, 1500, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
    : Array.from({ length: count }, (_, index) => index >= count - 3 ? 0 : 1000);
  const heartRates = corrupt
    ? [130, 130, 131, 131, 132, 132, 132, 132, 132, 132, 132, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
    : Array.from({ length: count }, (_, index) => index >= count - 3 ? 0 : 150);
  return {
    recordCount: count,
    lastTimestampSec: 1000 + count - 1,
    distancesQ: Uint32Array.from({ length: count }, (_, index) => 1000 + (index * 10)),
    powersW: Uint16Array.from([...normalPower, ...tailPower]),
    cadencesRpm: Uint8Array.from([...normalCadence, ...tailCadence]),
    heartRatesBpm: Uint8Array.from(heartRates),
    speedsCmS: Uint16Array.from(speeds)
  };
}

test("trims a corrupt high-power block at the end of a FIT activity", () => {
  const compact = buildTerminalPowerRecords();

  trimCompactCorruptTerminalTail(compact);

  assert.equal(compact.recordCount, 6);
  assert.deepEqual(Array.from(compact.powersW), [240, 250, 245, 255, 260, 268]);
  assert.equal(compact.terminalCorruptionTrimStats.trimmedRecordCount, 21);
  assert.equal(compact.lastTimestampSec, 1005);
});

test("keeps a plausible finish sprint followed by stopped samples", () => {
  const compact = buildTerminalPowerRecords({ corrupt: false });

  trimCompactCorruptTerminalTail(compact);

  assert.equal(compact.recordCount, 18);
  assert.equal(compact.terminalCorruptionTrimStats, undefined);
});

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

test("repairs speed and excess distance around a sentinel power window", () => {
  const compact = buildCompactRecords(
    [23934, 23956, 23978, 24000, 24022, 24038, 24086, 24136, 24184, 24198, 24212],
    [1222, 1222, 1222, 1092, 841, 2426, 2426, 2426, 676, 736, 736]
  );

  const stats = repairCompactSentinelPowerCorruptionInPlace(compact, [{
    start: 5,
    end: 7,
    peakPower: 4092,
    sentinel: true
  }]);

  assert.deepEqual(Array.from(compact.speedsCmS.slice(4, 9)), [1033, 973, 914, 855, 795]);
  assert.deepEqual(Array.from(compact.distancesQ.slice(3, 10)), [24000, 24021, 24040, 24058, 24076, 24091, 24105]);
  assert.deepEqual(stats, {
    correctedWindows: 1,
    correctedSpeedSamples: 5,
    removedDistanceUnits: 93
  });
});

test("does not rewrite plausible speed around an isolated sentinel power value", () => {
  const originalDistances = [100, 120, 140, 160, 180, 200, 220];
  const originalSpeeds = [1000, 1000, 1000, 1000, 1000, 1000, 1000];
  const compact = buildCompactRecords(originalDistances, originalSpeeds);

  const stats = repairCompactSentinelPowerCorruptionInPlace(compact, [{
    start: 3,
    end: 3,
    peakPower: 4095,
    sentinel: true
  }]);

  assert.deepEqual(Array.from(compact.distancesQ), originalDistances);
  assert.deepEqual(Array.from(compact.speedsCmS), originalSpeeds);
  assert.equal(stats.correctedWindows, 0);
});
