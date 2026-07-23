import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyFitWorkoutType,
  classifyWorkoutType,
  classifyWorkoutTypeWithFitFallback
} from "../src/shared/WorkoutTypeClassifier.js";

test("classifies a short trainer workout without usable GPS as indoor", () => {
  assert.equal(classifyWorkoutType({
    validGps: false,
    totalDistance: 0,
    totalTimerTime: 3600,
    avgPower: 210,
    avgCadence: 88
  }), "indoor");
});

test("classifies a fast long workout without GPS as road", () => {
  assert.equal(classifyWorkoutType({
    validGps: false,
    totalDistance: 42_000,
    totalTimerTime: 3600,
    avgSpeed: 42,
    avgPower: 210,
    avgCadence: 88
  }), "road");
});

test("classifies a no-GPS ride from intact distance periods after a sensor dropout", () => {
  assert.equal(classifyWorkoutType({
    validGps: false,
    totalDistance: 31_277,
    totalTimerTime: 6001,
    avgSpeed: 18.756,
    avgPower: 287,
    avgCadence: 86,
    distanceStallActiveRatio: 0.473,
    longestActiveDistanceStallSeconds: 446,
    movingSpeedKmh: 37.1
  }), "road");
});

test("classifies a road ride with distributed speed-sensor dropouts", () => {
  assert.equal(classifyWorkoutType({
    validGps: false,
    totalDistance: 27_197,
    totalTimerTime: 5042,
    avgSpeed: 19.44,
    avgPower: 205,
    avgCadence: 70,
    distanceStallActiveRatio: 0.151,
    longestActiveDistanceStallSeconds: 164,
    movingSpeedKmh: 23.84
  }), "road");
});

test("does not use short or sparse distance stalls for road classification", () => {
  assert.equal(classifyWorkoutType({
    validGps: false,
    totalDistance: 31_277,
    totalTimerTime: 6001,
    avgSpeed: 18.756,
    avgPower: 287,
    avgCadence: 86,
    distanceStallActiveRatio: 0.1,
    longestActiveDistanceStallSeconds: 30,
    movingSpeedKmh: 37.1
  }), "unknown");
});

test("classifies a sustained alpine climb followed by a road descent", () => {
  assert.equal(classifyWorkoutType({
    validGps: false,
    totalDistance: 29_116,
    totalTimerTime: 6065,
    avgSpeed: 17.28,
    avgPower: 212,
    avgCadence: 54,
    roadClimbMinutes: 75,
    longestRoadClimbMinutes: 41,
    roadDescentMinutes: 16,
    longestRoadDescentMinutes: 8,
    roadClimbBeforeDescent: true
  }), "road");
});

test("does not classify an isolated climb or descent as an alpine road pattern", () => {
  assert.equal(classifyWorkoutType({
    validGps: false,
    totalDistance: 29_116,
    totalTimerTime: 6065,
    avgSpeed: 17.28,
    avgPower: 212,
    avgCadence: 54,
    roadClimbMinutes: 20,
    longestRoadClimbMinutes: 9,
    roadDescentMinutes: 2,
    longestRoadDescentMinutes: 2,
    roadClimbBeforeDescent: true
  }), "unknown");
});

test("classifies stationary GPS noise as indoor", () => {
  assert.equal(classifyWorkoutType({
    validGps: true,
    bounds: { minLat: 49, maxLat: 49.0005, minLng: 8, maxLng: 8.0005 },
    totalDistance: 300,
    totalTimerTime: 3600,
    avgPower: 180
  }), "indoor");
});

test("does not classify a long workout as indoor from stationary GPS alone", () => {
  assert.equal(classifyWorkoutType({
    validGps: true,
    bounds: { minLat: 49, maxLat: 49.0005, minLng: 8, maxLng: 8.0005 },
    totalDistance: 30_000,
    totalTimerTime: 3600,
    avgSpeed: 30,
    avgPower: 180
  }), "unknown");
});

test("classifies trainer distance with a tiny jittering GPS path as indoor", () => {
  assert.equal(classifyWorkoutType({
    validGps: true,
    bounds: { minLat: 49.5238, maxLat: 49.5246, minLng: 8.6672, maxLng: 8.6689 },
    totalDistance: 31_862,
    totalTimerTime: 3723,
    totalAscent: 0,
    avgSpeed: 30.816,
    avgPower: 249,
    avgCadence: 83,
    gpsPathDistance: 2862
  }), "indoor");
});

