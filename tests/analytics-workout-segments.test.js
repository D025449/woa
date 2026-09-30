import assert from "node:assert/strict";
import test from "node:test";
import { filterAnalyticsWorkoutSegments } from "../src/public/js/analytics-workout-segments.js";
import CPChartView from "../src/public/js/cp-chart-view.js";
import ChartView from "../src/public/js/chart-view.js";

function createPowerCurve() {
  const view = Object.create(CPChartView.prototype);
  view.legendNameToKey = new Map([
    ["CP5S", "cp5"], ["CP1", "cp60"], ["CP5", "cp300"], ["FTP", "eftp"]
  ]);
  view.seriesVisibility = { cp60: false };
  return view;
}

const segments = [
  { id: 1, segmenttype: "crit", duration: 5, start_offset: 10, end_offset: 14 },
  { id: 2, segmenttype: "crit", duration: "60", start_offset: 20, end_offset: 79 },
  { id: 3, segmenttype: "crit", duration: 300, start_offset: 30, end_offset: 329 },
  { id: 4, segmenttype: "auto", duration: 5, start_offset: 10, end_offset: 14 },
  { id: 5, segmenttype: "manual", duration: 5, start_offset: 10, end_offset: 14 },
  { id: 6, segmenttype: "gps", isGPSSegment: true, duration: 5, start_offset: 10, end_offset: 14 },
  { id: 7, segmenttype: "crit", duration: 900, start_offset: 0, end_offset: 899 }
].map(Object.freeze);
const workout = Object.freeze({ id: 42, segments: Object.freeze(segments), workoutObject: {} });

test("analytics chart headers and areas contain only CP durations present and visible in the power curve", () => {
  const powerCurve = createPowerCurve();
  assert.deepEqual(powerCurve.getVisibleCriticalPowerDurations(), [5, 300]);
  const filtered = filterAnalyticsWorkoutSegments(workout, powerCurve.getVisibleCriticalPowerDurations());
  const chart = Object.create(ChartView.prototype);
  chart.currentWorkout = filtered;
  chart.xAxisMode = "time";
  assert.deepEqual(chart.buildMarkAreasForMode(filtered).map((area) => area[0].segmentId), [3, 1]);
  assert.deepEqual(filtered.segments.map((segment) => segment.id), [1, 3]);
  assert.equal(chart.getSegmentHeaderLayout().items.length, 2);
  assert.equal(filtered.workoutObject, workout.workoutObject);
});

test("switch changes can restore segments without mutating the original workout", () => {
  const powerCurve = createPowerCurve();
  filterAnalyticsWorkoutSegments(workout, powerCurve.getVisibleCriticalPowerDurations());
  powerCurve.seriesVisibility = { cp5: false, cp300: false, cp60: true };
  assert.deepEqual(
    filterAnalyticsWorkoutSegments(workout, powerCurve.getVisibleCriticalPowerDurations()).segments,
    [segments[1]]
  );
  powerCurve.seriesVisibility.cp60 = false;
  assert.deepEqual(filterAnalyticsWorkoutSegments(workout, powerCurve.getVisibleCriticalPowerDurations()).segments, []);
  assert.equal(workout.segments.length, 7);
});

test("the shared workout chart retains all segment types and durations by default", () => {
  const chart = Object.create(ChartView.prototype);
  chart.currentWorkout = workout;
  chart.xAxisMode = "time";
  assert.equal(chart.buildMarkAreasForMode(workout).length, 7);
  assert.equal(chart.getSegmentHeaderLayout().items.length, 7);
});
