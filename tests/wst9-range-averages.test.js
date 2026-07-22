import assert from "node:assert/strict";
import test from "node:test";

import Workout from "../src/shared/Workout.js";
import { buildWorkoutStreamBlockCompactDelta8Q4PowerDistanceUint8Q02RleDeltaQ1m } from "../src/public/js/woa-format-compact.js";

test("direct WST9 range averages match fully materialized workouts", () => {
  const recordCount = 420;
  const compactRecords = {
    recordCount,
    baseTimestampSec: 1_700_000_000,
    distancesQ: Uint32Array.from({ length: recordCount }, (_, index) => index * 16),
    powersW: Uint16Array.from({ length: recordCount }, (_, index) => (
      index % 89 === 0 ? 0xffff : index % 73 === 0 ? 900 : 180 + ((index % 17) * 4)
    )),
    heartRatesBpm: Uint8Array.from({ length: recordCount }, (_, index) => (
      index % 67 === 0 ? 0xff : 120 + Math.floor(index / 25) % 35
    )),
    cadencesRpm: Uint8Array.from({ length: recordCount }, (_, index) => (
      index % 53 === 0 ? 0xff : index % 41 === 0 ? 0 : 78 + Math.floor(index / 18) % 12
    )),
    speedsCmS: new Uint16Array(recordCount).fill(800),
    altitudesQ: Int16Array.from({ length: recordCount }, (_, index) => 3000 + (index % 40))
  };
  const wst9 = buildWorkoutStreamBlockCompactDelta8Q4PowerDistanceUint8Q02RleDeltaQ1m(
    compactRecords
  ).bytes;
  const materialized = Workout.fromBuffer(wst9);

  for (const [start, end] of [[0, 10], [17, 211], [100, 419], [12.25, 200.75]]) {
    const expected = materialized.getAverages(start, end);
    const actual = Workout.getWst9RangeAverages(wst9, start, end);
    assert.ok(Math.abs(actual.power - expected.power) < 1e-9);
    assert.ok(Math.abs(actual.hr - expected.hr) < 1e-9);
    assert.ok(Math.abs(actual.cadence - expected.cadence) < 1e-9);
  }
});
