import test from "node:test";
import assert from "node:assert/strict";

import { classifyWorkoutType } from "../src/shared/WorkoutTypeClassifier.js";

test("classifies a trainer workout without usable GPS as indoor", () => {
  assert.equal(classifyWorkoutType({
    validGps: false,
    totalDistance: 42_000,
    totalTimerTime: 3600,
    avgSpeed: 42,
    avgPower: 210,
    avgCadence: 88
  }), "indoor");
});

test("classifies stationary GPS noise as indoor", () => {
  assert.equal(classifyWorkoutType({
    validGps: true,
    bounds: { minLat: 49, maxLat: 49.0005, minLng: 8, maxLng: 8.0005 },
    totalDistance: 30_000,
    totalTimerTime: 3600,
    avgSpeed: 30,
    avgPower: 180
  }), "indoor");
});

test("classifies a fast outdoor ride as road", () => {
  assert.equal(classifyWorkoutType({
    validGps: true,
    bounds: { minLat: 48.8, maxLat: 49.2, minLng: 7.9, maxLng: 8.4 },
    totalDistance: 82_000,
    totalTimerTime: 9000,
    totalAscent: 900,
    avgSpeed: 32.8
  }), "road");
});

test("classifies a slow climb-heavy outdoor ride as mountain", () => {
  assert.equal(classifyWorkoutType({
    validGps: true,
    bounds: { minLat: 48.8, maxLat: 49.2, minLng: 7.9, maxLng: 8.4 },
    totalDistance: 35_000,
    totalTimerTime: 7000,
    totalAscent: 750,
    avgSpeed: 18
  }), "mountain");
});

test("keeps ambiguous and too-short workouts unknown", () => {
  assert.equal(classifyWorkoutType({
    validGps: true,
    bounds: { minLat: 48.8, maxLat: 49.2, minLng: 7.9, maxLng: 8.4 },
    totalDistance: 30_000,
    totalTimerTime: 5000,
    totalAscent: 300,
    avgSpeed: 19
  }), "unknown");
  assert.equal(classifyWorkoutType({
    validGps: false,
    totalDistance: 500,
    totalTimerTime: 120,
    avgPower: 200
  }), "unknown");
});
