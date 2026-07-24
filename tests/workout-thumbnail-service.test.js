import assert from "node:assert/strict";
import test from "node:test";

import WorkoutThumbnailService from "../src/services/workoutThumbnailService.js";

test("route thumbnail projects all GPS segments into shared bounds", () => {
  const thumbnail = WorkoutThumbnailService.createThumbnailPayload({
    gpsTrackSegments: [
      [[49, 8], [49.1, 8.1]],
      [[49.8, 8.8], [49.9, 8.9]]
    ]
  });

  const paths = [...thumbnail.content.matchAll(/<path d="([^"]+)"/g)]
    .map((match) => match[1]);

  assert.equal(paths.length, 2);

  const firstEnd = paths[0].match(/L ([\d.]+) ([\d.]+)$/);
  const secondStart = paths[1].match(/^M ([\d.]+) ([\d.]+)/);

  assert.ok(firstEnd);
  assert.ok(secondStart);
  assert.ok(Number(secondStart[1]) > Number(firstEnd[1]));
  assert.ok(Number(secondStart[2]) < Number(firstEnd[2]));
});

test("route thumbnail overlays workout and GPS segment ranges in Leaflet colors", () => {
  const thumbnail = WorkoutThumbnailService.createThumbnailPayload({
    gpsTrackSegments: [
      [[49, 8], [49.1, 8.1], [49.2, 8.2]]
    ],
    segmentOverlays: [
      {
        segmenttype: "auto",
        segments: [[
          { lat: 49, lng: 8 },
          { lat: 49.1, lng: 8.1 }
        ]]
      },
      {
        segmenttype: "gps",
        segments: [[
          { lat: 49.1, lng: 8.1 },
          { lat: 49.2, lng: 8.2 }
        ]]
      },
      {
        segmenttype: "crit",
        segments: [[
          { lat: 49.05, lng: 8.05 },
          { lat: 49.15, lng: 8.15 }
        ]]
      },
      {
        segmenttype: "manual",
        segments: [[
          { lat: 49.02, lng: 8.02 },
          { lat: 49.12, lng: 8.12 }
        ]]
      }
    ]
  });

  assert.match(thumbnail.content, /data-segment-type="auto"[^>]+stroke="#2587df"/);
  assert.match(thumbnail.content, /data-segment-type="gps"[^>]+stroke="#22a957"/);
  assert.match(thumbnail.content, /data-segment-type="crit"[^>]+stroke="#f59e0b"/);
  assert.match(thumbnail.content, /data-segment-type="manual"[^>]+stroke="#ef4444"/);
  assert.ok(
    thumbnail.content.indexOf('stroke="#ff4d4f"')
      < thumbnail.content.indexOf('data-segment-type="auto"')
  );
  assert.doesNotMatch(thumbnail.content, /data-segment-label|<text/);
  assert.match(thumbnail.content, /data-thumbnail-style="2"/);
  assert.equal(WorkoutThumbnailService.isCurrentRouteThumbnail(thumbnail), true);
});

test("only stale route thumbnails require regeneration", () => {
  assert.equal(WorkoutThumbnailService.isCurrentRouteThumbnail({
    kind: "route",
    content: "<svg></svg>"
  }), false);
  assert.equal(WorkoutThumbnailService.isCurrentRouteThumbnail({
    kind: "metrics-profile",
    content: "<svg></svg>"
  }), true);
});

test("route thumbnail removes sub-pixel GPS points while preserving endpoints", () => {
  const gpsTrack = Array.from({ length: 101 }, (_, index) => [
    49 + (index / 1000),
    8 + (index / 1000)
  ]);
  const thumbnail = WorkoutThumbnailService.createThumbnailPayload({ gpsTrack });

  assert.equal(thumbnail.renderStats.routeInputPointCount, 101);
  assert.equal(thumbnail.renderStats.routeRenderedPointCount, 2);
  assert.match(
    thumbnail.content,
    /<path d="M [\d.]+ [\d.]+ L [\d.]+ [\d.]+" fill="none" stroke="#ff4d4f"/
  );
});

test("indoor thumbnail renders power, heart rate, and cadence without altitude or GPS", () => {
  const workoutObject = {
    length: 240,
    getAltitudeAt: (index) => 400 + (index % 5),
    getPowerAt: (index) => 180 + (index % 40),
    getHrAt: (index) => 130 + (index % 15),
    getCadenceAt: (index) => 80 + (index % 10)
  };
  const thumbnail = WorkoutThumbnailService.createThumbnailPayload({
    workoutType: "indoor",
    gpsTrack: [[49, 8], [50, 9]],
    workoutObject
  });

  assert.equal(thumbnail.kind, "indoor-profile");
  assert.match(thumbnail.content, /stroke="#2563eb"/);
  assert.match(thumbnail.content, /stroke="#16a34a"/);
  assert.match(thumbnail.content, /stroke="#f59e0b"/);
  assert.ok(thumbnail.content.indexOf('stroke="#f59e0b"') < thumbnail.content.indexOf('stroke="#16a34a"'));
  assert.ok(thumbnail.content.indexOf('stroke="#16a34a"') < thumbnail.content.indexOf('stroke="#2563eb"'));
  assert.match(thumbnail.content, /stroke="#2563eb" stroke-width="1\.5"/);
  assert.match(thumbnail.content, /stroke="#16a34a" stroke-width="1\.2"/);
  assert.match(thumbnail.content, /stroke="#f59e0b" stroke-width="1\.1"/);
  assert.doesNotMatch(thumbnail.content, /stroke="#dc2626"/);
  assert.doesNotMatch(thumbnail.content, /rgba\(15, 118, 110/);
});

test("workout without GPS uses the compact metrics thumbnail", () => {
  const workoutObject = {
    length: 120,
    getAltitudeAt: (index) => 300 + index,
    getPowerAt: (index) => 150 + (index % 50),
    getHrAt: (index) => 120 + (index % 20),
    getCadenceAt: (index) => 75 + (index % 15)
  };
  const thumbnail = WorkoutThumbnailService.createThumbnailPayload({
    workoutType: "unknown",
    workoutObject
  });

  assert.equal(thumbnail.kind, "metrics-profile");
  assert.match(thumbnail.content, /stroke="#2563eb"/);
  assert.match(thumbnail.content, /stroke="#16a34a"/);
  assert.match(thumbnail.content, /stroke="#f59e0b"/);
  assert.doesNotMatch(thumbnail.content, /stroke="#0f766e"/);
});
