import assert from "node:assert/strict";
import test from "node:test";

import {
  areSegmentTracksSimilar,
  buildSegmentArchive,
  decodeSegmentArchive,
  filterNovelSegments
} from "../src/services/segmentArchiveService.js";

function createSegment(id, latOffset = 0, lngOffset = 0) {
  const track = [
    { lat: 48.5 + latOffset, lng: 9 + lngOffset, ele: 400 },
    { lat: 48.5005 + latOffset, lng: 9.0005 + lngOffset, ele: 410 },
    { lat: 48.501 + latOffset, lng: 9.001 + lngOffset, ele: 405 }
  ];
  return {
    id,
    distance: 135,
    duration: 30,
    ascent: 10,
    start: { ...track[0], name: `Start ${id}`, altitude: track[0].ele },
    end: { ...track[2], name: `End ${id}`, altitude: track[2].ele },
    track
  };
}

test("segment archive round-trips versioned per-segment JSON entries", async () => {
  const archive = buildSegmentArchive([createSegment(11), createSegment(12, 0.02, 0.02)]);
  const decoded = await decodeSegmentArchive(archive);

  assert.equal(decoded.length, 2);
  assert.equal(decoded[0].sourceId, 11);
  assert.equal(decoded[0].track.length, 3);
  assert.equal(decoded[0].start.name, "Start 11");
  assert.ok(decoded[0].distance > 100);
  assert.equal(decoded[0].bestEffortsStatus, "queued");
});

test("segment archive rejects non-ZIP input before importing anything", async () => {
  await assert.rejects(
    decodeSegmentArchive(Buffer.from("not a segment archive")),
    /not a readable ZIP archive/
  );
});

test("segment archive similarity accepts small GPS shifts but rejects another route", () => {
  const source = createSegment(1);
  const shiftedByAboutOneMeter = createSegment(2, 0.000008, 0.000008);
  const anotherRoute = createSegment(3, 0.01, 0.01);

  assert.equal(areSegmentTracksSimilar(source, shiftedByAboutOneMeter), true);
  assert.equal(areSegmentTracksSimilar(source, anotherRoute), false);
});

test("segment archive import filters database and in-archive duplicates", () => {
  const existing = createSegment(1);
  const exactDuplicate = createSegment(2);
  const closeDuplicate = createSegment(3, 0.000008, 0.000008);
  const novel = createSegment(4, 0.01, 0.01);
  const repeatedNovel = createSegment(5, 0.01, 0.01);

  const result = filterNovelSegments(
    [exactDuplicate, closeDuplicate, novel, repeatedNovel],
    [existing]
  );

  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0].id, 4);
  assert.equal(result.skippedDuplicates, 3);
});
