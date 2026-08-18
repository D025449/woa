import assert from "node:assert/strict";
import test from "node:test";

import {
  buildChartDataZoom,
  readChartZoomRange
} from "../src/public/js/chart-data-zoom.js";

test("chart sliders apply their data only after one completed drag", () => {
  const [inside, slider] = buildChartDataZoom();

  assert.equal(inside.filterMode, "none");
  assert.equal(slider.filterMode, "none");
  assert.equal(slider.realtime, false);
  assert.equal(slider.brushSelect, true);
});

test("chart zoom can filter the visible range before rendering dense series", () => {
  const [inside, slider] = buildChartDataZoom({ filterMode: "filter" });

  assert.equal(inside.filterMode, "filter");
  assert.equal(slider.filterMode, "filter");
});

test("chart zoom can retain inside zoom while hiding its slider", () => {
  const [inside, slider] = buildChartDataZoom({ slider: { show: false } });

  assert.equal(inside.type, "inside");
  assert.equal(slider.type, "slider");
  assert.equal(slider.show, false);
});

test("chart zoom range survives a dataset resolution change", () => {
  const range = readChartZoomRange({
    getOption: () => ({ dataZoom: [{ start: 23.5, end: 61.25 }] })
  });

  assert.deepEqual(range, { start: 23.5, end: 61.25 });
  assert.deepEqual(readChartZoomRange(null), { start: 0, end: 100 });
});
