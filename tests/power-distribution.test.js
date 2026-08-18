import assert from "node:assert/strict";
import test from "node:test";

import { encodePowerHistogram } from "../src/shared/PowerHistogramCodec.js";
import { aggregatePowerDistribution } from "../src/shared/PowerDistribution.js";

function histogramRow(id, date, period, powers) {
  return {
    id,
    start_time: `${date}T12:00:00.000Z`,
    year_month: period,
    power_histogram: encodePowerHistogram({ powers: Uint16Array.from(powers) })
  };
}

test("aggregates sparse power histograms against the historical FTP", () => {
  const rows = [
    histogramRow(1, "2026-07-02", 202607, [0, 100, 140, 200, 260, 320, 400, 0xffff]),
    histogramRow(2, "2026-07-20", 202607, [150, 225, 300])
  ];
  const result = aggregatePowerDistribution(rows, [{
    startTime: "2026-07-01T12:00:00.000Z",
    ftp: 200
  }, {
    startTime: "2026-07-15T12:00:00.000Z",
    ftp: 300
  }], "month");

  assert.equal(result.length, 1);
  assert.equal(result[0].workoutCount, 2);
  assert.equal(result[0].classifiedWorkoutCount, 2);
  assert.equal(result[0].activeSeconds, 9);
  assert.equal(result[0].zeroSeconds, 1);
  assert.equal(result[0].missingSeconds, 1);
  assert.equal(result[0].zoneSeconds.z1, 2);
  assert.equal(result[0].zoneSeconds.z2, 2);
  assert.equal(result[0].zoneSeconds.z4, 2);
  assert.equal(result[0].zoneSeconds.z6, 1);
  assert.equal(result[0].zoneSeconds.z7, 2);
  assert.ok(Math.abs(Object.values(result[0].zonePercentages).reduce((sum, value) => sum + value, 0) - 100) < 1e-9);
});

test("reports positive power that predates the first FTP snapshot", () => {
  const result = aggregatePowerDistribution([
    histogramRow(1, "2025-12-01", 202512, [100, 200, 300])
  ], [{ startTime: "2026-01-01T00:00:00.000Z", ftp: 250 }], "month");

  assert.equal(result[0].activeSeconds, 0);
  assert.equal(result[0].unclassifiedSeconds, 3);
  assert.equal(result[0].classifiedWorkoutCount, 0);
});
