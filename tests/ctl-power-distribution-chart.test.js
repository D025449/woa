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
    tss: true,
    intensityDistribution: true
  };
  view.legendNameToKey = new Map([
    ["ATL_AVG", "atl"],
    ["CTL", "ctl"],
    ["TSB", "tsb"],
    ["TSS", "tss"],
    ["distributionLegend", "intensityDistribution"]
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
    const makeApi = (values) => ({
      value: (index) => values[index],
      coord: ([, value]) => [120, 200 - value],
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
  } finally {
    globalThis.echarts = originalEcharts;
  }
  assert.deepEqual(option.legend[0].data, ["ATL_AVG", "CTL", "TSB", "TSS"]);
  assert.deepEqual(option.legend[1].data, ["distributionLegend"]);
  const loadGrid = option.grid.find((grid) => grid.id === "load-model-grid");
  const distributionGrid = option.grid.find((grid) => grid.id === "distribution-grid");
  const distributionTitle = option.title[1];
  const distributionAxis = option.yAxis.find((axis) => axis.id === "distribution-zones-axis");
  assert.equal(distributionAxis.name, undefined);
  assert.ok(distributionTitle.top - (loadGrid.top + loadGrid.height) >= 39);
  assert.ok(distributionGrid.top - distributionTitle.top >= 32);
  assert.deepEqual(option.dataZoom.map((zoom) => zoom.xAxisIndex), [[0, 1], [0, 1]]);
  assert.equal(option.series.some((series) => series.name === "Z4"), false);
  assert.deepEqual(
    option.xAxis.map(({ min, max, boundaryGap }) => ({ min, max, boundaryGap })),
    [
      { min: Date.parse("2026-08-01"), max: Date.parse("2026-08-01"), boundaryGap: [0, 0] },
      { min: Date.parse("2026-08-01"), max: Date.parse("2026-08-01"), boundaryGap: [0, 0] }
    ]
  );
  assert.equal(option.xAxis[0].show, true);
  assert.equal(option.xAxis[0].axisLine.show, false);
  assert.equal(option.xAxis[0].axisLabel.show, false);
  assert.equal(option.xAxis[0].axisPointer.show, true);
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
