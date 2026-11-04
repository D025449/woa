import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import BrowserViewPreferenceService from "../src/public/js/view-preference-service.js";

import ViewPreferenceService, {
  normalizeAnalyticsState,
  normalizeSegmentsState,
  normalizeWorkoutLibraryState
} from "../src/services/viewPreferenceService.js";
import {
  createDefaultAnalyticsPreferences,
  mergeAnalyticsPreferences
} from "../src/public/js/analytics-preferences.js";

async function loadPreferenceController(fileName, methodNames) {
  const source = await readFile(new URL(`../src/public/js/${fileName}`, import.meta.url), "utf8");
  const methods = methodNames.map((name) => {
    const start = source.search(new RegExp(`^  (?:async )?${name}\\(`, "m"));
    assert.ok(start >= 0, `Controller method ${name} exists`);
    const rest = source.slice(start + 1);
    const next = rest.search(/\n {2}(?:async )?\w+\(/);
    return source.slice(start, next < 0 ? source.lastIndexOf("}") : start + 1 + next);
  });
  return new Function("ViewPreferenceService", "WORKOUT_LIBRARY_VIEW_KEY", "SEGMENTS_VIEW_KEY", "VIEW_PREFERENCE_SAVE_DELAY_MS", "ANALYTICS_VIEW_KEY", "writeWorkoutChartLayoutMode",
    `return class { ${methods.join("\n")} }`)(BrowserViewPreferenceService, "workout-library", "segments", 500, "analytics", () => {});
}

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
    chartLayoutMode: "bands",
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
    chartLayoutMode: "bands",
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
    chartLayoutMode: "columns",
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
  assert.equal("chartLayoutMode" in state, false);
  assert.equal("smoothingLevel" in state, false);
  assert.equal("bridgePowerCadenceZeros" in state, false);
});

test("persists only supported map renderers independently for workout, segment and analytics views", async () => {
  for (const normalize of [normalizeWorkoutLibraryState, normalizeSegmentsState, normalizeAnalyticsState]) {
    assert.equal(normalize({ mapRenderer: "3d" }).mapRenderer, "3d");
    assert.equal(normalize({ mapRenderer: "2d" }).mapRenderer, "2d");
    assert.equal("mapRenderer" in normalize({ mapRenderer: "other" }), false);
    assert.equal("mapRenderer" in normalize({}), false);
  }
  const rows = new Map();
  const db = {
    async query(sql, values) {
      const key = `${values[0]}:${values[1]}`;
      if (sql.includes("INSERT INTO")) {
        rows.set(key, { viewKey: values[1], state: JSON.parse(values[2]), version: 1 });
      }
      return { rows: rows.has(key) ? [rows.get(key)] : [] };
    }
  };
  await ViewPreferenceService.upsert(7, "workout-library", { mapRenderer: "3d" }, db);
  await ViewPreferenceService.upsert(7, "segments", { mapRenderer: "2d" }, db);
  await ViewPreferenceService.upsert(7, "analytics", { mapRenderer: "3d" }, db);
  assert.equal((await ViewPreferenceService.get(7, "workout-library", db)).state.mapRenderer, "3d");
  assert.equal((await ViewPreferenceService.get(7, "segments", db)).state.mapRenderer, "2d");
  assert.equal((await ViewPreferenceService.get(7, "analytics", db)).state.mapRenderer, "3d");
  assert.equal(await ViewPreferenceService.get(8, "segments", db), null);
});

test("analytics defaults to 2D and retains its renderer across chart preference changes", () => {
  const initial = createDefaultAnalyticsPreferences();
  assert.equal(initial.mapRenderer, "2d");
  initial.mapRenderer = "3d";
  const updated = mergeAnalyticsPreferences(initial, "powerCurve", { grouping: "year" });
  assert.equal(updated.mapRenderer, "3d");
  assert.equal(updated.powerCurve.grouping, "year");
});

