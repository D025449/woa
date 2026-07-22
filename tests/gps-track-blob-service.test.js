import test from "node:test";
import assert from "node:assert/strict";

import GpsTrackBlobService from "../src/services/gpsTrackBlobService.js";
import SegmentTrackBlobService from "../src/services/segmentTrackBlobService.js";

test("gps track blob encodes and decodes sampled track points", async () => {
  const sourceTrack = [
    [48.13715, 11.57612],
    [48.13716, 11.57615],
    [48.1372, 11.5762]
  ];

  const stored = await GpsTrackBlobService.encodeCompressed(sourceTrack, {
    sampleRateGps: 5
  });
  assert.equal(Buffer.from(stored).subarray(0, 4).toString("ascii"), "GPS2");
  const decoded = await GpsTrackBlobService.decodeCompressed(stored);

  assert.equal(decoded.sampleRateGps, 5);
  assert.deepEqual(decoded.points.map(({ lat, lng }) => ({ lat, lng })), [
    { lat: 48.13715, lng: 11.57612 },
    { lat: 48.13716, lng: 11.57615 },
    { lat: 48.1372, lng: 11.5762 }
  ]);
  assert.deepEqual(decoded.geoJson, {
    type: "LineString",
    coordinates: [
      [11.57612, 48.13715],
      [11.57615, 48.13716],
      [11.5762, 48.1372]
    ]
  });
});

test("gps track blob still reads compressed codecs explicitly", async () => {
  const sourceTrack = [
    [48.13715, 11.57612],
    [48.1372, 11.5762]
  ];

  for (const codec of ["gzip", "brotli"]) {
    const stored = await GpsTrackBlobService.encodeCompressed(sourceTrack, {
      sampleRateGps: 5,
      codec
    });
    const decoded = await GpsTrackBlobService.decodeCompressed(stored, { codec });
    assert.equal(decoded.pointCount, 2);
  }
});

test("segment tracks use raw GPS2 identity storage by default", async () => {
  const stored = await SegmentTrackBlobService.encode([
    { lat: 48.13715, lng: 11.57612 },
    { lat: 48.1372, lng: 11.5762 }
  ]);
  assert.equal(Buffer.from(stored).subarray(0, 4).toString("ascii"), "GPS2");
  const decoded = await SegmentTrackBlobService.decode(stored);
  assert.equal(decoded.pointCount, 2);
});
