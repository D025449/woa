import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeWorkoutLocalPostprocessPayload,
  persistWorkoutLocalPostprocess
} from "../src/services/workoutLocalPostprocessImportService.js";

test("normalizes WPP1 rows into database segment values", () => {
  const result = normalizeWorkoutLocalPostprocessPayload({
    workoutCount: 1,
    segmentCount: 2,
    workouts: [{
      startTimeSec: 1_700_000_000,
      recordCount: 100,
      segments: [
        { type: 1, start: 10, end: 40, duration: 30, avgPower: 250, avgHeartRate: 150, avgCadence: 90, avgSpeed: 8.25, altimeters: 3000 },
        { type: 2, start: 20, end: 24, duration: 5, avgPower: 400, avgHeartRate: 160, avgCadence: 95, avgSpeed: 9.5, altimeters: 1000 }
      ]
    }]
  });
  assert.equal(result.segmentCount, 2);
  assert.deepEqual(result.workouts[0].segments.map((segment) => segment.segmenttype), ["auto", "crit"]);
  assert.equal(result.workouts[0].segments[0].avg_speed, 8.25);
});

test("rejects invalid segment duration before persistence", () => {
  assert.throws(() => normalizeWorkoutLocalPostprocessPayload({
    workoutCount: 1,
    segmentCount: 1,
    workouts: [{
      startTimeSec: 1_700_000_000,
      recordCount: 100,
      segments: [{ type: 2, start: 20, end: 24, duration: 4, avgPower: 400, avgHeartRate: 160, avgCadence: 95, avgSpeed: 9.5, altimeters: 1000 }]
    }]
  }), /duration/);
});

test("validates segment offsets against workout records instead of GPS points", () => {
  assert.throws(() => normalizeWorkoutLocalPostprocessPayload({
    workoutCount: 1,
    segmentCount: 1,
    workouts: [{
      startTimeSec: 1_700_000_000,
      recordCount: 100,
      segments: [{ type: 2, start: 90, end: 100, duration: 11, avgPower: 400, avgHeartRate: 160, avgCadence: 95, avgSpeed: 9.5, altimeters: 1000 }]
    }]
  }), /record range/);

  assert.doesNotThrow(() => normalizeWorkoutLocalPostprocessPayload({
    workoutCount: 1,
    segmentCount: 1,
    workouts: [{
      startTimeSec: 1_700_000_000,
      recordCount: 2_000,
      segments: [{ type: 2, start: 0, end: 1_799, duration: 1_800, avgPower: 300, avgHeartRate: 150, avgCadence: 90, avgSpeed: 8, altimeters: 0 }]
    }]
  }));
});

test("persists WPP1 workouts in one transaction and configured batches", async () => {
  const queryLog = [];
  const client = {
    async query(sql, params = []) {
      const normalizedSql = String(sql).trim();
      queryLog.push(normalizedSql);
      if (normalizedSql.startsWith("SELECT id, start_time")) {
        return {
          rows: params[1].map((startTime, index) => ({
            id: index + 1,
            start_time: startTime,
            points_count: 100
          }))
        };
      }
      if (normalizedSql.startsWith("DELETE FROM workout_segments")) return { rowCount: 7, rows: [] };
      if (normalizedSql.startsWith("INSERT INTO workout_segments")) return { rowCount: params[0].length, rows: [] };
      return { rowCount: 0, rows: [] };
    },
    release() {}
  };
  const workoutCount = 5;
  const decoded = {
    workoutCount,
    segmentCount: workoutCount,
    workouts: Array.from({ length: workoutCount }, (_, index) => ({
      startTimeSec: 1_700_000_000 + index,
      recordCount: 100,
      segments: [{ type: 2, start: 1, end: 5, duration: 5, avgPower: 300, avgHeartRate: 150, avgCadence: 90, avgSpeed: 8, altimeters: 0 }]
    }))
  };

  const result = await persistWorkoutLocalPostprocess({
    uid: 49,
    decoded,
    pool: { connect: async () => client },
    batchWorkoutCount: 2
  });

  assert.equal(result.insertedSegmentCount, workoutCount);
  assert.equal(result.deletedSegmentCount, 7);
  assert.equal(result.batchCount, 3);
  assert.equal(queryLog.filter((sql) => sql.startsWith("INSERT INTO workout_segments")).length, 3);
  assert.equal(queryLog[0], "BEGIN");
  assert.equal(queryLog.at(-1), "COMMIT");
});
