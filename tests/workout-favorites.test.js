import assert from "node:assert/strict";
import test from "node:test";

import WorkoutFavoriteService from "../src/services/workoutFavoriteService.js";

test("adding a workout favorite is idempotent", async () => {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      return {
        rows: [{ workout_id: "42", created_at: new Date("2026-07-21T10:00:00Z") }]
      };
    }
  };

  const result = await WorkoutFavoriteService.add(7, 42, db);

  assert.equal(result.workout_id, "42");
  assert.deepEqual(calls[0].params, [7, 42]);
  assert.match(calls[0].sql, /ON CONFLICT \(uid, workout_id\) DO NOTHING/);
});

test("removing a workout favorite is scoped to user and workout", async () => {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [] };
    }
  };

  const result = await WorkoutFavoriteService.remove(7, 42, db);

  assert.equal(result, null);
  assert.deepEqual(calls[0].params, [7, 42]);
  assert.match(calls[0].sql, /WHERE uid = \$1\s+AND workout_id = \$2/);
});
