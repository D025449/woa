import assert from "node:assert/strict";
import test from "node:test";

import SegmentElevationView, {
  resolveElevationAxisBounds,
  resolveSegmentElevationSource
} from "../src/public/js/segment-elevation-view.js";
import { buildSegmentComparisonProfile } from "../src/shared/SegmentComparison.js";

function workout({ distances, powers, heartRates, altitudes }) {
  return {
    length: distances.length,
    getDistanceAt: (index) => distances[index],
    getPowerAt: (index) => powers[index],
    getHrAt: (index) => heartRates[index],
    getAltitudeAt: (index) => altitudes?.[index]
  };
}

test("segment comparison aligns workout metrics to the official segment distance", () => {
  const profile = buildSegmentComparisonProfile(workout({
    distances: [100, 110, 130, 160, 200],
    powers: [100, 200, 300, 400, 500],
    heartRates: [120, 125, 130, 135, 140],
    altitudes: [500, 502, 506, 512, 520]
  }), { wid: 42, start_offset: 1, end_offset: 4 }, 900);

  assert.equal(profile.alignment, "distance");
  assert.deepEqual(profile.points, [
    { distanceKm: 0, elapsedSeconds: 0, power: 200, heartRate: 125, altitude: 502 },
    { distanceKm: 0.2, elapsedSeconds: 1, power: 300, heartRate: 130, altitude: 506 },
    { distanceKm: 0.5, elapsedSeconds: 2, power: 400, heartRate: 135, altitude: 512 },
    { distanceKm: 0.9, elapsedSeconds: 3, power: 500, heartRate: 140, altitude: 520 }
  ]);
});

test("segment comparison falls back to elapsed progress and keeps the endpoint", () => {
  const profile = buildSegmentComparisonProfile(workout({
    distances: [0, 0, 0, 0, 0, 0],
    powers: [100, 110, 120, 130, 140, 150],
    heartRates: [120, 121, 122, 123, 124, 125]
  }), { wid: 7, start_offset: 0, end_offset: 5 }, 1000, { maxPoints: 3 });

  assert.equal(profile.alignment, "progress");
  assert.deepEqual(profile.points.map((point) => point.distanceKm), [0, 0.6, 1]);
  assert.equal(profile.points.length, 3);
  assert.equal(profile.points.at(-1).power, 150);
});

test("segment comparison preserves missing sensor values as chart gaps", () => {
  const profile = buildSegmentComparisonProfile(workout({
    distances: [100, 150, 200],
    powers: [250, null, 275],
    heartRates: [null, 145, Number.NaN],
    altitudes: [730, Number.NaN, 735]
  }), { wid: 9, start_offset: 0, end_offset: 2 }, 100);

  assert.deepEqual(profile.points.map(({ power, heartRate }) => ({ power, heartRate })), [
    { power: 250, heartRate: null },
    { power: null, heartRate: 145 },
    { power: 275, heartRate: null }
  ]);
  assert.deepEqual(profile.points.map((point) => point.altitude), [730, null, 735]);
});

test("segment comparison ignores legacy all-zero altitude series", () => {
  const profile = buildSegmentComparisonProfile(workout({
    distances: [0, 50, 100],
    powers: [200, 210, 220],
    heartRates: [130, 132, 134],
    altitudes: [0, 0, 0]
  }), { wid: 11, start_offset: 0, end_offset: 2 }, 100);

  assert.deepEqual(profile.points.map((point) => point.altitude), [null, null, null]);
});

