import assert from "node:assert/strict";
import test from "node:test";

import Workout from "../src/shared/Workout.js";
import {
  buildWorkoutStreamBlockCompactDelta8Q4PowerDistanceUint8Q02RleDeltaQ1m,
  buildWorkoutStreamBlockWst11,
  buildWorkoutStreamBlockWst11FromWorkout
} from "../src/public/js/woa-format-compact.js";

test("WS11 preserves optional series and compact FIT device metadata", () => {
  const compactRecords = {
    recordCount: 6,
    baseTimestampSec: 1_700_000_000,
    distancesQ: Uint32Array.from([0, 10, 20, 30, 40, 50]),
    powersW: Uint16Array.from([200, 204, 208, 212, 216, 220]),
    heartRatesBpm: Uint8Array.from([120, 121, 122, 123, 124, 125]),
    cadencesRpm: Uint8Array.from([80, 81, 82, 83, 84, 85]),
    speedsCmS: Uint16Array.from([500, 500, 500, 500, 500, 500]),
    altitudesQ: Int16Array.from([2000, 2004, 2008, 2012, 2016, 2020]),
    temperaturesC: Int8Array.from([-2, -2, -1, 0, 0, 127]),
    leftRightBalancesPct: Uint8Array.from([50, 51, 127, 52, 53, 54])
  };

  const encoded = buildWorkoutStreamBlockWst11(compactRecords, {
    fitDeviceMetadata: {
      version: 2,
      fileId: {
        type: 4,
        manufacturer: 1,
        product: 4440,
        productName: "Edge 1050",
        serialNumber: 123456,
        timeCreated: "2024-06-15T08:30:00.000Z"
      },
      devices: [{
        deviceIndex: 0,
        sourceType: 1,
        deviceType: 11,
        manufacturer: 263,
        product: 12,
        softwareVersion: 3.14
      }]
    }
  }).bytes;
  const workout = Workout.fromBuffer(encoded);

  assert.equal(new TextDecoder().decode(encoded.subarray(0, 4)), "WS11");
  assert.deepEqual(
    Array.from({ length: 6 }, (_, index) => workout.getTemperatureAt(index)),
    [-2, -2, -1, 0, 0, Number.NaN]
  );
  assert.deepEqual(
    Array.from({ length: 6 }, (_, index) => workout.getLeftRightBalanceAt(index)),
    [50, 51, Number.NaN, 52, 53, 54]
  );
  assert.equal(workout.fitDeviceMetadata.fileId.productName, "edge_1050");
  assert.equal(workout.fitDeviceMetadata.fileId.serialNumber, 123456);
  assert.equal(workout.fitDeviceMetadata.devices[0].manufacturerName, "favero_electronics");
  assert.equal(workout.fitDeviceMetadata.devices[0].deviceTypeName, "bike_power");
  assert.equal(Workout.getWst9RangeAverages(encoded, 0, 5).power, 212);
});

test("WS11 rebuild from Workout preserves core, optional series, and device metadata", () => {
  const workout = Workout.fromRecords([
    { power: 200, heart_rate: 120, cadence: 80, speed: 10, altitude: 500, distance: 0 },
    { power: 204, heart_rate: 121, cadence: 81, speed: 10.5, altitude: 501, distance: 10 },
    { power: 208, heart_rate: 122, cadence: 82, speed: 11, altitude: 502, distance: 21 }
  ], { startTime: 1_700_000_000_000, validGps: true });
  workout.temperatureSeriesC = Int8Array.from([-2, -1, 0]);
  workout.leftRightBalanceSeriesPct = Uint8Array.from([49, 50, 51]);
  workout.fitDeviceMetadata = {
    version: 2,
    fileId: { manufacturer: 1, product: 2713 },
    devices: [{ deviceIndex: 0, manufacturer: 1, product: 2713, softwareVersion: 12.34 }]
  };

  const encoded = buildWorkoutStreamBlockWst11FromWorkout(workout).bytes;
  const decoded = Workout.fromBuffer(encoded);

  assert.equal(new TextDecoder().decode(encoded.subarray(0, 4)), "WS11");
  assert.deepEqual(Array.from({ length: 3 }, (_, index) => decoded.getDistanceAt(index)), [0, 10, 21]);
  assert.deepEqual(Array.from({ length: 3 }, (_, index) => decoded.getPowerAt(index)), [200, 204, 208]);
  assert.deepEqual(Array.from({ length: 3 }, (_, index) => decoded.getTemperatureAt(index)), [-2, -1, 0]);
  assert.deepEqual(Array.from({ length: 3 }, (_, index) => decoded.getLeftRightBalanceAt(index)), [49, 50, 51]);
  assert.equal(decoded.fitDeviceMetadata.fileId.productName, "edge_1030");
  assert.equal(decoded.fitDeviceMetadata.devices[0].softwareVersion, 12.34);
});

