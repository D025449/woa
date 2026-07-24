import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateNormalizedPowerFromSamples,
  calculatePowerLoad,
  resolveCyclingCalories
} from "../src/shared/WorkoutEnergy.js";

test("preserves recorded FIT calories", () => {
  assert.equal(resolveCyclingCalories({
    totalCalories: 812,
    avgPower: 200,
    totalTimerTime: 3_600
  }), 812);
});

test("derives missing cycling calories from average power and timer time", () => {
  assert.equal(resolveCyclingCalories({
    totalCalories: 0,
    avgPower: 200,
    totalTimerTime: 3_600
  }), 720);
});

test("does not derive calories without usable power and duration", () => {
  assert.equal(resolveCyclingCalories({
    totalCalories: null,
    avgPower: 0,
    totalTimerTime: 3_600
  }), 0);
  assert.equal(resolveCyclingCalories({
    totalCalories: null,
    avgPower: 200,
    totalTimerTime: 0
  }), 0);
});

test("calculates absolute power load with a fixed 200 watt reference", () => {
  assert.equal(calculatePowerLoad({
    normalizedPower: 200,
    totalTimerTime: 3_600
  }), 100);
  assert.equal(calculatePowerLoad({
    normalizedPower: 100,
    totalTimerTime: 7_200
  }), 50);
  assert.equal(calculatePowerLoad({
    normalizedPower: 400,
    totalTimerTime: 1_800
  }), 200);
});

test("does not calculate power load without normalized power and duration", () => {
  assert.equal(calculatePowerLoad({
    normalizedPower: 0,
    totalTimerTime: 3_600
  }), 0);
  assert.equal(calculatePowerLoad({
    normalizedPower: 200,
    totalTimerTime: 0
  }), 0);
});

test("calculates normalized power from one-second power samples", () => {
  assert.equal(
    calculateNormalizedPowerFromSamples(new Uint16Array(60).fill(200)),
    200
  );
});

test("normalized power reflects variable effort", () => {
  const powers = Uint16Array.from([
    ...new Array(30).fill(0),
    ...new Array(30).fill(400)
  ]);
  assert.ok(calculateNormalizedPowerFromSamples(powers) > 200);
});

test("normalized power treats compact missing values as zero", () => {
  const powers = new Uint16Array(30).fill(200);
  powers[0] = 0xFFFF;
  assert.equal(
    calculateNormalizedPowerFromSamples(powers, { missingValue: 0xFFFF }),
    193
  );
});
