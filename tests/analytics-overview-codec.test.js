import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeAnalyticsOverview,
  encodeAnalyticsOverview
} from "../src/shared/AnalyticsOverviewCodec.js";

const durations = [5, 60, 960];

function buildFixture() {
  return {
    grouping: "month",
    durations,
    loadModelRows: [{
      date: "202607",
      tss_sum: 412,
      ctl_start: 43,
      ctl_end: 51,
      tsb_avg: -8,
      atl_avg: 57
    }],
    distributionRows: [{
      period: 202607,
      workoutCount: 12,
      classifiedWorkoutCount: 11,
      invalidHistogramCount: 1,
      activeSeconds: 1000,
      zeroSeconds: 120,
      missingSeconds: 5,
      unclassifiedSeconds: 20,
      zoneSeconds: {
        z1: 100,
        z2: 200,
        z3: 300,
        z4: 150,
        z5: 100,
        z6: 90,
        z7: 60
      }
    }],
    cpRows: [{
      grp: 202607,
      duration: 60,
      best_effort_avg_power: 418.25,
      best_effort_avg_heart_rate: 174.5,
      best_effort_avg_cadence: 101.25,
      best_effort_avg_speed: 42.75,
      best_effort_file_id: "74548",
      start_offset: 120,
      end_offset: 179,
      start_time: new Date("2026-07-13T08:15:00.789Z")
    }],
    rollingFtpRows: [{
      period: 202607,
      ftp: 287.4,
      confidence: 9,
      modelPointCount: 5,
      startTime: "2026-07-31T09:30:00.987Z"
    }]
  };
}

test("analytics overview binary codec preserves the chart contract", () => {
  const encoded = encodeAnalyticsOverview(buildFixture());
  const decoded = decodeAnalyticsOverview(encoded);

  assert.equal(new TextDecoder().decode(encoded.subarray(0, 4)), "AOV1");
  assert.equal(decoded.grouping, "month");
  assert.equal(decoded.loadModel.grouping, "month");
  assert.deepEqual(decoded.loadModel.data[0], {
    date: "202607",
    tss_sum: 412,
    ctl_start: 43,
    ctl_end: 51,
    tsb_avg: -8,
    atl_avg: 57
  });
  assert.equal(decoded.powerDistribution.data[0].zoneSeconds.z3, 300);
  assert.equal(decoded.powerDistribution.data[0].zonePercentages.z3, 30);
  assert.equal(decoded.powerCurve.grouping, "year_month");
  assert.deepEqual(decoded.powerCurve.durations, durations);

  const cp = decoded.powerCurve.data["202607"].CP60;
  assert.equal(cp.power, 418.25);
  assert.equal(cp.fileId, "74548");
  assert.equal(cp.startOffset, 120);
  assert.equal(cp.endOffset, 179);
  assert.equal(cp.startTime, "2026-07-13T08:15:00.000Z");

  const ftp = decoded.powerCurve.data["202607"].eFTP;
  assert.equal(ftp.power, 287);
  assert.equal(ftp.confidence, 9);
  assert.equal(ftp.modelPointCount, 5);
  assert.equal(ftp.startTime, "2026-07-31T09:30:00.000Z");
});

test("analytics overview decoder rejects truncated payloads", () => {
  const encoded = encodeAnalyticsOverview(buildFixture());
  assert.throws(
    () => decodeAnalyticsOverview(encoded.subarray(0, encoded.length - 1)),
    /Invalid analytics overview length/u
  );
});

test("analytics overview timestamps reject values before the FIT epoch", () => {
  const fixture = buildFixture();
  fixture.cpRows[0].start_time = new Date("1989-12-30T23:59:59.000Z");
  assert.throws(
    () => encodeAnalyticsOverview(fixture),
    /outside the FIT epoch range/u
  );
});
