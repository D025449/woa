import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateStableYAxisBounds,
  findManualSegmentResizeEdge,
  getChartSeriesSamplingOption,
  getAvailableWorkoutSeries,
  hasMeaningfulDistanceSeries
} from "../src/public/js/chart-view.js";

test("manual segment resize hit testing is independent of render order", () => {
  const longerSegment = {
    id: 20,
    segmenttype: "manual",
    rowstate: "DB",
    start_offset: 10,
    end_offset: 90
  };
  const shorterSegment = {
    id: 10,
    segmenttype: "manual",
    rowstate: "DB",
    start_offset: 12,
    end_offset: 40
  };

  const hit = findManualSegmentResizeEdge({
    segments: [longerSegment, shorterSegment],
    pointerPixel: 12,
    toPixel: (offset) => offset,
    hitRadius: 10
  });

  assert.equal(hit.segment, shorterSegment);
  assert.equal(hit.edge, "start");
});

test("focused manual segment wins resize collision detection", () => {
  const focusedSegment = {
    id: 20,
    segmenttype: "manual",
    rowstate: "DB",
    start_offset: 10,
    end_offset: 90
  };
  const nearerSegment = {
    id: 10,
    segmenttype: "manual",
    rowstate: "DB",
    start_offset: 14,
    end_offset: 40
  };

  const hit = findManualSegmentResizeEdge({
    segments: [nearerSegment, focusedSegment],
    focusedSegment,
    pointerPixel: 15,
    toPixel: (offset) => offset,
    hitRadius: 10
  });

  assert.equal(hit.segment, focusedSegment);
  assert.equal(hit.edge, "start");
});

test("segment resize ignores non-manual and GPS segments", () => {
  const hit = findManualSegmentResizeEdge({
    segments: [
      { id: 1, segmenttype: "critical_power", rowstate: "DB", start_offset: 10, end_offset: 20 },
      { id: 2, segmenttype: "manual", isGPSSegment: true, rowstate: "DB", start_offset: 10, end_offset: 20 }
    ],
    pointerPixel: 10,
    toPixel: (offset) => offset,
    hitRadius: 10
  });

  assert.equal(hit, null);
});

test("chart disables ECharts sampling when smoothing is off", () => {
  assert.deepEqual(getChartSeriesSamplingOption("power", "off"), {});
  assert.deepEqual(getChartSeriesSamplingOption("speed", "off"), {});
});

test("chart keeps series-specific sampling in automatic mode", () => {
  assert.deepEqual(getChartSeriesSamplingOption("power", "automatic"), { sampling: "average" });
  assert.deepEqual(getChartSeriesSamplingOption("heartRate", "automatic"), { sampling: "lttb" });
});

function distanceWorkout(distances) {
  return {
    length: distances.length,
    hasDistanceSeries: () => true,
    getDistanceAt: (index) => distances[index]
  };
}

test("distance axis rejects an all-zero distance column", () => {
  assert.equal(hasMeaningfulDistanceSeries(distanceWorkout([0, 0, 0])), false);
});

test("distance axis rejects a negligible rounded distance span", () => {
  assert.equal(hasMeaningfulDistanceSeries(distanceWorkout([0, 25, 99])), false);
});

test("distance axis accepts a meaningful distance span", () => {
  assert.equal(hasMeaningfulDistanceSeries(distanceWorkout([12, 60, 112])), true);
});

test("distance axis requires an actual distance series", () => {
  assert.equal(hasMeaningfulDistanceSeries({
    length: 3,
    hasDistanceSeries: () => false,
    getDistanceAt: () => 1_000
  }), false);
});

function metricsWorkout(metrics) {
  return {
    length: metrics.length,
    getMetricsAt: (index) => metrics[index]
  };
}

test("chart hides measurement series containing only zero values", () => {
  assert.deepEqual(
    getAvailableWorkoutSeries(metricsWorkout([
      { power: 180, hr: 120, cadence: 82, speed: 0, altitude: 0 },
      { power: 190, hr: 124, cadence: 84, speed: 0, altitude: 0 }
    ])),
    {
      power: true,
      heartRate: true,
      cadence: true,
      speed: false,
      altitude: false,
      leftRightBalance: false
    }
  );
});

test("chart keeps real indoor speed and non-zero altitude series", () => {
  assert.deepEqual(
    getAvailableWorkoutSeries(metricsWorkout([
      { power: 0, hr: 0, cadence: 0, speed: 0, altitude: 0 },
      { power: 0, hr: 0, cadence: 0, speed: 31.2, altitude: -4 }
    ])),
    {
      power: false,
      heartRate: false,
      cadence: false,
      speed: true,
      altitude: true,
      leftRightBalance: false
    }
  );
});

test("chart exposes left/right balance only when the workout contains it", () => {
  const availability = getAvailableWorkoutSeries(metricsWorkout([
    { power: 180, leftRightBalance: Number.NaN },
    { power: 190, leftRightBalance: 49 }
  ]));

  assert.equal(availability.leftRightBalance, true);
});

test("chart hides compact missing left/right balance values", () => {
  const workout = metricsWorkout([
    { power: 180, leftRightBalance: null },
    { power: 190, leftRightBalance: Number.NaN }
  ]);
  workout.leftRightBalanceSeriesPct = Uint8Array.from([127, 127]);

  assert.equal(getAvailableWorkoutSeries(workout).leftRightBalance, false);
});

test("chart hides a constant 50 percent balance series mixed with missing values", () => {
  const workout = metricsWorkout([
    { power: 180, leftRightBalance: 50 },
    { power: 190, leftRightBalance: null },
    { power: 200, leftRightBalance: Number.NaN }
  ]);
  workout.leftRightBalanceSeriesPct = Float64Array.from([50, Number.NaN, Number.NaN]);

  assert.equal(getAvailableWorkoutSeries(workout).leftRightBalance, false);
});

test("chart derives stable rounded axes from unsmoothed workout metrics", () => {
  assert.deepEqual(
    calculateStableYAxisBounds(metricsWorkout([
      { power: 512, hr: 181, cadence: 96, speed: 72.4, altitude: 410 },
      { power: 233, hr: 142, cadence: 108, speed: 31.2, altitude: 860 }
    ])),
    {
      power: { min: 0, max: 550 },
      heartCadence: { min: 0, max: 200 },
      speed: { min: 0, max: 80 },
      altitude: { min: 380, max: 890 }
    }
  );
});

test("chart ignores compact missing altitude samples when fixing the altitude scale", () => {
  assert.deepEqual(
    calculateStableYAxisBounds(metricsWorkout([
      { power: 200, hr: 120, cadence: 80, speed: 30, altitude: 0 },
      { power: 210, hr: 125, cadence: 82, speed: 32, altitude: 500 }
    ])).altitude,
    { min: 490, max: 510 }
  );
});
