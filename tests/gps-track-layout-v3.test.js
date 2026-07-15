import test from "node:test";
import assert from "node:assert/strict";

import { buildGpsTrackBlock } from "../src/public/js/woa-format-compact.js";
import GpsTrackBlobCodec from "../src/shared/GpsTrackBlobCodec.js";
import GpsTrackBlobService from "../src/services/gpsTrackBlobService.js";
import { decodeGpsTrackBlock } from "../src/services/woa1Service.js";
import Workout from "../src/shared/Workout.js";

const sourceSlots = [
  { lat: 48.137151, lng: 11.576121 },
  { lat: 48.137161, lng: 11.576151 },
  { lat: Number.NaN, lng: Number.NaN },
  { lat: 49.5, lng: 12.5 },
  { lat: 49.500011, lng: 12.500011 }
];

const expectedSlots = [
  { lat: 48.13715, lng: 11.57612 },
  { lat: 48.13716, lng: 11.57615 },
  { lat: Number.NaN, lng: Number.NaN },
  { lat: 49.5, lng: 12.5 },
  { lat: 49.50001, lng: 12.50001 }
];

function assertDecodedSlots(decoded, expected = expectedSlots) {
  assert.equal(decoded.sampleRateGps, 5);
  assert.equal(decoded.slotCount, expected.length);
  for (let index = 0; index < expected.length; index += 1) {
    const actual = decoded.slots[index];
    const expectedSlot = expected[index];
    if (Number.isNaN(expectedSlot.lat)) {
      assert.equal(Number.isNaN(actual.lat), true);
      assert.equal(Number.isNaN(actual.lng), true);
    } else {
      assert.equal(actual.lat, expectedSlot.lat);
      assert.equal(actual.lng, expectedSlot.lng);
    }
  }
}

test("GPS2 layout v3 uses E5 Int16 deltas with per-slot absolute escapes", () => {
  const encoded = buildGpsTrackBlock({
    slots: sourceSlots,
    slotCount: sourceSlots.length,
    sampleRateSeconds: 5,
    firstTimestampMs: 1_700_000_000_000
  }, {
    coordinateEncoding: "int16-escape"
  });

  const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
  assert.equal(view.getUint16(4, true), 3);
  assert.equal(view.getUint8(20), 2);

  assertDecodedSlots(GpsTrackBlobCodec.decodeTrackBuffer(encoded));
  assertDecodedSlots(GpsTrackBlobService.decodeTrackBuffer(encoded));
  const imported = decodeGpsTrackBlock(encoded);
  assert.equal(imported.sampleRate, 5);
  assert.equal(imported.slots.length, expectedSlots.length);
  for (let index = 0; index < expectedSlots.length; index += 1) {
    const actual = imported.slots[index];
    const expected = expectedSlots[index];
    if (Number.isNaN(expected.lat)) {
      assert.equal(Number.isNaN(actual.lat), true);
      assert.equal(Number.isNaN(actual.lng), true);
    } else {
      assert.equal(actual.lat, expected.lat);
      assert.equal(actual.lng, expected.lng);
    }
  }
});

test("GPS2 layout v4 roundtrips Int8, Int16, missing, and absolute tiers", () => {
  const slots = [
    { lat: 48, lng: 11 },
    { lat: 48.00001, lng: 11.00002 },
    { lat: 48.002, lng: 11.002 },
    { lat: Number.NaN, lng: Number.NaN },
    { lat: 49, lng: 12 },
    { lat: 60, lng: 20 }
  ];
  const encoded = buildGpsTrackBlock({
    slots,
    slotCount: slots.length,
    sampleRateSeconds: 5
  }, {
    coordinateEncoding: "tiered-int8"
  });
  const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);

  assert.equal(view.getUint16(4, true), 4);
  assert.equal(view.getUint8(20), 3);
  assertDecodedSlots(GpsTrackBlobCodec.decodeTrackBuffer(encoded), slots);
  assertDecodedSlots(GpsTrackBlobService.decodeTrackBuffer(encoded), slots);
  const imported = decodeGpsTrackBlock(encoded);
  assert.equal(imported.sampleRate, 5);
  assert.equal(imported.slots.length, slots.length);
  for (let index = 0; index < slots.length; index += 1) {
    const expected = slots[index];
    const actual = imported.slots[index];
    if (Number.isNaN(expected.lat)) {
      assert.equal(Number.isNaN(actual.lat), true);
      assert.equal(Number.isNaN(actual.lng), true);
    } else {
      assert.equal(actual.lat, expected.lat);
      assert.equal(actual.lng, expected.lng);
    }
  }
});