test("analytics controller restores its map renderer and saves explicit choices with existing preferences", async () => {
  const Controller = await loadPreferenceController("analytics-controller.js", [
    "restoreAnalyticsPreferences", "handleMapRendererChange", "scheduleAnalyticsPreferenceSave", "persistAnalyticsPreferences"
  ]);
  const originalLoad = BrowserViewPreferenceService.load;
  const originalSave = BrowserViewPreferenceService.save;
  const saved = [];
  BrowserViewPreferenceService.save = async (key, state) => { saved.push({ key, state }); return state; };
  try {
    for (const storedState of [null, {}, { mapRenderer: "2d" }, { mapRenderer: "3d" }]) {
      BrowserViewPreferenceService.load = async (key) => { assert.equal(key, "analytics"); return storedState; };
      let restored;
      const controller = Object.assign(Object.create(Controller.prototype), {
        analyticsPreferences: createDefaultAnalyticsPreferences(),
        chartView: { applyPreferences() {} },
        mapView: { applyRendererPreference(mode) { restored = mode; } },
        preferenceSaveChain: Promise.resolve()
      });
      await controller.restoreAnalyticsPreferences();
      assert.equal(restored, storedState?.mapRenderer || "2d");
      assert.equal(controller.pendingPreferenceState, undefined);
      controller.handleMapRendererChange("3d");
      clearTimeout(controller.preferenceSaveTimer);
      controller.persistAnalyticsPreferences();
      await controller.preferenceSaveChain;
      assert.equal(saved.at(-1).key, "analytics");
      assert.equal(saved.at(-1).state.mapRenderer, "3d");
      assert.equal(saved.at(-1).state.grouping, "month");
    }
  } finally {
    BrowserViewPreferenceService.load = originalLoad;
    BrowserViewPreferenceService.save = originalSave;
  }
});

test("both controllers restore server map choices, default missing choices and save through view preferences", async () => {
  const WorkoutController = await loadPreferenceController("dashboard-new-controller.js", [
    "restoreWorkoutLibraryPreferences", "scheduleWorkoutLibraryPreferenceSave", "persistWorkoutLibraryPreferences"
  ]);
  const SegmentsController = await loadPreferenceController("segments-controller.js", [
    "restoreSegmentPreferences", "buildSegmentPreferenceState", "scheduleSegmentPreferenceSave", "persistSegmentPreferences"
  ]);
  const originalLoad = BrowserViewPreferenceService.load;
  const originalSave = BrowserViewPreferenceService.save;
  const saves = [];
  BrowserViewPreferenceService.save = async (key, state) => { saves.push({ key, state }); return state; };
  try {
    for (const [Controller, viewKey] of [[WorkoutController, "workout-library"], [SegmentsController, "segments"]]) {
      for (const storedState of [null, {}, { mapRenderer: "2d" }, { mapRenderer: "3d" }]) {
        let appliedRenderer;
        BrowserViewPreferenceService.load = async (key) => { assert.equal(key, viewKey); return storedState; };
        const controller = Object.assign(Object.create(Controller.prototype), {
          mapViewState: { mapRenderer: "3d", baseLayerMode: "topo" },
          uiState: { set() {} }, libraryState: { search: "test" },
          libraryView: { applyState() {} }, chartViewState: { seriesVisibility: {}, segmentVisibility: {} },
          mapView: { applyRendererPreference(mode) { appliedRenderer = mode; } },
          viewPreferenceSaveChain: Promise.resolve()
        });
        const expected = storedState?.mapRenderer || "2d";
        if (viewKey === "workout-library") {
          await controller.restoreWorkoutLibraryPreferences();
          assert.equal(appliedRenderer, expected);
        } else {
          await controller.restoreSegmentPreferences();
        }
        assert.equal(controller.mapViewState.mapRenderer, expected);
        assert.equal(controller.mapViewState.baseLayerMode, "topo");
        controller.mapViewState.mapRenderer = "3d";
        if (viewKey === "workout-library") {
          controller.scheduleWorkoutLibraryPreferenceSave(controller.libraryState);
          clearTimeout(controller.viewPreferenceSaveTimer);
          controller.persistWorkoutLibraryPreferences();
        } else {
          controller.scheduleSegmentPreferenceSave();
          clearTimeout(controller.viewPreferenceSaveTimer);
          controller.persistSegmentPreferences();
        }
        await controller.viewPreferenceSaveChain;
        assert.equal(saves.at(-1).key, viewKey);
        assert.equal(saves.at(-1).state.mapRenderer, "3d");
      }
    }
  } finally {
    BrowserViewPreferenceService.load = originalLoad;
    BrowserViewPreferenceService.save = originalSave;
  }
});

