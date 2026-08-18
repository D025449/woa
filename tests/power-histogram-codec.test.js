import assert from "node:assert/strict";
import test from "node:test";

import {
  decodePowerHistogram,
  encodePowerHistogram
} from "../src/shared/PowerHistogramCodec.js";

test("power histogram stores only occupied five-watt bins", () => {
  const powers = Uint16Array.from([0, 100, 104, 500, 1000, 1002, 0xffff]);
  const encoded = encodePowerHistogram({ powers });
  const decoded = decodePowerHistogram(encoded);

  assert.equal(decoded.binWidthWatts, 5);
  assert.equal(decoded.zeroSeconds, 1);
  assert.equal(decoded.missingSeconds, 1);
  assert.deepEqual(decoded.bins, [
    { binIndex: 19, minWatts: 96, maxWatts: 100, seconds: 1 },
    { binIndex: 20, minWatts: 101, maxWatts: 105, seconds: 1 },
    { binIndex: 99, minWatts: 496, maxWatts: 500, seconds: 1 },
    { binIndex: 199, minWatts: 996, maxWatts: 1000, seconds: 1 },
    { binIndex: 200, minWatts: 1001, maxWatts: 1005, seconds: 1 }
  ]);
  assert.ok(encoded.byteLength < 30);
});

test("power histogram remains absent when no positive power exists", () => {
  assert.equal(encodePowerHistogram({ powers: Uint16Array.from([0, 0, 0xffff]) }), null);
});

test("power histogram rejects corrupt duration totals", () => {
  const encoded = encodePowerHistogram({ powers: Uint16Array.from([100, 100]) });
  encoded[5] = 3;
  assert.throws(() => decodePowerHistogram(encoded), /duration totals/u);
});
