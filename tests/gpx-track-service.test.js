import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGpxRoutingAnchors,
  GpxValidationError,
  parseGpxTrack
} from "../src/services/gpxTrackService.js";

test("parseGpxTrack reads track points and usable elevation", () => {
  const result = parseGpxTrack(`<?xml version="1.0"?>
    <gpx version="1.1">
      <trk><trkseg>
        <trkpt lat="47.1" lon="11.1"><ele>600</ele></trkpt>
        <trkpt lon="11.2" lat="47.2"><ele>620</ele></trkpt>
        <trkpt lat="47.3" lon="11.3"><ele>640</ele></trkpt>
      </trkseg></trk>
    </gpx>`);

  assert.equal(result.points.length, 3);
  assert.deepEqual(result.points[1], { lat: 47.2, lng: 11.2, ele: 620 });
  assert.equal(result.hasUsableElevation, true);
  assert.ok(result.distanceMeters > 20000);
});

test("parseGpxTrack falls back to route points", () => {
  const result = parseGpxTrack(`
    <gpx version="1.1">
      <rte>
        <rtept lat="49.0" lon="8.0"/>
        <rtept lat="49.1" lon="8.1"/>
      </rte>
    </gpx>`);

  assert.deepEqual(result.points, [
    { lat: 49, lng: 8, ele: null },
    { lat: 49.1, lng: 8.1, ele: null }
  ]);
  assert.equal(result.hasUsableElevation, false);
});

test("parseGpxTrack rejects documents without a usable route", () => {
  assert.throws(
    () => parseGpxTrack("<gpx><trk><trkseg><trkpt lat=\"x\" lon=\"8\"/></trkseg></trk></gpx>"),
    GpxValidationError
  );
});

test("buildGpxRoutingAnchors preserves bends while limiting request points", () => {
  const points = [];
  for (let index = 0; index <= 100; index += 1) {
    points.push({ lat: 49, lng: 8 + index / 10000 });
  }
  for (let index = 1; index <= 100; index += 1) {
    points.push({ lat: 49 + index / 10000, lng: 8.01 });
  }

  const anchors = buildGpxRoutingAnchors(points, 20);

  assert.ok(anchors.length <= 20);
  assert.deepEqual(anchors[0], { lat: 49, lng: 8 });
  assert.deepEqual(anchors.at(-1), { lat: 49.01, lng: 8.01 });
  assert.ok(anchors.some((point) => point.lat === 49 && point.lng === 8.01));
});
