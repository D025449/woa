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
  assert.equal(calls.clear, 1);
  assert.equal(distributionSeries.length, 1);
  assert.equal(distributionSeries[0].type, "custom");
  assert.deepEqual(option.legend.data, ["ATL_AVG", "CTL", "TSB", "TSS", "distributionLegend"]);
  assert.deepEqual(option.dataZoom.map((zoom) => zoom.xAxisIndex), [[0, 1], [0, 1]]);
  assert.equal(option.series.some((series) => series.name === "Z4"), false);

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
