import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRollingFtpSnapshots,
  buildRollingFtpTrend,
  groupRollingFtpSnapshots
} from "../src/shared/RollingFtpTrend.js";

function effortRows(workoutId, date, cp8, cp15) {
  const parsed = new Date(`${date}T12:00:00.000Z`);
  const year = parsed.getUTCFullYear();
  const month = parsed.getUTCMonth() + 1;
  const quarter = Math.ceil(month / 3);
  return [
    {
      workout_id: workoutId,
      start_time: parsed.toISOString(),
      year,
      year_quarter: Number(`${year}${quarter}`),
      year_month: Number(`${year}${String(month).padStart(2, "0")}`),
      year_week: Number(`${year}${String(workoutId).padStart(2, "0")}`),
      duration: 480,
      avg_power: cp8
    },
    {
      workout_id: workoutId,
      start_time: parsed.toISOString(),
      year,
      year_quarter: Number(`${year}${quarter}`),
      year_month: Number(`${year}${String(month).padStart(2, "0")}`),
      year_week: Number(`${year}${String(workoutId).padStart(2, "0")}`),
      duration: 900,
      avg_power: cp15
    }
  ];
}

function modelEffortRows(workoutId, date, powers) {
  const baseRows = effortRows(workoutId, date, powers[480], powers[900]);
  return [360, 720, 960].reduce((rows, duration) => [
    ...rows,
    { ...baseRows[0], duration, avg_power: powers[duration] }
  ], baseRows);
}

test("builds chronological FTP snapshots from a rolling effort window", () => {
  const rows = [
    ...effortRows(1, "2026-01-01", 300, 280),
    ...effortRows(2, "2026-01-15", 320, 300),
    ...effortRows(3, "2026-05-01", 240, 220)
  ];

  const snapshots = buildRollingFtpSnapshots(rows, { windowDays: 84 });
  assert.equal(snapshots.length, 3);
  assert.ok(snapshots[1].ftp > snapshots[0].ftp);
  assert.ok(snapshots[2].ftp < snapshots[0].ftp);
  assert.equal(snapshots[2].confidence, 1);
});

test("display grouping only aggregates the canonical snapshots", () => {
  const rows = [
    ...effortRows(1, "2026-07-01", 300, 280),
    ...effortRows(2, "2026-07-15", 330, 305),
    ...effortRows(3, "2026-08-15", 310, 290)
  ];
  const snapshots = buildRollingFtpSnapshots(rows);
  const months = groupRollingFtpSnapshots(snapshots, "month");
  const quarters = groupRollingFtpSnapshots(snapshots, "quarter");
  const years = groupRollingFtpSnapshots(snapshots, "year");

  assert.equal(months.length, 2);
  assert.equal(quarters.length, 1);
  assert.equal(years.length, 1);
  assert.equal(years[0].ftp, Math.max(...quarters.map((row) => row.ftp)));
  assert.equal(quarters[0].ftp, Math.max(...months.map((row) => row.ftp)));
});

test("returns the requested stable display periods", () => {
  const rows = [
    ...effortRows(1, "2025-12-01", 280, 260),
    ...effortRows(2, "2026-01-01", 300, 280)
  ];
  const years = buildRollingFtpTrend(rows, "year");

  assert.deepEqual(years.map((row) => row.period), [2025, 2026]);
});

test("fits the rolling FTP estimate across five power-duration points", () => {
  const powerAt = (duration) => 510 - (35 * Math.log(duration));
  const powers = Object.fromEntries(
    [360, 480, 720, 900, 960].map((duration) => [duration, powerAt(duration)])
  );
  const snapshots = buildRollingFtpSnapshots(modelEffortRows(1, "2026-07-01", powers));
  const expectedFtp = powerAt(1200) * 0.95;

  assert.equal(snapshots[0].modelPointCount, 5);
  assert.ok(Math.abs(snapshots[0].ftp - expectedFtp) < 0.01);
});

test("accepts one pivoted effort row per workout", () => {
  const powers = { 360: 340, 480: 330, 720: 310, 900: 300, 960: 295 };
  const longRows = modelEffortRows(1, "2026-07-01", powers);
  const wideRow = {
    ...longRows[0],
    duration: undefined,
    avg_power: undefined,
    ...Object.fromEntries(Object.entries(powers).map(([duration, power]) => [
      `power_${duration}`,
      power
    ]))
  };

  assert.deepEqual(
    buildRollingFtpSnapshots([wideRow]),
    buildRollingFtpSnapshots(longRows)
  );
});

test("downweights a short-duration outlier in the multi-point FTP fit", () => {
  const powerAt = (duration) => 510 - (35 * Math.log(duration));
  const powers = Object.fromEntries(
    [360, 480, 720, 900, 960].map((duration) => [duration, powerAt(duration)])
  );
  powers[360] += 80;
  const snapshots = buildRollingFtpSnapshots(modelEffortRows(1, "2026-07-01", powers));
  const expectedFtp = powerAt(1200) * 0.95;

  assert.ok(Math.abs(snapshots[0].ftp - expectedFtp) < 8);
});
