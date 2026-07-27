import assert from "node:assert/strict";
import test from "node:test";

import { computeElevationTotalsFromTrack } from "../src/shared/ElevationTotals.js";
import WorkoutDBService from "../src/services/workoutDBService.js";

const METERS_PER_LATITUDE_DEGREE = 111_320;

function buildTrack({
  distanceMeters,
  stepMeters,
  elevationAt
}) {
  const track = [];
  for (let distance = 0; distance <= distanceMeters; distance += stepMeters) {
    track.push({
      lat: distance / METERS_PER_LATITUDE_DEGREE,
      lng: 0,
      ele: elevationAt(distance)
    });
  }
  return track;
}

test("distance-smoothed elevation totals suppress model noise without losing a climb", () => {
  const distanceMeters = 20_000;
  const track = buildTrack({
    distanceMeters,
    stepMeters: 25,
    elevationAt: (distance) => {
      const mountain = distance <= distanceMeters / 2
        ? 500 + distance / 10
        : 1_500 - (distance - distanceMeters / 2) / 10;
      const modelNoise = Math.sin(distance / 35) * 12;
      return mountain + modelNoise;
    }
  });

  const totals = computeElevationTotalsFromTrack(track);

  assert.ok(totals.totalAscent >= 950 && totals.totalAscent <= 1_050);
  assert.ok(totals.totalDescent >= 950 && totals.totalDescent <= 1_050);
});

test("elevation totals are independent of source point density", () => {
  const options = {
    distanceMeters: 12_000,
    elevationAt: (distance) => (
      400
      + Math.sin((distance / 12_000) * Math.PI * 4) * 180
      + Math.sin(distance / 30) * 8
    )
  };

  const sparse = computeElevationTotalsFromTrack(buildTrack({
    ...options,
    stepMeters: 50
  }));
  const dense = computeElevationTotalsFromTrack(buildTrack({
    ...options,
    stepMeters: 5
  }));

  assert.ok(Math.abs(sparse.totalAscent - dense.totalAscent) <= 5);
  assert.ok(Math.abs(sparse.totalDescent - dense.totalDescent) <= 5);
});

test("manual GPS preserves a recorded barometric altitude series", () => {
  const barometricWorkout = {
    length: 4,
    getAltitudeAt: (index) => [612.4, 613.1, 614.8, 614.2][index]
  };
  const missingAltitudeWorkout = {
    length: 4,
    getAltitudeAt: () => 0
  };

  assert.equal(WorkoutDBService.hasRecordedAltitudeSeries(barometricWorkout), true);
  assert.equal(WorkoutDBService.hasRecordedAltitudeSeries(missingAltitudeWorkout), false);
});
