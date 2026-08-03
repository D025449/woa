import assert from "node:assert/strict";
import test from "node:test";

import Workout from "../src/shared/Workout.js";

test("typed workout materialization preserves missing altitude values", () => {
  const workout = Workout.fromTypedArrays({
    timestampsMs: new Float64Array([1_000, 2_000]),
    powersW: new Float64Array([100, 110]),
    heartRatesBpm: new Float64Array([120, 121]),
    cadencesRpm: new Float64Array([80, 81]),
    speedsMps: new Float64Array([5, 5]),
    altitudesM: new Float64Array([Number.NaN, Number.NaN])
  });

  assert.equal(Number.isNaN(workout.getAltitudeAt(0)), true);
  assert.equal(Number.isNaN(workout.getAltitudeAt(1)), true);
  assert.equal(workout.elevationGainTotal, 0);
});