test("normalizes analytics chart grouping and legend visibility independently", () => {
  const state = normalizeAnalyticsState({
    workoutChartLayoutMode: "bands",
    grouping: "quarter",
    selectedPeriod: { grouping: "quarter", start: "2026-04-01" },
    selectedWorkout: { id: 85047, startOffset: 120, endOffset: 360 },
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
  assert.equal(state.workoutChartLayoutMode, "bands");
  assert.equal(state.grouping, "quarter");
  assert.deepEqual(state.selectedPeriod, { grouping: "quarter", start: "2026-04-01" });
  assert.deepEqual(state.selectedWorkout, { id: 85047, startOffset: 120, endOffset: 360 });
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

test("does not invent a persisted chart layout for legacy analytics preferences", () => {
  const state = normalizeAnalyticsState({ grouping: "month" });

  assert.equal("workoutChartLayoutMode" in state, false);
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

test("keeps only valid analytics selected-period anchors", () => {
  assert.deepEqual(normalizeAnalyticsState({
    selectedPeriod: { grouping: "week", start: "2026-08-17" }
  }).selectedPeriod, { grouping: "week", start: "2026-08-17" });

  assert.equal(normalizeAnalyticsState({
    selectedPeriod: { grouping: "day", start: "2026-08-17" }
  }).selectedPeriod, null);
  assert.equal(normalizeAnalyticsState({
    selectedPeriod: { grouping: "month", start: "2026-02-31" }
  }).selectedPeriod, null);
});

test("keeps analytics workout details only for their valid selected period", () => {
  assert.deepEqual(normalizeAnalyticsState({
    grouping: "month",
    selectedPeriod: { grouping: "month", start: "2026-08-01" },
    selectedWorkout: { id: 85047 }
  }).selectedWorkout, { id: 85047 });

  assert.deepEqual(normalizeAnalyticsState({
    grouping: "month",
    selectedPeriod: { grouping: "month", start: "2026-08-01" },
    selectedWorkout: { id: 85047, startOffset: 100.5, endOffset: 340.5 }
  }).selectedWorkout, { id: 85047, startOffset: 100.5, endOffset: 340.5 });

  assert.deepEqual(normalizeAnalyticsState({
    grouping: "month",
    selectedPeriod: { grouping: "month", start: "2026-08-01" },
    selectedWorkout: { id: 85047, startOffset: 400, endOffset: 100 }
  }).selectedWorkout, { id: 85047 });

  assert.equal(normalizeAnalyticsState({
    grouping: "month",
    selectedWorkout: { id: 85047 }
  }).selectedWorkout, null);
  assert.equal(normalizeAnalyticsState({
    grouping: "month",
    selectedPeriod: { grouping: "month", start: "2026-08-01" },
    selectedWorkout: { id: "not-a-workout" }
  }).selectedWorkout, null);
  assert.equal(normalizeAnalyticsState({
    grouping: "quarter",
    selectedPeriod: { grouping: "month", start: "2026-08-01" },
    selectedWorkout: { id: 85047 }
  }).selectedWorkout, null);
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

test("normalizes persisted segment filters and paging preferences", () => {
  assert.deepEqual(normalizeSegmentsState({
    segmentScope: "shared",
    bestEffortsScope: "all",
    bestEffortsPerUser: "3",
    bestEffortsPeriod: "current_quarter",
    bestEffortsPageSize: 50,
    selectedSegmentId: 42
  }), {
    segmentScope: "shared",
    bestEffortsScope: "all",
    bestEffortsPerUser: "3",
    bestEffortsPeriod: "current_quarter",
    bestEffortsPageSize: 50
  });
});

test("rejects unsupported persisted segment preferences safely", () => {
  assert.deepEqual(normalizeSegmentsState({
    segmentScope: "public",
    bestEffortsScope: "friends",
    bestEffortsPerUser: "10",
    bestEffortsPeriod: "last_90_days",
    bestEffortsPageSize: 100
  }), {
    segmentScope: "mine",
    bestEffortsScope: "mine",
    bestEffortsPerUser: "all",
    bestEffortsPeriod: "all",
    bestEffortsPageSize: 25
  });
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

test("accepts the segments view key", async () => {
  const db = {
    async query(_sql, params) {
      return {
        rows: [{
          viewKey: params[1],
          state: JSON.parse(params[2]),
          version: 1,
          updatedAt: new Date("2026-09-25T10:00:00Z")
        }]
      };
    }
  };

  const result = await ViewPreferenceService.upsert(7, "segments", {
    segmentScope: "all",
    bestEffortsPeriod: "current_year",
    bestEffortsPageSize: 10
  }, db);

  assert.equal(result.state.segmentScope, "all");
  assert.equal(result.state.bestEffortsPeriod, "current_year");
  assert.equal(result.state.bestEffortsPageSize, 10);
});
