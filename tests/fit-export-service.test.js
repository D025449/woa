import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import BrowserFitExportService from "../src/shared/FitExportService.js";
import ServerFitExportService from "../src/services/fitExportService.js";
import {
  discardPlaceholderLeftRightBalance,
  normalizeCompactMissingMetricsInPlace,
  parseFitBufferCompactBrowser
} from "../src/public/js/fit-import-compact-browser.js";
import { detectFitLapSegmentsCompact } from "../src/shared/WorkoutLocalPostprocess.js";

function getRecordFieldNumbers(fitBytes) {
  const view = new DataView(fitBytes.buffer, fitBytes.byteOffset, fitBytes.byteLength);
  const dataStart = fitBytes[0];
  const dataEnd = dataStart + view.getUint32(4, true);
  const definitions = [];
  let recordFields = [];
  let cursor = dataStart;

  while (cursor < dataEnd) {
    const header = fitBytes[cursor];
    const localMessage = header & 0x0f;
    if ((header & 0x40) !== 0) {
      const hasDeveloperFields = (header & 0x20) !== 0;
      const littleEndian = fitBytes[cursor + 2] === 0;
      const globalMessage = littleEndian
        ? view.getUint16(cursor + 3, true)
        : view.getUint16(cursor + 3, false);
      const fieldCount = fitBytes[cursor + 5];
      const fields = [];
      let messageBytes = 0;
      for (let index = 0; index < fieldCount; index += 1) {
        const offset = cursor + 6 + (index * 3);
        fields.push(fitBytes[offset]);
        messageBytes += fitBytes[offset + 1];
      }
      let definitionBytes = 6 + (fieldCount * 3);
      if (hasDeveloperFields) {
        const developerFieldCount = fitBytes[cursor + definitionBytes];
        definitionBytes += 1 + (developerFieldCount * 3);
        for (let index = 0; index < developerFieldCount; index += 1) {
          messageBytes += fitBytes[cursor + 7 + (fieldCount * 3) + (index * 3) + 1];
        }
      }
      definitions[localMessage] = { messageBytes };
      if (globalMessage === 20) recordFields = fields;
      cursor += definitionBytes;
      continue;
    }

    const definition = definitions[localMessage];
    assert.ok(definition, `Missing FIT definition for local message ${localMessage}`);
    cursor += 1 + definition.messageBytes;
  }

  return recordFields;
}

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

test("browser FIT encoder matches the current golden FIT payload", () => {
  const bytes = BrowserFitExportService.buildFitFromWorkout(buildWorkoutFixture(), options);

  assert.ok(bytes instanceof Uint8Array);
  assert.equal(bytes.byteLength, 551);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    "65945f5644572b2f4fde3e1e10edde77930907e400c47b8fe69f4abc68e23691"
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

test("FIT export round-trips temperature, balance and device metadata", () => {
  const fixture = buildWorkoutFixture();
  fixture.getTemperatureAt = (index) => 18 + (index % 2);
  fixture.getLeftRightBalanceAt = (index) => index === 2 ? Number.NaN : 51 + (index % 2);
  const fitDeviceMetadata = {
    version: 1,
    fileId: {
      type: 4,
      manufacturer: 1,
      product: 4440,
      productName: "Edge 1050",
      serialNumber: 3625669243,
      timeCreated: "2024-01-02T03:04:05.000Z"
    },
    devices: [{
      timestamp: "2024-01-02T03:04:05.000Z",
      deviceIndex: 0,
      manufacturer: 1,
      product: 4440,
      productName: "Edge 1050",
      serialNumber: 3625669243,
      softwareVersion: 13.18,
      sourceType: 5
    }]
  };

  const bytes = BrowserFitExportService.buildFitFromWorkout(fixture, {
    ...options,
    fitDeviceMetadata,
    normalizedPower: 219,
    totalCalories: 321,
    workoutType: "road"
  });
  const parsed = parseFitBufferCompactBrowser(bytes);

  assert.deepEqual(Array.from(parsed.compactRecords.temperaturesC), [18, 19, 18, 19, 18, 19]);
  assert.deepEqual(Array.from(parsed.compactRecords.leftRightBalancesPct), [51, 52, 127, 52, 51, 52]);
  assert.equal(parsed.fitDeviceMetadata.fileId.product, 4440);
  assert.equal(parsed.fitDeviceMetadata.fileId.productName, "Edge 1050");
  assert.equal(parsed.fitDeviceMetadata.devices[0].softwareVersion, 13.18);
  assert.equal(parsed.sessions[0].normalized_power, 219);
  assert.equal(parsed.sessions[0].total_calories, 321);
  assert.equal(parsed.sessions[0].sub_sport, 7);
});

test("FIT import discards constant 50 percent balance placeholders", () => {
  const fixture = buildWorkoutFixture();
  fixture.getLeftRightBalanceAt = () => 50;

  const bytes = BrowserFitExportService.buildFitFromWorkout(fixture, options);
  const parsed = parseFitBufferCompactBrowser(bytes);

  assert.deepEqual(
    Array.from(parsed.compactRecords.leftRightBalancesPct),
    [127, 127, 127, 127, 127, 127]
  );

  const measured = { leftRightBalancesPct: Uint8Array.from([127, 50, 51]) };
  assert.equal(discardPlaceholderLeftRightBalance(measured), measured);
  assert.deepEqual(Array.from(measured.leftRightBalancesPct), [127, 50, 51]);
});

test("FIT export omits measurement fields that the workout does not contain", () => {
  const fixture = {
    length: 3,
    getStartTime: () => Date.UTC(2024, 0, 2, 3, 4, 5),
    hasDistanceSeries: () => false,
    getDistanceAt: () => null,
    getSpeedAt: () => 0,
    getPowerAt: () => 0,
    getHrAt: () => 0,
    getCadenceAt: () => 0,
    getAltitudeAt: () => 0,
    getTemperatureAt: () => Number.NaN,
    getLeftRightBalanceAt: () => Number.NaN
  };

  const bytes = BrowserFitExportService.buildFitFromWorkout(fixture, {
    serialNumber: 99,
    includeGps: false
  });
  assert.deepEqual(getRecordFieldNumbers(bytes), [253]);
});

test("FIT export round-trips manual workout segments as manual laps", () => {
  const bytes = BrowserFitExportService.buildFitFromWorkout(buildWorkoutFixture(), {
    ...options,
    segments: [
      { segmenttype: "manual", start_offset: 1, end_offset: 4 },
      { segmenttype: "crit", start_offset: 0, end_offset: 5 },
      { segmenttype: "auto", start_offset: 2, end_offset: 5 }
    ]
  });
  const parsed = parseFitBufferCompactBrowser(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  );

  assert.equal(parsed.laps.length, 2);
  assert.deepEqual(parsed.laps.map((lap) => lap.lap_trigger), [0, 7]);
  const detected = detectFitLapSegmentsCompact(parsed.compactRecords, parsed.laps);
  assert.equal(detected.stats.fullWorkoutMessages, 1);
  assert.equal(detected.stats.importedSegments, 1);
  assert.deepEqual(
    detected.segments.map(({ type, start, end, duration }) => ({ type, start, end, duration })),
    [{ type: 3, start: 1, end: 4, duration: 3 }]
  );
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
