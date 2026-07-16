import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeBrowserGpsBestEffortsPayload,
  persistBrowserGpsBestEfforts
} from "../src/services/browserGpsBestEffortsImportService.js";

const decoded = {
  workoutCount: 2,
  matchCount: 1,
  workouts: [
    {
      startTimeSec: 1_700_000_000,
      matches: [{ segmentId: 42, startOffset: 100, endOffset: 140, avgPower: 250, avgHeartRate: 150, avgCadence: 90, avgSpeed: 36.4 }]
    },
    { startTimeSec: 1_700_000_100, matches: [] }
  ]
};

test("validates and normalizes GBE1 matches", () => {
  const result = normalizeBrowserGpsBestEffortsPayload(decoded);
  assert.equal(result.workouts.length, 2);
  assert.equal(result.matchCount, 1);
  assert.equal(result.workouts[0].matches[0].avgSpeed, 36.4);
  assert.throws(() => normalizeBrowserGpsBestEffortsPayload({
    ...decoded,
    workouts: [decoded.workouts[0], decoded.workouts[0]]
  }), /Duplicate/);
});

test("replaces GBE1 matches with one bulk insert", async () => {
  const queryLog = [];
  const client = {
    async query(sql, params = []) {
      const normalizedSql = String(sql).trim();
      queryLog.push(normalizedSql);
      if (normalizedSql.startsWith("SELECT id, start_time")) {
        return { rows: params[1].map((startTime, index) => ({ id: index + 10, start_time: startTime })) };
      }
      if (normalizedSql.startsWith("SELECT id") && normalizedSql.includes("FROM gps_segments")) {
        return { rows: params[1].map((id) => ({ id })) };
      }
      if (normalizedSql.startsWith("DELETE FROM gps_segment_best_efforts")) return { rowCount: 2, rows: [] };
      if (normalizedSql.startsWith("INSERT INTO gps_segment_best_efforts")) return { rowCount: params[0].length, rows: [] };
      return { rowCount: 0, rows: [] };
    },
    release() {}
  };

  const result = await persistBrowserGpsBestEfforts({
    uid: 49,
    decoded,
    pool: { connect: async () => client }
  });
  assert.equal(result.workoutCount, 2);
  assert.equal(result.deletedMatchCount, 2);
  assert.equal(result.insertedMatchCount, 1);
  assert.equal(queryLog.filter((sql) => sql.startsWith("INSERT INTO gps_segment_best_efforts")).length, 1);
  assert.equal(queryLog[0], "BEGIN");
  assert.equal(queryLog.at(-1), "COMMIT");
});
