import assert from "node:assert/strict";
import test from "node:test";

import { smoothSegmentTrackForRendering } from "../src/public/js/segment-track-rendering.js";

const METERS_PER_DEGREE = 111195;

function pointToSegmentDistanceMeters(point, start, end) {
  const referenceLatitude = ((start.lat + end.lat) / 2) * Math.PI / 180;
  const scaleLng = METERS_PER_DEGREE * Math.cos(referenceLatitude);
  const x = (point.lng - start.lng) * scaleLng;
  const y = (point.lat - start.lat) * METERS_PER_DEGREE;
  const dx = (end.lng - start.lng) * scaleLng;
  const dy = (end.lat - start.lat) * METERS_PER_DEGREE;
  const lengthSquared = (dx * dx) + (dy * dy);
  const ratio = lengthSquared > 0
    ? Math.max(0, Math.min(1, ((x * dx) + (y * dy)) / lengthSquared))
    : 0;
  return Math.hypot(x - (dx * ratio), y - (dy * ratio));
}

function distanceToTrackMeters(point, track) {
  let minimum = Infinity;
  for (let index = 1; index < track.length; index += 1) {
    minimum = Math.min(minimum, pointToSegmentDistanceMeters(point, track[index - 1], track[index]));
  }
  return minimum;
}

test("segment rendering smooths a sparse corner without changing the source track", () => {
  const track = [
    { lat: 48, lng: 11, ele: 500 },
    { lat: 48, lng: 11.001, ele: 501 },
    { lat: 48.001, lng: 11.001, ele: 502 },
    { lat: 48.001, lng: 11.002, ele: 503 }
  ];
  const snapshot = structuredClone(track);
  const rendered = smoothSegmentTrackForRendering(track, {
    targetSpacingMeters: 5,
    maxDeviationMeters: 4
  });

  assert.deepEqual(track, snapshot);
  assert.ok(rendered.length > track.length);
  assert.deepEqual(rendered[0], { lat: track[0].lat, lng: track[0].lng });
  assert.ok(Math.abs(rendered.at(-1).lat - track.at(-1).lat) < 1e-12);
  assert.ok(Math.abs(rendered.at(-1).lng - track.at(-1).lng) < 1e-12);
  assert.ok(rendered.every((point) => distanceToTrackMeters(point, track) <= 4.05));
});

test("segment rendering keeps original anchor points on the visual curve", () => {
  const track = [
    { lat: 47, lng: 10 },
    { lat: 47.0004, lng: 10.0006 },
    { lat: 47.001, lng: 10.0007 }
  ];
  const rendered = smoothSegmentTrackForRendering(track, { targetSpacingMeters: 4 });

  for (const anchor of track) {
    assert.ok(rendered.some((point) => (
      Math.abs(point.lat - anchor.lat) < 1e-12
      && Math.abs(point.lng - anchor.lng) < 1e-12
    )));
  }
});

test("segment rendering respects its point budget", () => {
  const track = Array.from({ length: 40 }, (_, index) => ({
    lat: 48 + (index * 0.0002),
    lng: 11 + (Math.sin(index / 4) * 0.0002)
  }));
  const rendered = smoothSegmentTrackForRendering(track, {
    targetSpacingMeters: 2,
    maxPoints: 80
  });

  assert.ok(rendered.length >= track.length);
  assert.ok(rendered.length <= 80);
});

test("two-point tracks remain a plain line", () => {
  const track = [
    { lat: 48, lng: 11, ele: 500 },
    { lat: 48.001, lng: 11.001, ele: 510 }
  ];

  assert.deepEqual(smoothSegmentTrackForRendering(track), [
    { lat: 48, lng: 11 },
    { lat: 48.001, lng: 11.001 }
  ]);
});
