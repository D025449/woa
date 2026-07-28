import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAdaptiveChartResolutionLevels,
  selectAdaptiveChartResolution
} from "../src/public/js/adaptive-chart-resolution.js";

function workoutWithRows(recordCount) {
  return {
    length: recordCount,
    smoothingConfigs: [],
    getAsStrideArray({ smoothing }) {
      this.smoothingConfigs.push(smoothing);
      const data = new Float64Array(recordCount * 7);
      for (let index = 0; index < recordCount; index += 1) {
        const offset = index * 7;
        data[offset] = index;
        data[offset + 1] = 200 + index;
        data[offset + 2] = 120;
        data[offset + 3] = 80;
        data[offset + 4] = 30;
        data[offset + 5] = 500;
        data[offset + 6] = index / 100;
      }
      return { data, rowCount: recordCount + 1 };
    }
  };
}

test("adaptive chart levels retain original x positions and the final sample", () => {
  const workout = workoutWithRows(12);
  const levels = buildAdaptiveChartResolutionLevels(workout, "automatic", [1, 5]);
  const levelFive = levels.get(5);

  assert.deepEqual(
    Array.from(levelFive.data).filter((_, index) => index % 7 === 0),
    [0, 5, 10, 11]
  );
  assert.equal(levelFive.rowCount, 13);
});

test("adaptive chart smooths power more strongly than heart rate", () => {
  const workout = workoutWithRows(20);
  buildAdaptiveChartResolutionLevels(workout, "automatic", [15]);

  assert.ok(workout.smoothingConfigs[0].power > workout.smoothingConfigs[0].hr);
});

test("adaptive chart chooses coarse data for long ranges and raw data when zoomed", () => {
  assert.equal(selectAdaptiveChartResolution({
    visibleSeconds: 36_000,
    chartWidth: 500,
    smoothingLevel: "automatic"
  }), 120);
  assert.equal(selectAdaptiveChartResolution({
    visibleSeconds: 300,
    chartWidth: 1_000,
    smoothingLevel: "automatic"
  }), 1);
});

test("disabled smoothing always selects the raw resolution", () => {
  assert.equal(selectAdaptiveChartResolution({
    visibleSeconds: 36_000,
    chartWidth: 1_000,
    smoothingLevel: "off"
  }), 1);
});

test("visible duration caps adaptive chart resolution", () => {
  const select = (visibleSeconds) => selectAdaptiveChartResolution({
    visibleSeconds,
    chartWidth: 100,
    smoothingLevel: "automatic"
  });

  assert.equal(select(90 * 60), 5);
  assert.equal(select((90 * 60) + 1), 15);
  assert.equal(select(3 * 60 * 60), 15);
  assert.equal(select((3 * 60 * 60) + 1), 60);
  assert.equal(select(6 * 60 * 60), 60);
  assert.equal(select((6 * 60 * 60) + 1), 120);
});

test("manual smoothing keeps one-second chart resolution", () => {
  for (const smoothingLevel of ["light", "medium", "strong", "veryStrong"]) {
    assert.equal(selectAdaptiveChartResolution({
      visibleSeconds: 36_000,
      chartWidth: 100,
      smoothingLevel
    }), 1);
  }
});
