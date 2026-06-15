import test from "node:test";
import assert from "node:assert/strict";

import GpsTrackBlobService from "../src/services/gpsTrackBlobService.js";

test("gps track blob encodes and decodes sampled track points", async () => {
  const sourceTrack = [
    [48.13715, 11.57612],
    [48.13716, 11.57615],
    [48.1372, 11.5762]
  ];

  const compressed = await GpsTrackBlobService.encodeCompressed(sourceTrack, {
    sampleRateGps: 5
  });
  const decoded = await GpsTrackBlobService.decodeCompressed(compressed);

  assert.equal(decoded.sampleRateGps, 5);
  assert.deepEqual(decoded.points, [
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
