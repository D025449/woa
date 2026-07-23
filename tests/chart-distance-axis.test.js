import assert from "node:assert/strict";
import test from "node:test";

import { hasMeaningfulDistanceSeries } from "../src/public/js/chart-view.js";

function distanceWorkout(distances) {
  return {
    length: distances.length,
    hasDistanceSeries: () => true,
    getDistanceAt: (index) => distances[index]
  };
}

test("distance axis rejects an all-zero distance column", () => {
  assert.equal(hasMeaningfulDistanceSeries(distanceWorkout([0, 0, 0])), false);
});

test("distance axis rejects a negligible rounded distance span", () => {
  assert.equal(hasMeaningfulDistanceSeries(distanceWorkout([0, 25, 99])), false);
});

test("distance axis accepts a meaningful distance span", () => {
  assert.equal(hasMeaningfulDistanceSeries(distanceWorkout([12, 60, 112])), true);
});

test("distance axis requires an actual distance series", () => {
  assert.equal(hasMeaningfulDistanceSeries({
    length: 3,
    hasDistanceSeries: () => false,
    getDistanceAt: () => 1_000
  }), false);
});
