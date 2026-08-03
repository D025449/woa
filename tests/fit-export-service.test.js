import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import BrowserFitExportService from "../src/shared/FitExportService.js";
import ServerFitExportService from "../src/services/fitExportService.js";
import {
  discardPlaceholderLeftRightBalance,
  normalizeCompactMissingMetricsInPlace,
  parseFitBufferCompactBrowser,
  repairCompactPedalConnectivityDropoutsInPlace
} from "../src/public/js/fit-import-compact-browser.js";
import { detectFitLapSegmentsCompact } from "../src/shared/WorkoutLocalPostprocess.js";
import { withCalculatedPedalMetrics } from "../src/public/js/woa-format-compact.js";

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

function buildEnhancedRecordFitFixture() {
  const dataLength = 15 + (2 * 13);
  const bytes = new Uint8Array(14 + dataLength);
  const view = new DataView(bytes.buffer);
  bytes[0] = 14;
  bytes[1] = 0x20;
  view.setUint16(2, 100, true);
  view.setUint32(4, dataLength, true);
  bytes.set([46, 70, 73, 84], 8);

  let offset = 14;
  bytes[offset++] = 0x40;
  bytes[offset++] = 0;
  bytes[offset++] = 0;
  view.setUint16(offset, 20, true); offset += 2;
  bytes[offset++] = 3;
  bytes.set([253, 4, 0x86], offset); offset += 3;
  bytes.set([78, 4, 0x86], offset); offset += 3;
  bytes.set([73, 4, 0x86], offset); offset += 3;

  const records = [
    { timestamp: 1_000_000_000, altitude: 5500, speed: 12_345 },
    { timestamp: 1_000_000_001, altitude: 5505, speed: 12_400 }
  ];
  for (const record of records) {
    bytes[offset++] = 0;
    view.setUint32(offset, record.timestamp, true); offset += 4;
    view.setUint32(offset, record.altitude, true); offset += 4;
    view.setUint32(offset, record.speed, true); offset += 4;
  }
  return bytes;
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

test("browser FIT parser decodes 32-bit enhanced altitude and speed records", () => {
  const parsed = parseFitBufferCompactBrowser(buildEnhancedRecordFitFixture()).compactRecords;

  assert.equal(parsed.recordCount, 2);
  assert.deepEqual(Array.from(parsed.altitudesQ), [2400, 2404]);
  assert.deepEqual(Array.from(parsed.speedsCmS), [1235, 1240]);
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

test("FIT import repairs short pedal sensor dropouts but preserves explicit zero values", () => {
  const compactRecords = {
    recordCount: 10,
    timestampsSec: new Uint32Array([100, 101, 102, 103, 104, 105, 106, 107, 108, 109]),
    powersW: new Uint16Array([200, 210, 0xffff, 0xffff, 0, 230, 240, 0, 0, 250]),
    cadencesRpm: new Uint8Array([80, 82, 0xff, 0xff, 0xff, 0xff, 84, 0, 0, 86])
  };

  repairCompactPedalConnectivityDropoutsInPlace(compactRecords);

  assert.deepEqual(Array.from(compactRecords.powersW), [200, 210, 216, 222, 228, 234, 240, 0, 0, 250]);
  assert.deepEqual(Array.from(compactRecords.cadencesRpm), [80, 82, 82, 83, 83, 84, 84, 0, 0, 86]);
  assert.deepEqual(compactRecords.pedalConnectivityRepairStats, {
    detectedDropoutCount: 1,
    correctedDropoutCount: 1,
    correctedSampleCount: 4,
    maxCorrectedDropoutSeconds: 4,
    correctedPowerSampleCount: 4,
    correctedBalanceDropoutCount: 0,
    correctedBalanceSampleCount: 0,
    discardedBalanceSampleCount: 0
  });
});

test("FIT import leaves long or unbounded pedal sensor gaps missing", () => {
  const compactRecords = {
    recordCount: 6,
    timestampsSec: new Uint32Array([100, 101, 102, 120, 121, 122]),
    powersW: new Uint16Array([200, 0xffff, 0xffff, 220, 0xffff, 0xffff]),
    cadencesRpm: new Uint8Array([80, 0xff, 0xff, 82, 0xff, 0xff])
  };

  repairCompactPedalConnectivityDropoutsInPlace(compactRecords);

  assert.deepEqual(Array.from(compactRecords.powersW), [200, 0xffff, 0xffff, 220, 0xffff, 0xffff]);
  assert.deepEqual(Array.from(compactRecords.cadencesRpm), [80, 0xff, 0xff, 82, 0xff, 0xff]);
  assert.equal(compactRecords.pedalConnectivityRepairStats.correctedDropoutCount, 0);
});

test("FIT import repairs short single-sided pedal dropouts and collapsed power", () => {
  const compactRecords = {
    recordCount: 7,
    timestampsSec: new Uint32Array([100, 101, 102, 103, 104, 105, 106]),
    powersW: new Uint16Array([210, 220, 62, 58, 64, 230, 240]),
    cadencesRpm: new Uint8Array([78, 79, 78, 79, 80, 81, 82]),
    leftRightBalancesPct: new Uint8Array([51, 52, 100, 100, 100, 50, 49])
  };

  repairCompactPedalConnectivityDropoutsInPlace(compactRecords);

  assert.deepEqual(Array.from(compactRecords.leftRightBalancesPct), [51, 52, 52, 51, 51, 50, 49]);
  assert.deepEqual(Array.from(compactRecords.powersW), [210, 220, 223, 225, 228, 230, 240]);
  assert.equal(compactRecords.pedalConnectivityRepairStats.correctedBalanceDropoutCount, 1);
  assert.equal(compactRecords.pedalConnectivityRepairStats.correctedBalanceSampleCount, 3);
  assert.equal(compactRecords.pedalConnectivityRepairStats.correctedPowerSampleCount, 3);
});

test("FIT import preserves sustained or unbounded single-sided balance readings", () => {
  const compactRecords = {
    recordCount: 10,
    timestampsSec: new Uint32Array([100, 101, 102, 103, 104, 105, 106, 107, 108, 109]),
    powersW: new Uint16Array([200, 210, 70, 72, 74, 76, 78, 80, 220, 230]),
    cadencesRpm: new Uint8Array([80, 81, 80, 80, 80, 80, 80, 80, 82, 83]),
    leftRightBalancesPct: new Uint8Array([51, 52, 100, 100, 100, 100, 100, 100, 50, 49])
  };

  repairCompactPedalConnectivityDropoutsInPlace(compactRecords);

  assert.deepEqual(Array.from(compactRecords.leftRightBalancesPct), [51, 52, 100, 100, 100, 100, 100, 100, 50, 49]);
  assert.deepEqual(Array.from(compactRecords.powersW), [200, 210, 70, 72, 74, 76, 78, 80, 220, 230]);
  assert.equal(compactRecords.pedalConnectivityRepairStats.correctedBalanceDropoutCount, 0);
});

test("FIT import fixes short balance spikes without rewriting plausible power", () => {
  const compactRecords = {
    recordCount: 5,
    timestampsSec: new Uint32Array([100, 101, 102, 103, 104]),
    powersW: new Uint16Array([200, 205, 210, 215, 220]),
    cadencesRpm: new Uint8Array([80, 81, 82, 83, 84]),
    leftRightBalancesPct: new Uint8Array([50, 51, 0, 49, 50])
  };

  repairCompactPedalConnectivityDropoutsInPlace(compactRecords);

  assert.deepEqual(Array.from(compactRecords.leftRightBalancesPct), [50, 51, 50, 49, 50]);
  assert.deepEqual(Array.from(compactRecords.powersW), [200, 205, 210, 215, 220]);
  assert.equal(compactRecords.pedalConnectivityRepairStats.correctedPowerSampleCount, 0);
});

test("FIT import discards an unbounded balance extreme at the start of a power loss", () => {
  const compactRecords = {
    recordCount: 7,
    timestampsSec: new Uint32Array([100, 101, 102, 103, 104, 105, 106]),
    powersW: new Uint16Array([220, 210, 70, 65, 0, 0, 0]),
    cadencesRpm: new Uint8Array([82, 81, 70, 68, 55, 45, 0]),
    leftRightBalancesPct: new Uint8Array([51, 52, 100, 100, 0, 0, 50])
  };

  repairCompactPedalConnectivityDropoutsInPlace(compactRecords);

  assert.deepEqual(Array.from(compactRecords.leftRightBalancesPct), [51, 52, 127, 127, 127, 127, 127]);
  assert.deepEqual(Array.from(compactRecords.powersW), [220, 210, 70, 65, 0, 0, 0]);
  assert.equal(compactRecords.pedalConnectivityRepairStats.discardedBalanceSampleCount, 5);
});

test("repaired pedal samples refresh dependent session metrics", () => {
  const parsed = withCalculatedPedalMetrics({
    compactRecords: {
      recordCount: 4,
      powersW: new Uint16Array([180, 200, 220, 240]),
      cadencesRpm: new Uint8Array([70, 0, 80, 90]),
      pedalConnectivityRepairStats: { correctedDropoutCount: 1 }
    },
    sessions: [{
      total_timer_time: 3600,
      total_calories: 999,
      avg_power: 1,
      avg_cadence: 1,
      normalized_power: 1
    }]
  });

  assert.equal(parsed.sessions[0].avg_power, 210);
  assert.equal(parsed.sessions[0].max_power, 240);
  assert.equal(parsed.sessions[0].avg_cadence, 80);
  assert.equal(parsed.sessions[0].max_cadence, 90);
  assert.equal(parsed.sessions[0].normalized_power, 213);
  assert.equal(parsed.sessions[0].total_calories, 756);
});