test("does not treat a genuinely ridden compact loop as indoor", () => {
  assert.equal(classifyWorkoutType({
    validGps: true,
    bounds: { minLat: 49.5238, maxLat: 49.5246, minLng: 8.6672, maxLng: 8.6689 },
    totalDistance: 31_862,
    totalTimerTime: 3723,
    totalAscent: 0,
    avgSpeed: 30.816,
    gpsPathDistance: 30_500
  }), "unknown");
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

test("classifies a moderately fast climb-dense ride as mountain", () => {
  assert.equal(classifyWorkoutType({
    validGps: true,
    bounds: { minLat: 49.45, maxLat: 49.53, minLng: 8.66, maxLng: 8.77 },
    totalDistance: 31_771,
    totalTimerTime: 5221,
    totalAscent: 894,
    avgSpeed: 21.924,
    avgPower: 271,
    avgCadence: 74
  }), "mountain");
});

test("classifies a mixed-surface mountain-bike ride with asphalt sections as mountain", () => {
  assert.equal(classifyWorkoutType({
    validGps: true,
    bounds: { minLat: 46.4, maxLat: 46.7, minLng: 10.3, maxLng: 10.7 },
    totalDistance: 47_777,
    totalTimerTime: 7527,
    totalAscent: 1148,
    avgSpeed: 22.86,
    avgPower: 208,
    avgCadence: 74
  }), "mountain");
});

test("classifies a shorter moderately fast and hilly mountain-bike ride", () => {
  assert.equal(classifyWorkoutType({
    validGps: true,
    bounds: { minLat: 49.45, maxLat: 49.53, minLng: 8.66, maxLng: 8.69 },
    totalDistance: 18_256,
    totalTimerTime: 2825,
    totalAscent: 269,
    avgSpeed: 23.292,
    avgPower: 232,
    avgCadence: 74
  }), "mountain");
});

test("classifies a GPS mountain-bike climb and descent just outside aggregate thresholds", () => {
  assert.equal(classifyWorkoutType({
    validGps: true,
    bounds: { minLat: 47.39, maxLat: 47.57, minLng: 12.7, maxLng: 12.85 },
    totalDistance: 66_737,
    totalTimerTime: 10_192,
    totalAscent: 1269,
    avgSpeed: 23.58,
    avgPower: 199,
    avgCadence: 69,
    roadClimbMinutes: 49,
    longestRoadClimbMinutes: 14,
    roadDescentMinutes: 10,
    longestRoadDescentMinutes: 6,
    roadClimbBeforeDescent: true
  }), "mountain");
});

test("classifies a climb-heavy GPS mountain-bike ride with shorter descents", () => {
  assert.equal(classifyWorkoutType({
    validGps: true,
    bounds: { minLat: 49.44, maxLat: 49.54, minLng: 8.6, maxLng: 8.76 },
    totalDistance: 43_173,
    totalTimerTime: 6614,
    totalAscent: 846,
    avgSpeed: 23.508,
    avgPower: 214,
    avgCadence: 68,
    roadClimbMinutes: 35,
    longestRoadClimbMinutes: 23,
    roadDescentMinutes: 4,
    longestRoadDescentMinutes: 2,
    roadClimbBeforeDescent: true
  }), "mountain");
});

test("does not classify a moderately fast ride with lower climb density as mountain", () => {
  assert.equal(classifyWorkoutType({
    validGps: true,
    bounds: { minLat: 49.45, maxLat: 49.53, minLng: 8.66, maxLng: 8.77 },
    totalDistance: 40_000,
    totalTimerTime: 6500,
    totalAscent: 520,
    avgSpeed: 22,
    avgPower: 220,
    avgCadence: 78
  }), "unknown");
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

test("uses concrete FIT cycling profiles only as an unknown fallback", () => {
  const ambiguousWorkout = {
    validGps: true,
    bounds: { minLat: 49.46, maxLat: 49.53, minLng: 8.66, maxLng: 8.76 },
    totalDistance: 28_354,
    totalTimerTime: 4560,
    totalAscent: 350,
    avgSpeed: 22.392,
    sport: 2
  };

  assert.equal(classifyWorkoutType(ambiguousWorkout), "unknown");
  assert.equal(classifyWorkoutTypeWithFitFallback({ ...ambiguousWorkout, subSport: 7 }), "road");
  assert.equal(classifyWorkoutTypeWithFitFallback({ ...ambiguousWorkout, subSport: 8 }), "mountain");
  assert.equal(classifyWorkoutTypeWithFitFallback({ ...ambiguousWorkout, subSport: 0 }), "unknown");
});

test("does not let a FIT profile override an automatic classification", () => {
  assert.equal(classifyWorkoutTypeWithFitFallback({
    validGps: true,
    bounds: { minLat: 48.8, maxLat: 49.2, minLng: 7.9, maxLng: 8.4 },
    totalDistance: 82_000,
    totalTimerTime: 9000,
    totalAscent: 900,
    avgSpeed: 32.8,
    sport: 2,
    subSport: 8
  }), "road");
});

test("maps only concrete cycling FIT sub-sports", () => {
  assert.equal(classifyFitWorkoutType({ sport: 2, subSport: 6 }), "indoor");
  assert.equal(classifyFitWorkoutType({ sport: "cycling", subSport: "track_cycling" }), "road");
  assert.equal(classifyFitWorkoutType({ sport: 2, subSport: 47 }), "mountain");
  assert.equal(classifyFitWorkoutType({ sport: 1, subSport: 7 }), "unknown");
});
