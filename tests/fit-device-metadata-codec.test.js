import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeFitDeviceMetadata,
  encodeFitDeviceMetadata,
  hasFitDeviceMetadata,
  stripFitDeviceMetadataFromWorkoutStream
} from "../src/shared/FitDeviceMetadataCodec.js";
import Workout from "../src/shared/Workout.js";
import { buildWorkoutStreamBlockWst11 } from "../src/public/js/woa-format-compact.js";

const metadata = {
  version: 2,
  fileId: {
    type: 4,
    manufacturer: 1,
    product: 4440,
    productName: "Edge 1050",
    serialNumber: 987654321,
    timeCreated: "2025-03-01T10:11:12.000Z",
    number: 7
  },
  devices: [{
    timestamp: "2025-03-01T10:11:13.000Z",
    deviceIndex: 1,
    deviceType: 11,
    manufacturer: 263,
    serialNumber: 12345,
    product: 99,
    productName: "Unknown Pedal",
    manufacturerName: "Future Sensor Vendor",
    deviceTypeName: "future_power_sensor",
    softwareVersion: 4.27,
    batteryVoltage: 3.125,
    batteryStatus: 4,
    batteryLevel: 87,
    antTransmissionType: 5,
    antDeviceNumber: 321,
    antNetwork: 0,
    antId: 87654321,
    sourceType: 1
  }]
};

test("DEV1 round-trips FIT-native values and derives catalog names", () => {
  const encoded = encodeFitDeviceMetadata(metadata);
  const decoded = decodeFitDeviceMetadata(encoded);

  assert.equal(new TextDecoder().decode(encoded.subarray(0, 4)), "DEV1");
  assert.equal(decoded.fileId.productName, "edge_1050");
  assert.equal(decoded.fileId.manufacturerName, "garmin");
  assert.equal(decoded.fileId.typeName, "activity");
  assert.equal(decoded.devices[0].productName, "Unknown Pedal");
  assert.equal(decoded.devices[0].manufacturerName, "Future Sensor Vendor");
  assert.equal(decoded.devices[0].deviceTypeName, "future_power_sensor");
  assert.equal(decoded.devices[0].softwareVersion, 4.27);
  assert.equal(decoded.devices[0].batteryVoltage, 3.125);
  assert.equal(hasFitDeviceMetadata(decoded), true);
});

test("empty metadata does not allocate a DEV1 payload", () => {
  assert.equal(encodeFitDeviceMetadata(null).byteLength, 0);
  assert.equal(encodeFitDeviceMetadata({ fileId: null, devices: [] }).byteLength, 0);
  assert.equal(hasFitDeviceMetadata({ version: 2, fileId: null, devices: [] }), false);
});

test("shared-stream sanitizing removes DEV1 without changing workout samples", () => {
  const compactRecords = {
    recordCount: 2,
    baseTimestampSec: 1_700_000_000,
    distancesQ: Uint32Array.from([0, 20]),
    powersW: Uint16Array.from([200, 210]),
    heartRatesBpm: Uint8Array.from([120, 121]),
    cadencesRpm: Uint8Array.from([80, 81]),
    speedsCmS: Uint16Array.from([1_000, 1_000]),
    altitudesQ: Int16Array.from([2_000, 2_004]),
    temperaturesC: Int8Array.from([20, 20]),
    leftRightBalancesPct: Uint8Array.from([50, 51])
  };
  const encoded = buildWorkoutStreamBlockWst11(compactRecords, { fitDeviceMetadata: metadata }).bytes;
  const sanitized = stripFitDeviceMetadataFromWorkoutStream(encoded);
  const workout = Workout.fromBuffer(sanitized);

  assert.ok(sanitized.byteLength < encoded.byteLength);
  assert.equal(workout.fitDeviceMetadata, null);
  assert.deepEqual([workout.getPowerAt(0), workout.getPowerAt(1)], [200, 210]);
});

test("legacy WS10 streams remain readable", () => {
  const compactRecords = {
    recordCount: 2,
    baseTimestampSec: 1_700_000_000,
    distancesQ: Uint32Array.from([0, 20]),
    powersW: Uint16Array.from([200, 210]),
    heartRatesBpm: Uint8Array.from([120, 121]),
    cadencesRpm: Uint8Array.from([80, 81]),
    speedsCmS: Uint16Array.from([1_000, 1_000]),
    altitudesQ: Int16Array.from([2_000, 2_004]),
    temperaturesC: Int8Array.from([20, 20]),
    leftRightBalancesPct: Uint8Array.from([50, 51])
  };
  const ws11 = buildWorkoutStreamBlockWst11(compactRecords).bytes;
  const ws10 = new Uint8Array(ws11.byteLength - 4);
  ws10.set(new TextEncoder().encode("WS10"), 0);
  ws10.set(ws11.subarray(4, 52), 4);
  ws10.set(ws11.subarray(56), 52);

  const workout = Workout.fromBuffer(ws10);
  assert.equal(workout.fitDeviceMetadata, null);
  assert.deepEqual([workout.getPowerAt(0), workout.getPowerAt(1)], [200, 210]);
});
