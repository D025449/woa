import assert from "node:assert/strict";
import test from "node:test";

import {
  endpointSearchBounds,
  parsePostgresBox,
  toPostgresBox
} from "../src/shared/postgresSpatial.js";
import SegmentTrackBlobService from "../src/services/segmentTrackBlobService.js";

test("PostgreSQL box conversion preserves normalized GPS bounds", () => {
  const encoded = toPostgresBox({ minLat: 48.1, maxLat: 48.3, minLng: 8.5, maxLng: 8.9 });
  assert.equal(encoded, "(8.9,48.3),(8.5,48.1)");
  assert.deepEqual(parsePostgresBox(encoded), {
    minLat: 48.1,
    maxLat: 48.3,
    minLng: 8.5,
    maxLng: 8.9
  });
});

test("endpoint bounding box safely contains the requested meter radius", () => {
  const bounds = endpointSearchBounds({ lat: 48, lng: 9 }, 200);
  assert.ok(bounds.minLat < 48 && bounds.maxLat > 48);
  assert.ok(bounds.minLng < 9 && bounds.maxLng > 9);
});

test("segment track blob round-trips through the shared compact coordinate codec", async () => {
  const track = [
    { lat: 48.12345, lng: 9.12345 },
    { lat: 48.12355, lng: 9.12365 },
    { lat: 48.12375, lng: 9.12385 }
  ];
  const blob = await SegmentTrackBlobService.encode(track, { codec: "gzip" });
  const decoded = await SegmentTrackBlobService.decode(blob, { codec: "gzip" });
  assert.equal(decoded.pointCount, track.length);
  assert.deepEqual(decoded.points.map(({ lat, lng }) => ({ lat, lng })), track);
});
