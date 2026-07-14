import assert from "node:assert/strict";
import test from "node:test";

import { buildReducedGpsTrackCompact } from "../src/public/js/woa-format-compact.js";

const INT32_NAN = -0x80000000;

function compactGpsRecords(points) {
  return {
    recordCount: points.length,
    baseTimestampSec: 1_700_000_000,
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
