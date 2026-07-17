import assert from "node:assert/strict";
import test from "node:test";
import {
  getGpsSegmentRouteSamples,
  validatesGpsSegmentRoute
} from "../src/shared/GpsSegmentRouteValidator.js";
import { benchmarkGpsSegmentBestEfforts } from "../src/shared/BrowserGpsSegmentMatcher.js";

function point(index, lat = 48) {
  return { lat, lng: 8 + index * 0.001, slotIndex: index };
}

test("GPS segment route validation samples six evenly distributed points", () => {
  const track = Array.from({ length: 15 }, (_, index) => point(index));
  assert.deepEqual(
    getGpsSegmentRouteSamples(track).map((sample) => sample.slotIndex),
    [2, 4, 6, 8, 10, 12]
  );
});

test("GPS segment route validation tolerates two local route deviations", () => {
  const segment = Array.from({ length: 15 }, (_, index) => point(index));
  const workout = segment.map((value, index) => (
    index >= 3 && index <= 6 ? point(index, 48.002) : value
  ));

  assert.equal(validatesGpsSegmentRoute(
    [workout],
    segment,
    { segmentIndex: 0, index: 0 },
    { segmentIndex: 0, index: workout.length - 2 }
  ), true);
});

test("GPS segment route validation rejects a mostly different route", () => {
  const segment = Array.from({ length: 15 }, (_, index) => point(index));
  const workout = segment.map((value, index) => (
    index >= 3 && index <= 10 ? point(index, 48.002) : value
  ));

  assert.equal(validatesGpsSegmentRoute(
    [workout],
    segment,
    { segmentIndex: 0, index: 0 },
    { segmentIndex: 0, index: workout.length - 2 }
  ), false);
});

test("browser GPS matching accepts a segment endpoint just beyond the reduced track", () => {
  const gpsTrack = {
    sampleRateSeconds: 5,
    bbox: { minLat: 48, maxLat: 48, minLng: 8, maxLng: 8.002 },
    segments: [[point(0), point(1)]]
  };
  const segment = {
    id: 10,
    distance: 100,
    bounds: gpsTrack.bbox,
    track: [point(0), { lat: 48, lng: 8.0011 }]
  };

  assert.equal(benchmarkGpsSegmentBestEfforts(gpsTrack, [segment]).matches.length, 1);
});

test("browser GPS matching accepts a segment endpoint nearest to an internal track vertex", () => {
  const track = [
    { lat: 48, lng: 8, slotIndex: 0 },
    { lat: 48, lng: 8.001, slotIndex: 1 },
    { lat: 48.001, lng: 8.001, slotIndex: 2 }
  ];
  const gpsTrack = {
    sampleRateSeconds: 5,
    bbox: { minLat: 47.9999, maxLat: 48.001, minLng: 8, maxLng: 8.0011 },
    segments: [track]
  };
  const segment = {
    id: 10,
    distance: 100,
    bounds: gpsTrack.bbox,
    track: [track[0], { lat: 47.9999, lng: 8.0011 }]
  };

  assert.equal(benchmarkGpsSegmentBestEfforts(gpsTrack, [segment]).matches.length, 1);
});
