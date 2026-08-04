import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateWorkoutSessions,
  mapWorkoutSummaryToFileRow
} from "../src/services/workoutSessionSummaryService.js";

test("aggregates workout sessions without depending on a FIT parser", () => {
  const aggregated = aggregateWorkoutSessions({
    sessions: [
      {
        start_time: "2026-01-01T10:00:00.000Z",
        timestamp: "2026-01-01T10:10:00.000Z",
        total_timer_time: 600,
        total_elapsed_time: 610,
        total_distance: 5000,
        avg_power: 200,
        max_power: 500
      },
      {
        start_time: "2026-01-01T10:10:00.000Z",
        timestamp: "2026-01-01T10:30:00.000Z",
        total_timer_time: 1200,
        total_elapsed_time: 1210,
        total_distance: 10000,
        avg_power: 250,
        max_power: 600
      }
    ]
  });

  assert.equal(aggregated.start_time, "2026-01-01T10:00:00.000Z");
  assert.equal(aggregated.end_time, "2026-01-01T10:30:00.000Z");
  assert.equal(aggregated.total_timer_time, 1800);
  assert.equal(aggregated.total_distance, 15000);
  assert.equal(aggregated.avg_power, 700 / 3);
  assert.equal(aggregated.max_power, 600);
});

test("maps an aggregated workout to the persisted summary row", () => {
  const row = mapWorkoutSummaryToFileRow({
    start_time: "2026-01-01T10:00:00.000Z",
    end_time: "2026-01-01T11:00:00.000Z",
    total_elapsed_time: 3600,
    total_timer_time: 3600,
    total_distance: 30000,
    total_cycles: 0,
    total_work: 720000,
    total_calories: 720,
    total_ascent: 500,
    total_descent: 500,
    avg_speed: 8.5,
    max_speed: 20,
    avg_power: 200,
    max_power: 700,
    avg_heart_rate: 140,
    max_heart_rate: 180,
    avg_cadence: 85,
    max_cadence: 110,
    nec_lat: 49,
    nec_long: 9,
    swc_lat: 48,
    swc_long: 8
  }, { uid: "1" }, 234.6);

  assert.equal(row.uid, "1");
  assert.equal(row.avg_speed, 30.6);
  assert.equal(row.max_speed, 72);
  assert.equal(row.avg_normalized_power, 235);
  assert.equal(row.year, 2026);
  assert.equal(row.month, 1);
  assert.equal(row.year_quarter, 20261);
});

test("derives persisted average speed when the session summary has none", () => {
  const row = mapWorkoutSummaryToFileRow({
    start_time: "2026-01-01T10:00:00.000Z",
    total_timer_time: 3389.499,
    total_distance: 27766.63,
    avg_speed: 0
  }, { uid: "1" }, 0);

  assert.ok(Math.abs(row.avg_speed - 29.491) < 0.001);
});
