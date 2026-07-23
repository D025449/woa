import assert from "node:assert/strict";
import test from "node:test";
import BestEffortDetector from "../src/shared/BestEffortDetector.js";
import {
  detectWorkoutLocalSegmentsCompact,
  decodeWorkoutLocalPostprocessTransport,
  encodeWorkoutLocalPostprocessTransport,
  inspectWorkoutLocalPostprocessTransport
} from "../src/shared/WorkoutLocalPostprocess.js";

function compactFromRecords(records) {
  return {
    recordCount: records.length,
    baseTimestampSec: 1_700_000_000,
    distancesQ: Uint32Array.from(records, (record) => Math.round(record.distance * 2)),
    powersW: Uint16Array.from(records, (record) => record.power),
    heartRatesBpm: Uint8Array.from(records, (record) => record.heart_rate),
    cadencesRpm: Uint8Array.from(records, (record) => record.cadence),
    speedsCmS: Uint16Array.from(records, (record) => Math.round(record.speed * 100)),
    altitudesQ: Int16Array.from(records, (record) => Math.round(record.altitude * 4))
  };
}

test("compact workout-local detection emits only critical-power best efforts", () => {
  const records = Array.from({ length: 240 }, (_, index) => ({
    power: index >= 80 && index < 150 ? 320 : 100,
    heart_rate: index >= 80 && index < 150 ? 150 + Math.floor((index - 80) / 10) : 110,
    cadence: index >= 80 && index < 150 ? 92 : 70,
    speed: index === 0 ? 0 : 8,
    altitude: 100 + Math.floor(index / 40),
    distance: index * 8
  }));
  const expected = BestEffortDetector.detect(records).map((segment) => ({
    start: segment.start_offset,
    end: segment.end_offset,
    duration: segment.duration,
    avgPower: segment.avgPower,
    avgHeartRate: segment.avgHeartRate,
    avgCadence: segment.avgCadence,
    avgSpeed: segment.avgSpeed,
    altimeters: segment.altimeters,
    type: 2
  }));
  const actual = detectWorkoutLocalSegmentsCompact(compactFromRecords(records));
  assert.deepEqual(actual, expected);
});

test("WPP1 transport stores workout and segment counts compactly", () => {
  const workouts = [
    { startTimeSec: 100, recordCount: 100, segments: [{ type: 1, start: 4, end: 20, duration: 16, avgPower: 250, avgHeartRate: 150, avgCadence: 90, avgSpeed: 8.25, altimeters: 3000 }] },
    { startTimeSec: 200, recordCount: 200, segments: [] }
  ];
  const bytes = encodeWorkoutLocalPostprocessTransport(workouts);
  assert.deepEqual(inspectWorkoutLocalPostprocessTransport(bytes), {
    version: 2,
    workoutCount: 2,
    segmentCount: 1,
    byteLength: 75
  });
  assert.deepEqual(decodeWorkoutLocalPostprocessTransport(bytes).workouts, workouts);
});