test("segment comparison chart renders workout altitude on the shared elevation axis", () => {
  let chartOptions = null;
  const view = Object.create(SegmentElevationView.prototype);
  view.chart = {
    setOption: (options) => { chartOptions = options; },
    resize: () => {}
  };
  view.currentSegment = { distance: 1000, ascent: 25 };
  view.profileData = [[0, 100, 0], [1, 110, 1]];
  view.comparisons = [{
    workoutId: 42,
    rank: 1,
    points: [
      { distanceKm: 0, elapsedSeconds: 0, power: 250, heartRate: null, altitude: 90 },
      { distanceKm: 1, elapsedSeconds: 60, power: 270, heartRate: null, altitude: 120 }
    ]
  }];
  view.comparisonLoading = false;
  view.showHeartRate = false;
  view.t = (key) => key;
  view.panel = null;
  view.emptyState = null;
  view.stats = null;
  view.status = null;
  view.heartRateToggle = null;
  view.container = null;

  view.render();

  const segmentAltitudeSeries = chartOptions.series.find((series) => (
    series.yAxisIndex === 1 && series.lineStyle?.type !== "dotted"
  ));
  const workoutAltitudeSeries = chartOptions.series.find((series) => (
    series.yAxisIndex === 1 && series.lineStyle?.type === "dotted"
  ));
  assert.equal(segmentAltitudeSeries.smooth, false);
  assert.equal(segmentAltitudeSeries.connectNulls, workoutAltitudeSeries.connectNulls);
  assert.equal(segmentAltitudeSeries.sampling, workoutAltitudeSeries.sampling);
  assert.equal(segmentAltitudeSeries.lineStyle.width, workoutAltitudeSeries.lineStyle.width);
  assert.equal(segmentAltitudeSeries.areaStyle, undefined);
  assert.deepEqual(workoutAltitudeSeries.data, [[0, 90, 0], [1, 120, 60]]);
  assert.equal(chartOptions.yAxis[1].min, 60);
  assert.equal(chartOptions.yAxis[1].max, 160);
  assert.match(view.formatTooltip([{ data: [0, 250, 0] }]), /250 W · 90 m/u);
});

test("flat segment elevation uses a centered 100-meter minimum axis span", () => {
  assert.deepEqual(resolveElevationAxisBounds([105, 106, 107]), {
    min: 60,
    max: 160
  });
});

test("larger elevation ranges keep their natural padded axis bounds", () => {
  assert.deepEqual(resolveElevationAxisBounds([200, 400]), {
    min: 184,
    max: 416
  });
});

test("describes automatic, manual, and candidate elevation sources", () => {
  assert.deepEqual(resolveSegmentElevationSource({
    source: "workout",
    status: "confirmed",
    manual: false,
    sourceWorkoutId: 90384
  }), {
    key: "elevationSourceAutomatic",
    values: { workout: "W-90384" },
    kind: "automatic"
  });
  assert.deepEqual(resolveSegmentElevationSource({
    source: "workout",
    status: "confirmed",
    manual: true,
    sourceWorkoutId: 95541
  }), {
    key: "elevationSourceManual",
    values: { workout: "W-95541" },
    kind: "manual"
  });
  assert.deepEqual(resolveSegmentElevationSource({
    source: "external",
    status: "candidate",
    candidateCount: 10,
    clusterCount: 3
  }), {
    key: "elevationSourceExternalCandidateCounts",
    values: { cluster: 3, candidates: 10 },
    kind: "external"
  });
});

test("legacy stored workout elevation uses its original uniform distance positions", () => {
  const view = Object.create(SegmentElevationView.prototype);
  const profile = view.buildProfileData({
    distance: 1000,
    elevationProfile: { source: "workout", algorithmVersion: 1 },
    track: [
      { lat: 49, lng: 8, ele: 200 },
      { lat: 49.001, lng: 8, ele: 250 },
      { lat: 49.004, lng: 8, ele: 300 }
    ]
  });

  assert.deepEqual(profile.map((point) => point[0]), [0, 0.5, 1]);
});

test("current stored workout elevation follows the segment track geometry", () => {
  const view = Object.create(SegmentElevationView.prototype);
  const profile = view.buildProfileData({
    distance: 1000,
    elevationProfile: { source: "workout", algorithmVersion: 2 },
    track: [
      { lat: 49, lng: 8, ele: 200 },
      { lat: 49.001, lng: 8, ele: 250 },
      { lat: 49.004, lng: 8, ele: 300 }
    ]
  });

  assert.equal(profile[0][0], 0);
  assert.ok(Math.abs(profile[1][0] - 0.25) < 0.001);
  assert.equal(profile[2][0], 1);
});
