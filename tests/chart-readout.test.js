import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import { buildWorkoutMetricSnapshot } from "../src/public/js/chart-view.js";

test("chart readout snapshot clamps its index and preserves available metrics", () => {
  const workout = {
    length: 2,
    getDistanceAt: (index) => [0, 12_345][index],
    getMetricsAt: (index) => [
      { power: 180 },
      {
        power: 248.4,
        hr: 156,
        cadence: 91,
        speed: 36.24,
        altitude: 412,
        leftRightBalance: 49.2
      }
    ][index]
  };

  assert.deepEqual(buildWorkoutMetricSnapshot(workout, 99), {
    index: 1,
    distanceKm: 12.345,
    power: 248.4,
    heartRate: 156,
    cadence: 91,
    speed: 36.24,
    altitude: 412,
    leftRightBalance: 49.2
  });
});

test("dashboard uses a fixed chart readout while other chart views retain tooltips", async () => {
  const [template, chartSource, controllerSource, css] = await Promise.all([
    fs.readFile(new URL("../src/views/dashboard-new.ejs", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/public/js/chart-view.js", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/public/js/dashboard-new-controller.js", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/public/css/dashboard-new.css", import.meta.url), "utf8")
  ]);

  assert.match(template, /id="dashboard-chart-readout"/u);
  assert.match(template, /data-chart-readout-metric="(?:<%= key %>)"/u);
  assert.match(controllerSource, /readoutId: "dashboard-chart-readout"/u);
  assert.match(chartSource, /showContent: !this\.chartReadout/u);
  assert.match(chartSource, /this\.updateChartReadout\(index\)/u);
  assert.match(css, /\.dashboard-chart-stage\s*\{[\s\S]*?display: flex;[\s\S]*?flex-direction: column;/u);
  assert.match(css, /\.dashboard-master-detail #workout-chart\s*\{[\s\S]*?flex: 1 1 auto;/u);
});
