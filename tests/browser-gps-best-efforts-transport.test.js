import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeBrowserGpsBestEffortsTransport,
  encodeBrowserGpsBestEffortsTransport
} from "../src/shared/BrowserGpsBestEffortsTransport.js";

test("round-trips compact GBE1 rows in columnar layout", () => {
  const bytes = encodeBrowserGpsBestEffortsTransport([
    {
      startTimeSec: 1_700_000_000,
      matches: [{ segmentId: 42, startOffset: 100, endOffset: 140, avgPower: 250, avgHeartRate: 150, avgCadence: 90, avgSpeed: 36.4 }]
    },
    { startTimeSec: 1_700_000_100, matches: [] }
  ]);
  assert.equal(bytes.byteLength, 24 + 2 * 12 + 18);
  assert.deepEqual(decodeBrowserGpsBestEffortsTransport(bytes), {
    version: 1,
    workoutCount: 2,
    matchCount: 1,
    byteLength: bytes.byteLength,
    workouts: [
      {
        startTimeSec: 1_700_000_000,
        matches: [{ segmentId: 42, startOffset: 100, endOffset: 140, avgPower: 250, avgHeartRate: 150, avgCadence: 90, avgSpeed: 36.4 }]
      },
      { startTimeSec: 1_700_000_100, matches: [] }
    ]
  });
});

test("rejects corrupt GBE1 lengths", () => {
  const bytes = encodeBrowserGpsBestEffortsTransport([{ startTimeSec: 1_700_000_000, matches: [] }]);
  assert.throws(() => decodeBrowserGpsBestEffortsTransport(bytes.subarray(0, -1)), /layout/);
});
