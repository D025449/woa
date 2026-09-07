import assert from "node:assert/strict";
import test from "node:test";

import { buildSegmentComparisonProfile } from "../src/shared/SegmentComparison.js";

function workout({ distances, powers, heartRates }) {
  return {
    length: distances.length,
    getDistanceAt: (index) => distances[index],
    getPowerAt: (index) => powers[index],
    getHrAt: (index) => heartRates[index]
  };
}

test("segment comparison aligns workout metrics to the official segment distance", () => {
  const profile = buildSegmentComparisonProfile(workout({
    distances: [100, 110, 130, 160, 200],
    powers: [100, 200, 300, 400, 500],
    heartRates: [120, 125, 130, 135, 140]
  }), { wid: 42, start_offset: 1, end_offset: 4 }, 900);

  assert.equal(profile.alignment, "distance");
  assert.deepEqual(profile.points, [
    { distanceKm: 0, elapsedSeconds: 0, power: 200, heartRate: 125 },
    { distanceKm: 0.2, elapsedSeconds: 1, power: 300, heartRate: 130 },
    { distanceKm: 0.5, elapsedSeconds: 2, power: 400, heartRate: 135 },
    { distanceKm: 0.9, elapsedSeconds: 3, power: 500, heartRate: 140 }
  ]);
});

test("segment comparison falls back to elapsed progress and keeps the endpoint", () => {
  const profile = buildSegmentComparisonProfile(workout({
    distances: [0, 0, 0, 0, 0, 0],
    powers: [100, 110, 120, 130, 140, 150],
    heartRates: [120, 121, 122, 123, 124, 125]
  }), { wid: 7, start_offset: 0, end_offset: 5 }, 1000, { maxPoints: 3 });

  assert.equal(profile.alignment, "progress");
  assert.deepEqual(profile.points.map((point) => point.distanceKm), [0, 0.6, 1]);
  assert.equal(profile.points.length, 3);
  assert.equal(profile.points.at(-1).power, 150);
});

test("segment comparison preserves missing sensor values as chart gaps", () => {
  const profile = buildSegmentComparisonProfile(workout({
    distances: [100, 150, 200],
    powers: [250, null, 275],
    heartRates: [null, 145, Number.NaN]
  }), { wid: 9, start_offset: 0, end_offset: 2 }, 100);

  assert.deepEqual(profile.points.map(({ power, heartRate }) => ({ power, heartRate })), [
    { power: 250, heartRate: null },
    { power: null, heartRate: 145 },
    { power: 275, heartRate: null }
  ]);
});
