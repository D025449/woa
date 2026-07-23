import assert from "node:assert/strict";
import test from "node:test";

import { buildReducedGpsTrackCompact } from "../src/public/js/woa-format-compact.js";

const INT32_NAN = -0x80000000;

function compactGpsRecords(points, distancesQ = null) {
  return {
    recordCount: points.length,
    baseTimestampSec: 1_700_000_000,
    ...(distancesQ ? { distancesQ: Uint32Array.from(distancesQ) } : {}),
    positionLatsE6: Int32Array.from(points.map((point) => point?.[0] ?? INT32_NAN)),
    positionLongsE6: Int32Array.from(points.map((point) => point?.[1] ?? INT32_NAN))
  };
}

test("compact GPS reduction works directly on E6 coordinates", () => {
  const points = Array.from({ length: 24 }, (_, index) => [50_000_000 + index * 10, 8_000_000]);
  points[5] = null;
  points[6] = null;

  const track = buildReducedGpsTrackCompact(compactGpsRecords(points), 1);

  assert.equal(track.slotCount, points.length);
  assert.equal(track.pointCount, points.length);
  assert.equal(track.slots[5].valid, true);
  assert.equal(track.slots[6].valid, true);
  assert.equal(track.slots[5].lat, 50.00006);
  assert.equal(track.slots[6].lat, 50.00006);
});

test("compact GPS reduction rejects implausible startup coordinates before locking", () => {
  const points = [
    [49_521_692, 8_709_040],
    [49_525_221, 8_670_207],
    [49_524_567, 8_668_682],
    [49_524_567, 8_668_682],
    [49_524_567, 8_668_682],
    [49_524_592, 8_668_572]
  ];

  const track = buildReducedGpsTrackCompact(compactGpsRecords(points), 1);

  assert.equal(track.slots[0].valid, false);
  assert.equal(track.slots[1].valid, false);
  assert.equal(track.slots[2].valid, true);
  assert.deepEqual(track.startPoint, { lat: 49.52457, lng: 8.66868 });
  assert.equal(track.segments.length, 1);
  assert.equal(track.pointCount, 4);
});

test("compact GPS reduction invalidates a frozen coordinate while distance advances", () => {
  const points = [
    [50_000_000, 8_000_000],
    [50_000_010, 8_000_000],
    [50_000_020, 8_000_000],
    [50_000_030, 8_000_000],
    [50_000_030, 8_000_000],
    [50_000_030, 8_000_000],
    [50_000_030, 8_000_000],
    [50_000_030, 8_000_000],
    [50_000_030, 8_000_000],
    [50_000_040, 8_000_000],
    [50_000_050, 8_000_000],
    [50_000_060, 8_000_000]
  ];
  const distancesQ = [0, 20, 40, 60, 120, 180, 240, 300, 360, 380, 400, 420];

  const track = buildReducedGpsTrackCompact(compactGpsRecords(points, distancesQ), 1);

  assert.equal(track.slots[2].valid, true);
  for (let index = 3; index <= 8; index += 1) {
    assert.equal(track.slots[index].valid, false);
  }
  assert.equal(track.slots[9].valid, true);
  assert.equal(track.segments.length, 2);
});

test("compact GPS reduction preserves stationary coordinates without distance movement", () => {
  const points = Array.from({ length: 8 }, () => [50_000_000, 8_000_000]);

  const track = buildReducedGpsTrackCompact(
    compactGpsRecords(points, new Array(points.length).fill(200)),
    1
  );

  assert.equal(track.pointCount, points.length);
  assert.equal(track.segments.length, 1);
  assert.equal(track.slots.every((slot) => slot.valid), true);
});

test("compact GPS reduction preserves a rejected spike between sampled records as a track break", () => {
  const points = Array.from({ length: 21 }, (_, index) => [50_000_000 + index * 10, 8_000_000]);
  points[9] = [51_000_000, 9_000_000];

  const track = buildReducedGpsTrackCompact(compactGpsRecords(points), 5);

  assert.equal(track.slotCount, 5);
  assert.equal(track.slots[0].valid, true);
  assert.equal(track.slots[1].valid, true);
  assert.equal(track.slots[2].valid, false);
  assert.equal(track.slots[3].valid, true);
  assert.equal(track.slots[4].valid, true);
  assert.equal(track.segments.length, 2);
});

test("compact GPS reduction preserves long-gap and relock behavior", () => {
  const points = Array.from({ length: 30 }, (_, index) => [50_000_000 + index * 10, 8_000_000]);
  for (let index = 4; index < 14; index += 1) points[index] = null;

  points[20] = [51_000_000, 9_000_000];
  points[21] = [51_000_010, 9_000_000];
  points[22] = [51_000_020, 9_000_000];
  for (let index = 23; index < points.length; index += 1) {
    points[index] = [51_000_020 + (index - 22) * 10, 9_000_000];
  }

  const track = buildReducedGpsTrackCompact(compactGpsRecords(points), 1);

  for (let index = 4; index < 12; index += 1) assert.equal(track.slots[index].valid, true);
  assert.equal(track.slots[12].valid, false);
  assert.equal(track.slots[13].valid, false);
  assert.equal(track.slots[20].valid, true);
  assert.equal(track.slots[21].valid, true);
  assert.equal(track.slots[22].valid, true);
});
