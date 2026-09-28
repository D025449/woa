import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import ChartView from "../src/public/js/chart-view.js";

const labels = {
  power: "Power",
  heartRate: "Heart rate",
  cadence: "Cadence",
  speed: "Speed",
  altitude: "Altitude",
  leftRightBalance: "Balance",
  axisPower: "W",
  axisHeartCadence: "bpm / rpm",
  axisSpeed: "km/h",
  axisAltitude: "m",
  axisLeftRightBalance: "%"
};

function createWorkoutObject() {
  const rows = [
    { power: 200, hr: 130, cadence: 82, speed: 30, altitude: 410 },
    { power: 320, hr: 165, cadence: 96, speed: 44, altitude: 425 }
  ];
  return {
    length: rows.length,
    getMetricsAt(index) {
      return rows[index];
    }
  };
}

function createView(layoutMode = "bands") {
  const view = Object.create(ChartView.prototype);
  view.chartLayoutMode = layoutMode;
  view.seriesAvailability = {
    power: true,
    heartRate: true,
    cadence: true,
    speed: true,
    altitude: true,
    leftRightBalance: false
  };
  view.seriesVisibility = {
    power: true,
    heartRate: true,
    cadence: true,
    speed: true,
    altitude: true,
    leftRightBalance: false
  };
  view.smoothingLevel = "automatic";
  view.bridgePowerCadenceZeros = false;
  view.yAxisBoundsCache = new WeakMap();
  view.getSegmentHeaderGridTop = () => 40;
  view.formatXAxisLabel = (value) => String(value);
  return view;
}

test("band layout assigns one synchronized x and y axis to every visible metric", () => {
  const view = createView();
  const workoutObject = createWorkoutObject();
  const layout = view.buildChartLayoutOptions(workoutObject, labels, { min: 0, max: 100 });
  const series = view.buildSeriesDefinitions(labels);

  assert.equal(layout.grid.length, 5);
  assert.equal(layout.xAxis.length, 5);
  assert.equal(layout.yAxis.length, 5);
  assert.deepEqual(view.getDataZoomXAxisIndexes(), [0, 1, 2, 3, 4]);
  assert.deepEqual(series.map((entry) => entry.xAxisIndex), [0, 1, 2, 3, 4]);
  assert.deepEqual(series.map((entry) => entry.yAxisIndex), [0, 1, 2, 3, 4]);
  assert.deepEqual(series.map((entry) => entry.lineStyle.width), [0, 0, 0, 0, 0]);
  assert.deepEqual(series.map((entry) => entry.areaStyle.origin), [
    "start",
    "start",
    "start",
    "start",
    "start"
  ]);
  assert.deepEqual(layout.xAxis.map((axis) => axis.axisLabel.show), [false, false, false, false, true]);
});

test("band layout removes a hidden metric and compacts the remaining axes", () => {
  const view = createView();
  const fullLayout = view.buildChartLayoutOptions(
    createWorkoutObject(),
    labels,
    { min: 0, max: 100 }
  );
  const fullBottom = fullLayout.grid.at(-1).top + fullLayout.grid.at(-1).height;
  view.seriesVisibility.cadence = false;
  const layout = view.buildChartLayoutOptions(createWorkoutObject(), labels, { min: 0, max: 100 });
  const series = view.buildSeriesDefinitions(labels);
  const compactBottom = layout.grid.at(-1).top + layout.grid.at(-1).height;

  assert.equal(layout.grid.length, 4);
  assert.ok(layout.grid[0].height > fullLayout.grid[0].height);
  assert.equal(compactBottom, fullBottom);
  assert.deepEqual(series.map((entry) => entry.id), [
    "workout-series-power",
    "workout-series-heartRate",
    "workout-series-speed",
    "workout-series-altitude"
  ]);
  assert.deepEqual(series.map((entry) => entry.yAxisIndex), [0, 1, 2, 3]);
});

test("band layout fills the client height before requiring vertical scrolling", () => {
  const view = createView();
  view.container = { parentElement: { clientHeight: 360 } };

  const layout = view.buildChartLayoutOptions(
    createWorkoutObject(),
    labels,
    { min: 0, max: 100 }
  );
  const chartBottom = layout.grid.at(-1).top + layout.grid.at(-1).height + 72;

  assert.equal(chartBottom, 360);
  assert.ok(layout.grid.every((grid) => grid.height > 10));
});

test("band layout permits scrolling only after every band reaches ten pixels", () => {
  const view = createView();
  view.container = { parentElement: { clientHeight: 150 } };

  const layout = view.buildChartLayoutOptions(
    createWorkoutObject(),
    labels,
    { min: 0, max: 100 }
  );
  const chartBottom = layout.grid.at(-1).top + layout.grid.at(-1).height + 72;

  assert.ok(layout.grid.every((grid) => grid.height === 10));
  assert.ok(chartBottom > view.container.parentElement.clientHeight);
});

