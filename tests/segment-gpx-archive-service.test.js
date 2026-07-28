import assert from "node:assert/strict";
import test from "node:test";

import { unzipSync } from "fflate";

import { buildSegmentArchive } from "../src/services/segmentArchiveService.js";
import {
  buildSegmentGpxArchive,
  decodeSegmentGpxArchive,
  detectSegmentArchiveKind
} from "../src/services/segmentGpxArchiveService.js";
import { buildSegmentGpx, parseSegmentGpx } from "../src/services/segmentGpxService.js";

function createSegment(id = 81) {
  return {
    id,
    duration: 123,
    ascent: 18,
    start: {
      lat: 48.5,
      lng: 9.2,
      name: "Wittlinger Steige",
      altitude: 410
    },
    end: {
      lat: 48.51,
      lng: 9.22,
      name: "Bad Urach / Hochberg",
      altitude: 428
    },
    track: [
      { lat: 48.5, lng: 9.2, ele: 410 },
      { lat: 48.505, lng: 9.21, ele: 421 },
      { lat: 48.51, lng: 9.22, ele: 428 }
    ]
  };
}

test("segment GPX preserves standard track points and WOA metadata", () => {
  const gpx = buildSegmentGpx([createSegment()]);
  const [parsed] = parseSegmentGpx(gpx);

  assert.equal(parsed.kind, "track");
  assert.equal(parsed.sourceId, "81");
  assert.equal(parsed.startName, "Wittlinger Steige");
  assert.equal(parsed.endName, "Bad Urach / Hochberg");
  assert.equal(parsed.duration, 123);
  assert.equal(parsed.ascent, 18);
  assert.equal(parsed.points.length, 3);
  assert.equal(parsed.points[1].ele, 421);
});

test("GPX ZIP uses readable per-segment filenames and round-trips", async () => {
  const archive = buildSegmentGpxArchive([createSegment()]);
  const entries = Object.keys(unzipSync(archive));

  assert.ok(entries.includes(
    "segments/S-81__wittlinger-steige__bad-urach-hochberg.gpx"
  ));
  assert.equal(await detectSegmentArchiveKind(archive), "gpx");

  const [parsed] = await decodeSegmentGpxArchive(archive);
  assert.equal(parsed.sourceId, "81");
  assert.equal(parsed.points.length, 3);
});

test("archive detection leaves the internal JSON format unchanged", async () => {
  const archive = buildSegmentArchive([createSegment()]);
  assert.equal(await detectSegmentArchiveKind(archive), "internal");
});
