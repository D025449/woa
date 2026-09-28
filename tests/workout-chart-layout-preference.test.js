import assert from "node:assert/strict";
import test from "node:test";

import {
  WORKOUT_CHART_LAYOUT_STORAGE_KEY,
  normalizeWorkoutChartLayoutMode,
  readWorkoutChartLayoutMode,
  writeWorkoutChartLayoutMode
} from "../src/public/js/workout-chart-layout-preference.js";

function createStorage(initialValue = null) {
  const values = new Map();
  if (initialValue !== null) {
    values.set(WORKOUT_CHART_LAYOUT_STORAGE_KEY, initialValue);
  }
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value)
  };
}

test("normalizes only supported workout chart layout modes", () => {
  assert.equal(normalizeWorkoutChartLayoutMode("overlay"), "overlay");
  assert.equal(normalizeWorkoutChartLayoutMode("bands"), "bands");
  assert.equal(normalizeWorkoutChartLayoutMode("columns"), null);
  assert.equal(normalizeWorkoutChartLayoutMode(undefined, "overlay"), "overlay");
});

test("reads and writes the workout chart layout browser fallback", () => {
  const storage = createStorage();
  assert.equal(readWorkoutChartLayoutMode(storage), null);

  assert.equal(writeWorkoutChartLayoutMode("bands", storage), "bands");
  assert.equal(readWorkoutChartLayoutMode(storage), "bands");
  assert.equal(writeWorkoutChartLayoutMode("columns", storage), null);
  assert.equal(readWorkoutChartLayoutMode(storage), "bands");
});

test("keeps chart layout persistence safe when browser storage is unavailable", () => {
  const unavailableStorage = {
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("blocked"); }
  };

  assert.equal(readWorkoutChartLayoutMode(unavailableStorage), null);
  assert.equal(writeWorkoutChartLayoutMode("bands", unavailableStorage), "bands");
});
