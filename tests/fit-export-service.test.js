import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import BrowserFitExportService from "../src/shared/FitExportService.js";
import ServerFitExportService from "../src/services/fitExportService.js";
import {
  normalizeCompactMissingMetricsInPlace,
  parseFitBufferCompactBrowser
} from "../src/public/js/fit-import-compact-browser.js";

function buildWorkoutFixture() {
  return {
    length: 6,
    getStartTime: () => Date.UTC(2024, 0, 2, 3, 4, 5),
    hasDistanceSeries: () => true,
    getDistanceAt: (index) => index * 12.5,
    getSpeedAt: () => 45,
    getPowerAt: (index) => 200 + index,
    getHrAt: (index) => 140 + index,
    getCadenceAt: (index) => 85 + index,
    getAltitudeAt: (index) => 500 + (index * 2)
  };
}

const options = {
  serialNumber: 42,
  sampleRateGps: 2,
  gpsCoordinates: [[48, 9], [48.001, 9.001], [48.002, 9.002]],
  includeGps: true,
  gpsSource: "manual_lookup"
};

test("browser FIT encoder remains byte-identical to the previous server encoder", () => {
  const bytes = BrowserFitExportService.buildFitFromWorkout(buildWorkoutFixture(), options);

  assert.ok(bytes instanceof Uint8Array);
  assert.equal(bytes.byteLength, 521);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    "91b8d99253b8ff6af5fa93df1e1b6c1001c894bd2b26a87847dc29f438283088"
  );
});

test("server FIT export wraps the shared browser encoder without changing bytes", () => {
  const browserBytes = BrowserFitExportService.buildFitFromWorkout(buildWorkoutFixture(), options);
  const serverBytes = ServerFitExportService.buildFitFromWorkout(buildWorkoutFixture(), options);

  assert.ok(Buffer.isBuffer(serverBytes));
  assert.deepEqual(serverBytes, Buffer.from(browserBytes));
});

test("browser FIT parser accounts for developer fields in exported records", () => {
  const bytes = BrowserFitExportService.buildFitFromWorkout(buildWorkoutFixture(), options);
  const parsed = parseFitBufferCompactBrowser(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  ).compactRecords;

  assert.equal(parsed.recordCount, 6);
  assert.deepEqual(Array.from(parsed.powersW), [200, 201, 202, 203, 204, 205]);
  assert.deepEqual(Array.from(parsed.altitudesQ), [2000, 2008, 2016, 2024, 2032, 2040]);
});

test("FIT export removes an unmistakably corrupt terminal record", () => {
  const fixture = buildWorkoutFixture();
  fixture.getDistanceAt = (index) => index === 5 ? 705.35 : index * 12.5;
  fixture.getSpeedAt = (index) => index === 5 ? 2359.26 : 45;
  fixture.getPowerAt = (index) => index === 5 ? 2052 : 200 + index;
  fixture.getHrAt = (index) => index === 5 ? 2 : 140 + index;
  fixture.getCadenceAt = (index) => index === 5 ? 132 : 85 + index;
  fixture.getAltitudeAt = (index) => index === 5 ? -422 : 500 + (index * 2);

  const bytes = BrowserFitExportService.buildFitFromWorkout(fixture, {
    ...options,
    includeGps: false
  });
  const parsed = parseFitBufferCompactBrowser(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  ).compactRecords;

  assert.equal(parsed.recordCount, 5);
  assert.equal(parsed.powersW[4], 204);
  assert.equal(parsed.altitudesQ[4], 2032);
});

test("FIT import normalizes missing metric markers without inventing GPS", () => {
  const compactRecords = {
    recordCount: 3,
    distancesQ: new Uint32Array([100, 0xffffffff, 140]),
    powersW: new Uint16Array([200, 0xffff, 220]),
    heartRatesBpm: new Uint8Array([140, 0xff, 142]),
    cadencesRpm: new Uint8Array([85, 0xff, 87]),
    speedsCmS: new Uint16Array([1000, 0xffff, 1100]),
    altitudesQ: new Int16Array([-0x8000, 2000, -0x8000]),
    positionLatsE6: new Int32Array([48000000, -0x80000000, 48000100]),
    positionLongsE6: new Int32Array([9000000, -0x80000000, 9000100])
  };

  normalizeCompactMissingMetricsInPlace(compactRecords);

  assert.deepEqual(Array.from(compactRecords.distancesQ), [100, 100, 140]);
  assert.deepEqual(Array.from(compactRecords.powersW), [200, 0, 220]);
  assert.deepEqual(Array.from(compactRecords.heartRatesBpm), [140, 0, 142]);
  assert.deepEqual(Array.from(compactRecords.cadencesRpm), [85, 0, 87]);
  assert.deepEqual(Array.from(compactRecords.speedsCmS), [1000, 0, 1100]);
  assert.deepEqual(Array.from(compactRecords.altitudesQ), [2000, 2000, 2000]);
  assert.equal(compactRecords.positionLatsE6[1], -0x80000000);
  assert.equal(compactRecords.positionLongsE6[1], -0x80000000);
});