test("band chart CSS height stores only the ten-pixel overflow threshold", () => {
  const view = createView();
  const classes = new Set();
  const properties = new Map();
  view.container = {
    parentElement: { clientHeight: 360 },
    classList: {
      add: (value) => classes.add(value),
      contains: (value) => classes.has(value)
    },
    style: {
      getPropertyValue: (key) => properties.get(key) || "",
      setProperty: (key, value) => properties.set(key, value)
    }
  };

  view.syncChartContainerHeight();

  assert.equal(properties.get("--workout-chart-band-height"), "218px");
  assert.equal(classes.has("workout-chart--bands"), true);
});

test("overlay layout retains the shared coordinate system", () => {
  const view = createView("overlay");
  const layout = view.buildChartLayoutOptions(createWorkoutObject(), labels, { min: 0, max: 100 });
  const series = view.buildSeriesDefinitions(labels);

  assert.equal(Array.isArray(layout.grid), false);
  assert.equal(Array.isArray(layout.xAxis), false);
  assert.equal(view.getDataZoomXAxisIndexes(), 0);
  assert.deepEqual(series.map((entry) => entry.xAxisIndex), [0, 0, 0, 0, 0]);
  assert.deepEqual(series.map((entry) => entry.yAxisIndex), [0, 1, 1, 2, 3]);
  assert.equal(series[0].lineStyle.width, 1.8);
  assert.equal(series[0].lineStyle.opacity, 1);
  assert.deepEqual(series[0].areaStyle, { color: "transparent", opacity: 0 });
  assert.equal(series.at(-1).areaStyle.opacity, 0.18);
  assert.ok(series.at(-1).z < series[0].z);
});

test("switching from bands to overlay explicitly restores lines and removes metric fills", () => {
  const view = createView("bands");
  const bandSeries = view.buildSeriesDefinitions(labels);

  assert.equal(bandSeries[0].lineStyle.opacity, 0);
  assert.ok(bandSeries[0].areaStyle.opacity > 0);

  view.chartLayoutMode = "overlay";
  const overlaySeries = view.buildSeriesDefinitions(labels);
  const altitudeSeries = overlaySeries.find((entry) => entry.id === "workout-series-altitude");
  const measurementSeries = overlaySeries.filter((entry) => entry.id !== "workout-series-altitude");

  assert.ok(measurementSeries.every((entry) => entry.lineStyle.opacity === 1));
  assert.ok(measurementSeries.every((entry) => entry.areaStyle.opacity === 0));
  assert.equal(altitudeSeries.areaStyle.opacity, 0.18);
  assert.ok(measurementSeries.every((entry) => altitudeSeries.z < entry.z));
});

test("workout and analytics views expose the shared chart-layout control", async () => {
  const [workoutTemplate, analyticsTemplate] = await Promise.all([
    fs.readFile(new URL("../src/views/dashboard-new.ejs", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/views/analytics.ejs", import.meta.url), "utf8")
  ]);

  assert.match(workoutTemplate, /id="dashboard-chart-layout-toggle-slot"/u);
  assert.match(analyticsTemplate, /id="dashboard-chart-layout-toggle-slot"/u);
  assert.match(workoutTemplate, /class="workout-chart-scroll"/u);
  assert.match(analyticsTemplate, /class="workout-chart-scroll"/u);
});

test("workout chart roots clip stale ECharts canvas dimensions during resize", async () => {
  const [workoutCss, analyticsCss] = await Promise.all([
    fs.readFile(new URL("../src/public/css/dashboard-new.css", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/public/css/analytics.css", import.meta.url), "utf8")
  ]);

  assert.match(workoutCss, /#workout-chart\s*\{[^}]*overflow:\s*hidden;/su);
  assert.match(analyticsCss, /#workout-chart\s*\{[^}]*overflow:\s*hidden;/su);
});

test("every locale contains chart-layout labels", async () => {
  for (const locale of ["de", "en", "es", "fr", "it", "pt"]) {
    const messages = JSON.parse(await fs.readFile(
      new URL(`../src/public/i18n/${locale}.json`, import.meta.url),
      "utf8"
    ));
    for (const key of [
      "chartLayoutLabel",
      "chartLayoutAria",
      "chartLayoutOverlay",
      "chartLayoutBands"
    ]) {
      assert.equal(typeof messages.dashboardNewPage[key], "string", `${locale}.${key}`);
    }
  }
});
