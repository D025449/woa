import assert from "node:assert/strict";
import test from "node:test";

import ViewPreferenceService, {
  normalizeWorkoutLibraryState
} from "../src/services/viewPreferenceService.js";

test("normalizes workout library preferences to supported values", () => {
  assert.deepEqual(normalizeWorkoutLibraryState({
    search: "power > 250",
    sort: "powerload",
    scope: "all",
    favoritesOnly: true,
    workoutType: "road",
    gpsFilter: "valid",
    ignored: "value"
  }), {
    search: "power > 250",
    sort: "powerload",
    scope: "all",
    favoritesOnly: true,
    workoutType: "road",
    gpsFilter: "valid"
  });
});

test("rejects unsupported workout library preference values safely", () => {
  assert.deepEqual(normalizeWorkoutLibraryState({
    sort: "DROP TABLE workouts",
    scope: "everyone",
    favoritesOnly: "true",
    workoutType: "gravel",
    gpsFilter: "sometimes"
  }), {
    search: "",
    sort: "newest",
    scope: "mine",
    favoritesOnly: false,
    workoutType: "all",
    gpsFilter: "all"
  });
});

test("normalizes persisted segment visibility without accepting extra keys", () => {
  const state = normalizeWorkoutLibraryState({
    segmentVisibility: {
      criticalPower: false,
      auto: true,
      manual: false,
      gps: true,
      injected: false
    }
  });

  assert.deepEqual(state.segmentVisibility, {
    criticalPower: false,
    auto: true,
    manual: false,
    gps: true
  });
});

test("keeps legacy preferences without segment visibility backward compatible", () => {
  const state = normalizeWorkoutLibraryState({ sort: "duration" });

  assert.equal("segmentVisibility" in state, false);
});

test("upserts one JSON preference row per user and view", async () => {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      return {
        rows: [{
          viewKey: "workout-library",
          state: JSON.parse(params[2]),
          version: 1,
          updatedAt: new Date("2026-07-24T10:00:00Z")
        }]
      };
    }
  };

  const result = await ViewPreferenceService.upsert(7, "workout-library", {
    sort: "duration",
    workoutType: "mountain"
  }, db);

  assert.equal(result.state.sort, "duration");
  assert.equal(result.state.workoutType, "mountain");
  assert.deepEqual(calls[0].params.slice(0, 2), [7, "workout-library"]);
  assert.match(calls[0].sql, /ON CONFLICT \(uid, view_key\)/);
});

test("rejects unknown view keys without touching the database", async () => {
  const db = {
    async query() {
      throw new Error("query must not run");
    }
  };

  await assert.rejects(
    ViewPreferenceService.get(7, "unknown-view", db),
    /Unsupported view preference key/
  );
});
