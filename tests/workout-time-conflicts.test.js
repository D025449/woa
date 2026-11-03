import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import pool from "../src/services/database.js";
import { FileDBService } from "../src/services/fileDBService.js";
import { excludeTimeConflictWorkouts } from "../src/shared/WorkoutImportConflicts.js";

const startTime = "2026-11-03T10:00:05.000Z";
const prepared = {
  fileRow: { uid: "42", start_time: startTime, end_time: "2026-11-03T11:00:00.000Z" }
};

test("prepared migration excludes same-user half-open overlaps only for valid time bounds", async () => {
  const sql = await readFile(new URL("../src/migrations/093_workout_time_exclusion.sql", import.meta.url), "utf8");
  assert.match(sql, /CREATE EXTENSION IF NOT EXISTS btree_gist/);
  assert.match(sql, /ADD CONSTRAINT workouts_no_time_overlap\s+EXCLUDE USING gist/);
  assert.match(sql, /uid WITH =/);
  assert.ok(sql.includes("tstzrange(start_time, end_time, '[)') WITH &&"));
  assert.match(sql, /start_time IS NOT NULL\s+AND end_time IS NOT NULL\s+AND end_time > start_time/);
  assert.doesNotMatch(sql, /\b(?:DELETE|UPDATE|DROP|DEFERRABLE)\b/i);
});

test("bulk inserts handle unique and exclusion conflicts without a conflict target", async (context) => {
  const calls = [];
  context.mock.method(FileDBService, "buildPreparedInsertParams", () => []);
  context.mock.method(pool, "query", async (sql) => {
    calls.push(sql);
    return { rows: [], rowCount: 0 };
  });

  const result = await FileDBService.insertPreparedFilesBulk([prepared]);

  assert.match(calls[0], /ON CONFLICT\s+DO NOTHING/);
  assert.doesNotMatch(calls[0], /ON CONFLICT\s*\(/);
  assert.deepEqual(result.insertedRows, []);
  assert.equal(result.existingRowsByKey.size, 0);
});

test("single inserts report skipped exclusion conflicts through the existing duplicate error", async (context) => {
  context.mock.method(FileDBService, "prepareInsertFilePayload", async () => prepared);
  context.mock.method(FileDBService, "buildPreparedInsertParams", () => []);
  context.mock.method(pool, "query", async (sql) => {
    assert.match(sql, /ON CONFLICT\s+DO NOTHING/);
    return { rows: [], rowCount: 0 };
  });

  await assert.rejects(
    FileDBService.insertFile(prepared.fileRow, [], {}, {}),
    /already a workout for this user/
  );
});

for (const conflict of [false, true]) {
  test(`overwrite ${conflict ? "rolls back when a deleted workout cannot be replaced" : "commits its replacement"} even without safe mode`, async (context) => {
    const calls = [];
    const replacement = { id: "11", uid: "42", start_time: startTime };
    const client = {
      async query(sql) {
        calls.push(String(sql).trim());
        if (sql.includes("DELETE FROM workouts")) {
          assert.match(sql, /RETURNING id, start_time/);
          return { rowCount: 1, rows: [{ id: "10", start_time: startTime }] };
        }
        if (sql.includes("INSERT INTO workouts")) {
          return { rowCount: conflict ? 0 : 1, rows: conflict ? [] : [replacement] };
        }
        if (sql.includes("SELECT id, uid, start_time")) return { rows: [replacement] };
        return { rowCount: 0, rows: [] };
      },
      release() { calls.push("release"); }
    };
    context.mock.method(FileDBService, "buildPreparedInsertParams", () => []);
    context.mock.method(pool, "connect", async () => client);
    context.mock.method(pool, "query", async () => assert.fail("Overwrite must use its transaction"));

    const promise = FileDBService.insertPreparedFilesBulk([prepared], {
      overwriteExisting: true,
      transactionalOverwrite: false
    });
    if (conflict) {
      await assert.rejects(promise, /existing workouts were preserved/);
      assert.equal(calls.includes("COMMIT"), false);
    } else {
      const result = await promise;
      assert.deepEqual(result.insertedRows, [replacement]);
      assert.equal(calls.includes("ROLLBACK"), false);
    }
    assert.equal(calls[0], "BEGIN");
    assert.equal(calls.at(-2), conflict ? "ROLLBACK" : "COMMIT");
    assert.equal(calls.at(-1), "release");
  });
}

for (const [itemsKey, countKey] of [["segments", "segmentCount"], ["matches", "matchCount"]]) {
  test(`bundle postprocessing excludes only time conflicts and recounts ${itemsKey}`, () => {
    const conflictStartTimeSec = Math.round(new Date(startTime).getTime() / 1000);
    const kept = { startTimeSec: conflictStartTimeSec + 3600, [itemsKey]: [{}] };
    const decoded = {
      workoutCount: 2,
      [countKey]: 3,
      workouts: [{ startTimeSec: conflictStartTimeSec, [itemsKey]: [{}, {}] }, kept]
    };

    const result = excludeTimeConflictWorkouts(decoded, [{
      code: "workout_time_conflict", startTime
    }]);

    assert.deepEqual(result.workouts, [kept]);
    assert.equal(result.workoutCount, 1);
    assert.equal(result[countKey], 1);
    assert.equal(decoded.workoutCount, 2);
    assert.equal(excludeTimeConflictWorkouts(decoded, [{ code: "other_error", startTime }]), decoded);
    assert.equal(excludeTimeConflictWorkouts(decoded), decoded);

    const empty = excludeTimeConflictWorkouts(decoded, [
      { code: "workout_time_conflict", startTime },
      { code: "workout_time_conflict", startTime: new Date(kept.startTimeSec * 1000).toISOString() }
    ]);
    assert.deepEqual(empty.workouts, []);
    assert.equal(empty.workoutCount, 0);
    assert.equal(empty[countKey], 0);
  });
}