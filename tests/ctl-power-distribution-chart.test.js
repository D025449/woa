import assert from "node:assert/strict";
import test from "node:test";

import CTLChartView from "../src/public/js/ctl-chart-view.js";
import CPChartView from "../src/public/js/cp-chart-view.js";

test("load model renders power distribution as one replaceable zoomed series", () => {
  const calls = { clear: 0, options: [], actions: [] };
  const view = Object.create(CTLChartView.prototype);
  view.chart = {
    clear() { calls.clear += 1; },
    setOption(option) { calls.options.push(option); },
    dispatchAction(action) { calls.actions.push(action); }
  };
  view.handlers = {};
  view.t = (key) => key;
  view.locale = "de";
  view.seriesVisibility = {
    atl: true,
    ctl: true,
    tsb: true,
    tss: true
  };
  view.legendNameToKey = new Map([
    ["ATL_AVG", "atl"],
    ["CTL", "ctl"],
    ["TSB", "tsb"],
    ["TSS", "tss"]
  ]);

  view.renderChart("month", {
    grouping: "month",
    data: [{ date: 202608, atl_avg: 10, ctl_end: 20, tsb_avg: 5, tss_sum: 100 }]
  }, {
    grouping: "month",
    data: [{
      period: 202608,
      activeSeconds: 100,
      zonePercentages: { z1: 10, z2: 20, z3: 30, z4: 20, z5: 10, z6: 5, z7: 5 },
      zoneSeconds: { z1: 10, z2: 20, z3: 30, z4: 20, z5: 10, z6: 5, z7: 5 }
    }]
  });

  const option = calls.options[0];
  const distributionSeries = option.series.filter((series) => series.id === "intensity-distribution");
  const tssSeries = option.series.find((series) => series.id === "load-tss");
  assert.equal(calls.clear, 1);
  assert.equal(distributionSeries.length, 1);
  assert.equal(distributionSeries[0].type, "custom");
  assert.equal(tssSeries.type, "custom");
  const originalEcharts = globalThis.echarts;
  globalThis.echarts = {
    graphic: { clipRectByRect: (shape) => shape }
  };
  try {
    const augustStart = Date.parse("2026-08-01T00:00:00.000Z");
    const dayMs = 24 * 60 * 60 * 1000;
    const makeApi = (values) => ({
      value: (index) => values[index],
      coord: ([x, value]) => [
        ((typeof x === "number" ? x : Date.parse(x)) - augustStart) / dayMs,
        200 - value
      ],
      size: () => [40, 0],
      style: () => ({ fill: "test" })
    });
    const tssShape = tssSeries.renderItem(
      { coordSys: {} },
      makeApi(tssSeries.data[0].value)
    ).shape;
    const distributionShape = distributionSeries[0].renderItem(
      { coordSys: {} },
      makeApi(distributionSeries[0].data[0].value)
    ).children[0].shape;
    assert.deepEqual(
      { x: tssShape.x, width: tssShape.width },
      { x: distributionShape.x, width: distributionShape.width }
    );
    assert.equal(tssShape.x, 2);
    assert.ok(Math.abs(tssShape.width - 27) < 0.0001);
  } finally {
    globalThis.echarts = originalEcharts;
  }
  assert.deepEqual(option.legend.data, ["ATL_AVG", "CTL", "TSB", "TSS"]);
  const loadGrid = option.grid.find((grid) => grid.id === "load-model-grid");
  const distributionGrid = option.grid.find((grid) => grid.id === "distribution-grid");
  const distributionTitle = option.title[1];
  const distributionAxis = option.yAxis.find((axis) => axis.id === "distribution-zones-axis");
  assert.equal(distributionAxis.name, undefined);
  assert.ok(distributionTitle.top - (loadGrid.top + loadGrid.height) >= 39);
  assert.ok(distributionGrid.top - distributionTitle.top >= 32);
  assert.deepEqual(option.dataZoom.map((zoom) => zoom.xAxisIndex), [[0, 1], [0, 1]]);
  assert.deepEqual(option.dataZoom.map((zoom) => zoom.filterMode), ["weakFilter", "weakFilter"]);
  assert.deepEqual(tssSeries.encode.x, [0, 2, 3]);
  assert.deepEqual(distributionSeries[0].encode.x, [0, 8, 9]);
  assert.equal(tssSeries.data[0].value[0], Date.parse("2026-08-16T12:00:00.000Z"));
  assert.equal(tssSeries.data[0].value[2], Date.parse("2026-08-01T00:00:00.000Z"));
  assert.equal(tssSeries.data[0].value[3], Date.parse("2026-09-01T00:00:00.000Z") - 1);
  assert.equal(option.series.some((series) => series.name === "Z4"), false);
  assert.deepEqual(
    option.xAxis.map(({ min, max, boundaryGap }) => ({ min, max, boundaryGap })),
    [
      { min: Date.parse("2026-08-01"), max: Date.parse("2026-09-01T00:00:00.000Z") - 1, boundaryGap: [0, 0] },
      { min: Date.parse("2026-08-01"), max: Date.parse("2026-09-01T00:00:00.000Z") - 1, boundaryGap: [0, 0] }
    ]
  );
  assert.equal(option.xAxis[0].show, true);
  assert.equal(option.xAxis[0].axisLine.show, false);
  assert.equal(option.xAxis[0].axisLabel.show, false);
  assert.equal(option.xAxis[0].axisPointer.show, true);
  assert.equal(option.xAxis[1].axisLabel.show, false);
  const tssAxis = option.yAxis.find((axis) => axis.name === "TSS");
  assert.equal(tssAxis.axisLabel.formatter(999), "999");
  assert.equal(tssAxis.axisLabel.formatter(1200), "1,2K");
  assert.equal(tssAxis.axisLabel.formatter(3000), "3K");
  assert.equal(tssAxis.axisLabel.formatter(35000), "35K");

  view.setTimeRange({ start: 1, end: 2 }, { start: 0, end: 3 });
  assert.deepEqual(calls.options[1].xAxis.map((axis) => axis.id), [
    "load-time-axis",
    "distribution-time-axis"
  ]);
  assert.equal(calls.actions[0].batch.length, 2);
});

