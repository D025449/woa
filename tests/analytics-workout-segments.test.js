import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
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

test("analytics forwards the same filtered CP workout to map renderers and chart on selection and legend changes", async () => {
  const source = await readFile(new URL("../src/public/js/analytics-controller.js", import.meta.url), "utf8");
  const method = source.match(/ {2}renderWorkoutDetailSegments\([\s\S]*?(?=\n {2}markSelectedWorkoutCard\()/)?.[0];
  assert.ok(method);
  const Controller = new Function("filterAnalyticsWorkoutSegments", `return class { ${method} }`)(filterAnalyticsWorkoutSegments);
  const powerCurve = createPowerCurve();
  let chartWorkout;
  let mapWorkout;
  let trackRenders = 0;
  const controller = Object.assign(Object.create(Controller.prototype), {
    detailWorkout: workout,
    cpChartView: powerCurve,
    chartView: {
      hideSegmentHoverTooltip() {}, clearSegmentHover() {}, clearSegmentFocus() {},
      updateWorkout(value) { chartWorkout = value; }
    },
    mapView: {
      renderTrack(value) { mapWorkout = value; trackRenders += 1; },
      renderSegmentOverlays(value) { mapWorkout = value; }
    }
  });
  controller.renderWorkoutDetailSegments({ renderTrack: true });
  assert.equal(mapWorkout, chartWorkout);
  assert.deepEqual(mapWorkout.segments.map((segment) => segment.id), [1, 3]);
  powerCurve.seriesVisibility = { cp5: false, cp300: false, cp60: true };
  controller.renderWorkoutDetailSegments();
  assert.equal(mapWorkout, chartWorkout);
  assert.equal(controller.mapView.currentWorkout, mapWorkout);
  assert.deepEqual(mapWorkout.segments.map((segment) => segment.id), [2]);
  assert.equal(trackRenders, 1);
  assert.equal(workout.segments.length, 7);
});

test("analytics measures a revealed map before fitting its workout track", async () => {
  const source = await readFile(new URL("../src/public/js/analytics-controller.js", import.meta.url), "utf8");
  const method = source.match(/ {2}async openWorkoutDetail\([\s\S]*?(?=\n {2}renderWorkoutDetailSegments\()/)?.[0];
  assert.ok(method);
  for (const validGps of [false, true]) {
    const calls = [];
    const selectedWorkout = { ...workout, validGps };
    const Controller = new Function("WorkoutService", "requestAnimationFrame", `return class { ${method} }`)(
      { loadWorkoutByRow: async () => selectedWorkout }, (callback) => callback()
    );
    const controller = Object.assign(Object.create(Controller.prototype), {
      detailPlaceholderElement: { hidden: false }, detailElement: { hidden: true },
      focusGridElement: { classList: { toggle(_name, hidden) { calls.push(["visibility", hidden]); } } },
      mapView: { resize() { calls.push(["resize"]); } }, chartView: { resize() {} },
      renderWorkoutDetailSegments(options) { calls.push(["render", options]); },
      renderWorkoutMeta() {}, markSelectedWorkoutCard() {}, rememberSelectedWorkout() {}, markSelectedPowerMetric() {}
    });
    assert.equal(await controller.openWorkoutDetail(42), true);
    assert.deepEqual(calls.slice(0, 3), [["visibility", !validGps], ["resize"], ["render", { renderTrack: true }]]);
    assert.equal(controller.selectedWorkoutId, 42);
  }
});