test("Workout never exposes the compact missing balance marker as data", () => {
  const workout = Workout.fromRecords([{ power: 100 }]);
  workout.leftRightBalanceSeriesPct = Uint8Array.from([127]);

  assert.equal(Number.isNaN(workout.getLeftRightBalanceAt(0)), true);
  assert.equal(Number.isNaN(workout.getMetricsAt(0).leftRightBalance), true);
});

test("chart balance smoothing is power weighted and keeps raw mode untouched", () => {
  const workout = Workout.fromRecords([
    { power: 100, heart_rate: 120, cadence: 80, speed: 10, altitude: 500, distance: 0 },
    { power: 300, heart_rate: 121, cadence: 81, speed: 10, altitude: 500, distance: 10 },
    { power: 100, heart_rate: 122, cadence: 82, speed: 10, altitude: 500, distance: 20 }
  ], { startTime: 1_700_000_000_000 });
  workout.leftRightBalanceSeriesPct = Uint8Array.from([40, 60, 40]);

  const smoothed = workout.getAsStrideArray({
    includeLeftRightBalance: true,
    smoothing: { power: 1, hr: 1, cadence: 1, speed: 1, altitude: 1, leftRightBalance: 3 }
  }).data;
  const raw = workout.getAsStrideArray({
    includeLeftRightBalance: true,
    smoothing: { power: 1, hr: 1, cadence: 1, speed: 1, altitude: 1, leftRightBalance: 1 }
  }).data;

  assert.equal(smoothed[8 + 7], 52);
  assert.deepEqual([raw[7], raw[8 + 7], raw[16 + 7]], [40, 60, 40]);
});

test("smoothed chart balance suppresses windows with negligible power", () => {
  const workout = Workout.fromRecords([
    { power: 20 },
    { power: 30 },
    { power: 40 }
  ]);
  workout.leftRightBalanceSeriesPct = Uint8Array.from([40, 70, 45]);

  const smoothed = workout.getAsStrideArray({
    includeLeftRightBalance: true,
    smoothing: { leftRightBalance: 3 }
  }).data;

  assert.equal(Number.isNaN(smoothed[8 + 7]), true);
});

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

test("direct WST9 thumbnail series decode only the required columns", () => {
  const recordCount = 420;
  const compactRecords = {
    recordCount,
    baseTimestampSec: 1_700_000_000,
    distancesQ: Uint32Array.from({ length: recordCount }, (_, index) => index * 16),
    powersW: Uint16Array.from({ length: recordCount }, (_, index) => (
      index % 89 === 0 ? 0xffff : index % 73 === 0 ? 900 : 180 + ((index % 17) * 4)
    )),
    heartRatesBpm: Uint8Array.from({ length: recordCount }, (_, index) => (
      index % 101 === 0 ? 0xff : 120 + (index % 23)
    )),
    cadencesRpm: Uint8Array.from({ length: recordCount }, (_, index) => (
      index % 97 === 0 ? 0xff : 75 + (index % 19)
    )),
    speedsCmS: Uint16Array.from({ length: recordCount }, () => 800),
    altitudesQ: Int16Array.from({ length: recordCount }, (_, index) => index)
  };
  const wst9 = buildWorkoutStreamBlockCompactDelta8Q4PowerDistanceUint8Q02RleDeltaQ1m(
    compactRecords
  ).bytes;
  const materialized = Workout.fromBuffer(wst9);
  const direct = Workout.getWst9ThumbnailSeries(wst9);

  assert.equal(direct.recordCount, recordCount);
  for (let index = 0; index < recordCount; index += 1) {
    const expectedPower = materialized.getPowerAt(index);
    const expectedHr = materialized.getHrAt(index);
    const expectedCadence = materialized.getCadenceAt(index);
    assert.equal(Number.isNaN(direct.powers[index]), Number.isNaN(expectedPower));
    assert.equal(Number.isNaN(direct.heartRates[index]), Number.isNaN(expectedHr));
    assert.equal(Number.isNaN(direct.cadences[index]), Number.isNaN(expectedCadence));
    if (Number.isFinite(expectedPower)) assert.equal(direct.powers[index], expectedPower);
    if (Number.isFinite(expectedHr)) assert.equal(direct.heartRates[index], expectedHr);
    if (Number.isFinite(expectedCadence)) assert.equal(direct.cadences[index], expectedCadence);
  }
});
