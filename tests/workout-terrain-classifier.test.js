import assert from "node:assert/strict";
import test from "node:test";

import { classifyTerrainProfile } from "../src/shared/WorkoutTerrainClassifier.js";

function series(length, altitudeAt, speedMetersPerSecond = 8) {
  return {
    altitudes: Float32Array.from({ length }, (_, index) => altitudeAt(index)),
    distances: Float32Array.from({ length }, (_, index) => index * speedMetersPerSecond)
  };
}

test("classifies incomplete altitude as missing", () => {
  const data = series(600, () => Number.NaN);
  assert.equal(classifyTerrainProfile(data), "altitude_missing");
});

test("classifies implausible one-second altitude jumps as invalid", () => {
  const data = series(600, (index) => index < 300 ? 500 : 530);
  assert.equal(classifyTerrainProfile(data), "altitude_invalid");
});

test("keeps gradients below two percent flat", () => {
  const data = series(1200, (index) => 400 + index * 8 * 0.015);
  assert.equal(classifyTerrainProfile(data), "flat");
});

test("classifies a sustained climb as mountainous", () => {
  const data = series(1200, (index) => 300 + index * 5 * 0.05, 5);
  assert.equal(classifyTerrainProfile(data), "mountainous");
});

test("supports compact quarter-meter altitude and half-meter distance units", () => {
  const data = series(1200, (index) => 300 + index * 5 * 0.05, 5);
  assert.equal(classifyTerrainProfile({
    altitudes: Int16Array.from(data.altitudes, (value) => Math.round(value * 4)),
    distances: Uint32Array.from(data.distances, (value) => Math.round(value * 2)),
    altitudeScale: 0.25,
    distanceScale: 0.5
  }), "mountainous");
});

test("classifies repeated short climbs as rolling", () => {
  const data = series(1400, (index) => {
    const cycle = index % 300;
    return 400 + (cycle < 120 ? cycle * 0.25 : Math.max(0, 30 - (cycle - 120) / 6));
  }, 6);
  assert.equal(classifyTerrainProfile(data), "rolling");
});