test("load model redistributes its internal sections when the chart height changes", () => {
  const calls = { resize: 0, options: [] };
  const classes = new Set();
  const properties = new Map();
  const body = {
    classList: {
      toggle(name, enabled) {
        if (enabled) classes.add(name);
        else classes.delete(name);
      }
    },
    style: {
      setProperty(name, value) { properties.set(name, value); },
      removeProperty(name) { properties.delete(name); }
    }
  };
  const view = Object.create(CTLChartView.prototype);
  view.hasDistributionGrid = true;
  view.chart = {
    resize() { calls.resize += 1; },
    getHeight() { return 640; },
    getDom() { return { parentElement: body }; },
    setOption(option) { calls.options.push(option); }
  };

  view.resize();

  assert.equal(calls.resize, 1);
  assert.equal(calls.options.length, 1);
  assert.equal(classes.has("has-distribution"), true);
  assert.equal(properties.get("--analytics-load-separator-top"), "469px");
  const loadGrid = calls.options[0].grid.find((grid) => grid.id === "load-model-grid");
  const distributionGrid = calls.options[0].grid.find((grid) => grid.id === "distribution-grid");
  assert.ok(loadGrid.height > 242);
  assert.ok(distributionGrid.top > 377);
});

test("critical-power points use the middle of their grouped period", () => {
  const view = Object.create(CPChartView.prototype);
  assert.equal(
    view.getPeriodMidpoint("year_month", 202608),
    Date.parse("2026-08-16T12:00:00.000Z")
  );
  assert.equal(
    view.getPeriodMidpoint("year_quarter", 20263),
    Date.parse("2026-08-16T00:00:00.000Z")
  );
});

test("analytics chart tooltips describe periods instead of their first date", () => {
  const loadView = Object.create(CTLChartView.prototype);
  loadView.currentGrouping = "quarter";
  loadView.locale = "de";
  const loadTooltip = loadView.formatTooltip([{
    axisValueLabel: "01.10.2025",
    marker: "",
    seriesName: "CTL",
    value: ["2025-10-01", 42],
    data: { value: ["2025-10-01", 42] }
  }]);
  assert.match(loadTooltip, /^Q4 2025<br>/u);

  const powerView = Object.create(CPChartView.prototype);
  powerView.currentGrouping = "year_month";
  powerView.locale = "de";
  const powerTooltip = powerView.formatTooltip([{
    axisValueLabel: "01.08.2026",
    marker: "",
    seriesName: "CP5S",
    value: ["2026-08-01", 900],
    data: { value: ["2026-08-01", 900] }
  }]);
  assert.match(powerTooltip, /^Aug\. 2026<br>/u);
});
