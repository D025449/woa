import assert from "node:assert/strict";
import test from "node:test";

import ViewPreferenceService, {
  normalizeAnalyticsState,
  normalizeWorkoutLibraryState
} from "../src/services/viewPreferenceService.js";
import {
  createDefaultAnalyticsPreferences,
  mergeAnalyticsPreferences
} from "../src/public/js/analytics-preferences.js";

test("normalizes workout library preferences to supported values", () => {
  assert.deepEqual(normalizeWorkoutLibraryState({
    search: "power > 250",
    sort: "powerload",
    scope: "all",
    favoritesOnly: true,
    activityType: "cycling",
    workoutType: "road",
    terrainProfile: "mountainous",
    intensityProfile: "vo2max",
    gpsFilter: "valid",
    xAxisMode: "distance",
    smoothingLevel: "automatic",
    bridgePowerCadenceZeros: true,
    seriesVisibility: {
      power: true,
      heartRate: false,
      cadence: true,
      speed: false,
      altitude: true,
      leftRightBalance: false,
      injected: false
    },
    ignored: "value"
  }), {
    search: "power > 250",
    sort: "powerload",
    scope: "all",
    favoritesOnly: true,
    activityType: "cycling",
    workoutType: "road",
    terrainProfile: "mountainous",
    intensityProfile: "vo2max",
    gpsFilter: "valid",
    seriesVisibility: {
      power: true,
      heartRate: false,
      cadence: true,
      speed: false,
      altitude: true,
      leftRightBalance: false
    },
    xAxisMode: "distance",
    smoothingLevel: "automatic",
    bridgePowerCadenceZeros: true
  });
});

test("rejects unsupported workout library preference values safely", () => {
  assert.deepEqual(normalizeWorkoutLibraryState({
    sort: "DROP TABLE workouts",
    scope: "everyone",
    favoritesOnly: "true",
    activityType: "running",
    workoutType: "gravel",
    terrainProfile: "alpine",
    intensityProfile: "sprinty",
    gpsFilter: "sometimes",
    xAxisMode: "laps",
    smoothingLevel: "maximum",
    bridgePowerCadenceZeros: "true"
  }), {
    search: "",
    sort: "newest",
    scope: "mine",
    favoritesOnly: false,
    activityType: "all",
    workoutType: "all",
    terrainProfile: "all",
    intensityProfile: "all",
    gpsFilter: "all"
  });
});

test("accepts strength training as a persisted activity type filter", () => {
  assert.equal(normalizeWorkoutLibraryState({
    activityType: "strength_training"
  }).activityType, "strength_training");
});

test("accepts motorsport as a persisted workout type filter", () => {
  assert.equal(normalizeWorkoutLibraryState({
    workoutType: "motorsport"
  }).workoutType, "motorsport");
});

test("accepts altitude quality as a persisted terrain filter", () => {
  assert.equal(normalizeWorkoutLibraryState({
    terrainProfile: "altitude_invalid"
  }).terrainProfile, "altitude_invalid");
});

test("accepts VO2max as a persisted intensity filter", () => {
  assert.equal(normalizeWorkoutLibraryState({
    intensityProfile: "vo2max"
  }).intensityProfile, "vo2max");
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
  assert.equal("seriesVisibility" in state, false);
  assert.equal("xAxisMode" in state, false);
  assert.equal("smoothingLevel" in state, false);
  assert.equal("bridgePowerCadenceZeros" in state, false);
});

test("normalizes analytics chart grouping and legend visibility independently", () => {
  const state = normalizeAnalyticsState({
    grouping: "quarter",
    timeRange: { mode: "custom", start: "2026-01-15", end: "2026-08-17" },
    loadModel: {
      grouping: "week",
      seriesVisibility: { atl: false, ctl: true, injected: false }
    },
    powerCurve: {
      grouping: "year_month",
      seriesVisibility: { cp5: false, cp360: false, eftp: true, injected: false }
    }
  });

  assert.deepEqual(state.timeRange, {
    mode: "custom",
    start: "2026-01-15",
    end: "2026-08-17"
  });
  assert.equal(state.grouping, "quarter");
  assert.equal(state.loadModel.grouping, "week");
  assert.equal(state.loadModel.seriesVisibility.atl, false);
  assert.equal(state.loadModel.seriesVisibility.tsb, true);
  assert.equal(state.loadModel.seriesVisibility.intensityDistribution, undefined);
  assert.equal("injected" in state.loadModel.seriesVisibility, false);
  assert.equal(state.powerCurve.grouping, "year_month");
  assert.equal(state.powerCurve.seriesVisibility.cp5, false);
  assert.equal(state.powerCurve.seriesVisibility.cp360, false);
  assert.equal(state.powerCurve.seriesVisibility.cp12, undefined);
  assert.equal(state.powerCurve.seriesVisibility.eftp, true);
  assert.equal("injected" in state.powerCurve.seriesVisibility, false);
});

test("keeps only complete or slider-defined analytics time ranges", () => {
  assert.deepEqual(normalizeAnalyticsState({
    timeRange: { mode: "3m" }
  }).timeRange, { mode: "all" });

  assert.deepEqual(normalizeAnalyticsState({
    timeRange: { mode: "custom", start: "2026-02-31", end: "2026-08-17" }
  }).timeRange, { mode: "all" });

  assert.deepEqual(normalizeAnalyticsState({
    timeRange: { mode: "custom", start: "2026-08-18", end: "2026-08-17" }
  }).timeRange, { mode: "all" });
});

test("accepts shared load groupings and rejects unsupported power groupings", () => {
  const state = normalizeAnalyticsState({
    loadModel: { grouping: "quarter", seriesVisibility: { tss: false } },
    powerCurve: { grouping: "day", seriesVisibility: { cp960: false } }
  });

  assert.equal(state.loadModel.grouping, "quarter");
  assert.equal(state.loadModel.seriesVisibility.tss, false);
  assert.equal(state.powerCurve.grouping, "year");
  assert.equal(state.powerCurve.seriesVisibility.cp960, false);
});

test("merges one analytics chart update without overwriting the other chart", () => {
  const initial = createDefaultAnalyticsPreferences();
  const withLoadChange = mergeAnalyticsPreferences(initial, "loadModel", {
    grouping: "month",
    seriesVisibility: { tss: false }
  });
  const withPowerChange = mergeAnalyticsPreferences(withLoadChange, "powerCurve", {
    grouping: "year_week",
    seriesVisibility: { cp5: false }
  });

  assert.equal(withPowerChange.loadModel.grouping, "month");
  assert.equal(withPowerChange.loadModel.seriesVisibility.tss, false);
  assert.equal(withPowerChange.loadModel.seriesVisibility.ctl, true);
  assert.equal(withPowerChange.powerCurve.grouping, "year_week");
  assert.equal(withPowerChange.powerCurve.seriesVisibility.cp5, false);
  assert.deepEqual(withPowerChange.timeRange, { mode: "all" });
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