test("default GPS2 layout v5 roundtrips a shared bitmap and columnar coordinates", () => {
  const slots = [
    { lat: 48, lng: 11 },
    { lat: 48.00001, lng: 11.00002 },
    { lat: 48.002, lng: 11.002 },
    { lat: Number.NaN, lng: Number.NaN },
    { lat: 49, lng: 12 },
    { lat: 60, lng: 20 }
  ];
  const encoded = buildGpsTrackBlock({
    slots,
    slotCount: slots.length,
    sampleRateSeconds: 5
  });
  const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);

  assert.equal(view.getUint16(4, true), 5);
  assert.ok(view.getUint32(20, true) > 0);
  assert.equal(encoded[24] & 0b00111111, 0b00110111);
  assertDecodedSlots(GpsTrackBlobCodec.decodeTrackBuffer(encoded), slots);
  assertDecodedSlots(GpsTrackBlobService.decodeTrackBuffer(encoded), slots);
  const imported = decodeGpsTrackBlock(encoded);
  assert.equal(imported.sampleRate, 5);
  assert.equal(imported.slots.length, slots.length);
  for (let index = 0; index < slots.length; index += 1) {
    const expected = slots[index];
    const actual = imported.slots[index];
    if (Number.isNaN(expected.lat)) {
      assert.equal(Number.isNaN(actual.lat), true);
      assert.equal(Number.isNaN(actual.lng), true);
    } else {
      assert.equal(actual.lat, expected.lat);
      assert.equal(actual.lng, expected.lng);
    }
  }
});

test("compact similarity decode keeps only E5 integer coordinate columns", async () => {
  const encoded = buildGpsTrackBlock({
    slots: sourceSlots,
    slotCount: sourceSlots.length,
    sampleRateSeconds: 5
  });
  const compressed = await Workout.compress(encoded, "gzip");

  const decoded = await GpsTrackBlobService.decodeCompressedCompact(compressed, { codec: "gzip" });

  assert.equal(decoded.layoutVersion, 5);
  assert.equal(decoded.sampleRateGps, 5);
  assert.equal(decoded.slotCount, sourceSlots.length);
  assert.equal(decoded.pointCount, 4);
  assert.deepEqual([...decoded.latitudesE5], [4813715, 4813716, 4950000, 4950001]);
  assert.deepEqual([...decoded.longitudesE5], [1157612, 1157615, 1250000, 1250001]);
  assert.equal(decoded.byteLength, 32);
});

test("GPS2 layout v3 keeps isolated invalid slots from forcing a raw track", () => {
  const slots = Array.from({ length: 100 }, (_, index) => ({
    lat: 48 + (index / 100_000),
    lng: 11 + (index / 100_000)
  }));
  slots[50] = { lat: Number.NaN, lng: Number.NaN };

  const encoded = buildGpsTrackBlock({
    slots,
    slotCount: slots.length,
    sampleRateSeconds: 5
  }, {
    coordinateEncoding: "int16-escape"
  });
  const oldRawLayoutBytes = 20 + 3 + (slots.length * 8);

  assert.ok(encoded.byteLength < oldRawLayoutBytes * 0.6);
  assert.equal(GpsTrackBlobCodec.decodeTrackBuffer(encoded).slotCount, slots.length);
});
