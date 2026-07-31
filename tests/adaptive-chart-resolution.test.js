import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAdaptiveChartResolutionLevels,
  dequantizeChartSpeedInPlace,
  omitShortZeroRunsForChartInPlace,
  selectAdaptiveChartResolution,
  stabilizeQuantizedChartMetricInPlace
} from "../src/public/js/adaptive-chart-resolution.js";

function workoutWithRows(recordCount) {
  return {
    length: recordCount,
    smoothingConfigs: [],
    getAsStrideArray({ smoothing }) {
      this.smoothingConfigs.push(smoothing);
      const data = new Float64Array(recordCount * 8);
      for (let index = 0; index < recordCount; index += 1) {
        const offset = index * 8;
        data[offset] = index;
        data[offset + 1] = 200 + index;
        data[offset + 2] = 120;
        data[offset + 3] = 80;
        data[offset + 4] = 30;
        data[offset + 5] = 500;
        data[offset + 6] = index / 100;
        data[offset + 7] = 50 + (index % 3);
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
    Array.from(levelFive.data).filter((_, index) => index % 8 === 0),
    [0, 5, 10, 11]
  );
  assert.equal(levelFive.rowCount, 13);
});

test("adaptive chart smooths power more strongly than heart rate", () => {
  const workout = workoutWithRows(20);
  buildAdaptiveChartResolutionLevels(workout, "automatic", [15]);

  assert.ok(workout.smoothingConfigs[0].power > workout.smoothingConfigs[0].hr);
});

test("adaptive chart carries left/right balance through sampled levels", () => {
  const workout = workoutWithRows(12);
  const levelFive = buildAdaptiveChartResolutionLevels(workout, "automatic", [5]).get(5);

  assert.deepEqual(
    Array.from(levelFive.data).filter((_, index) => index % 8 === 7),
    [50, 52, 51, 52]
  );
  assert.equal(workout.smoothingConfigs[0].leftRightBalance, 15);
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

function buildQuantizedSpeedDataset(speedsKmh) {
  const strideSize = 7;
  const data = new Float64Array(speedsKmh.length * strideSize);
  let distanceKm = 0;

  speedsKmh.forEach((speed, index) => {
    if (index > 0) {
      distanceKm += (speed / 3.6) / 1000;
    }
    const offset = index * strideSize;
    data[offset] = index;
    data[offset + 4] = speed;
    data[offset + 6] = distanceKm;
  });

  return data;
}

test("chart speed dequantization removes a monotonic 1.8 km/h staircase", () => {
  const data = buildQuantizedSpeedDataset([
    28.8, 28.8, 30.6, 30.6, 32.4, 32.4, 30.6, 30.6, 28.8
  ]);

  dequantizeChartSpeedInPlace(data);

  assert.ok(Math.abs(data[3 * 7 + 4] - 30.96) < 1e-9);
  assert.ok(Math.abs(data[4 * 7 + 4] - 31.32) < 1e-9);
});

test("chart speed dequantization preserves stops and large real changes", () => {
  const stopped = buildQuantizedSpeedDataset([
    28.8, 28.8, 30.6, 0, 30.6, 30.6, 28.8
  ]);
  const sharpChange = buildQuantizedSpeedDataset([
    28.8, 28.8, 28.8, 45, 28.8, 28.8, 28.8
  ]);

  dequantizeChartSpeedInPlace(stopped);
  dequantizeChartSpeedInPlace(sharpChange);

  assert.equal(stopped[3 * 7 + 4], 0);
  assert.equal(sharpChange[3 * 7 + 4], 45);
});

function buildMetricDataset(values, valueOffset) {
  const strideSize = 7;
  const data = new Float64Array(values.length * strideSize);
  values.forEach((value, index) => {
    data[index * strideSize] = index;
    data[index * strideSize + valueOffset] = value;
  });
  return data;
}

test("chart metric stabilization softens quantized heart-rate stairs", () => {
  const data = buildMetricDataset([132, 132, 134, 134, 136], 2);

  stabilizeQuantizedChartMetricInPlace(data, {
    valueOffset: 2,
    weights: [1, 2, 3, 2, 1],
    maximumWindowRange: 8,
    maximumCorrection: 2
  });

  assert.ok(Math.abs(data[2 * 7 + 2] - (1202 / 9)) < 1e-9);
});

test("chart metric stabilization softens cadence stairs", () => {
  const data = buildMetricDataset([88, 90, 90], 3);

  stabilizeQuantizedChartMetricInPlace(data, {
    valueOffset: 3,
    weights: [1, 2, 1],
    maximumWindowRange: 12,
    maximumCorrection: 3
  });

  assert.equal(data[1 * 7 + 3], 89.5);
});

test("chart metric stabilization preserves dropouts and abrupt changes", () => {
  const dropout = buildMetricDataset([132, 132, 0, 134, 134], 2);
  const abrupt = buildMetricDataset([132, 132, 150, 132, 132], 2);
  const options = {
    valueOffset: 2,
    weights: [1, 2, 3, 2, 1],
    maximumWindowRange: 8,
    maximumCorrection: 2
  };

  stabilizeQuantizedChartMetricInPlace(dropout, options);
  stabilizeQuantizedChartMetricInPlace(abrupt, options);

  assert.equal(dropout[2 * 7 + 2], 0);
  assert.equal(abrupt[2 * 7 + 2], 150);
});

test("chart metric stabilization softens altitude stairs including sea level", () => {
  const data = buildMetricDataset([-1, 0, 0, 1, 1], 5);

  stabilizeQuantizedChartMetricInPlace(data, {
    valueOffset: 5,
    weights: [1, 2, 3, 2, 1],
    maximumWindowRange: 10,
    maximumCorrection: 1,
    requirePositive: false
  });

  assert.ok(Math.abs(data[2 * 7 + 5] - (2 / 9)) < 1e-9);
});

test("chart altitude stabilization preserves missing values and large changes", () => {
  const missing = buildMetricDataset([500, 500, Number.NaN, 501, 501], 5);
  const abrupt = buildMetricDataset([500, 500, 520, 500, 500], 5);
  const options = {
    valueOffset: 5,
    weights: [1, 2, 3, 2, 1],
    maximumWindowRange: 10,
    maximumCorrection: 1,
    requirePositive: false
  };

  stabilizeQuantizedChartMetricInPlace(missing, options);
  stabilizeQuantizedChartMetricInPlace(abrupt, options);

  assert.equal(Number.isNaN(missing[2 * 7 + 5]), true);
  assert.equal(abrupt[2 * 7 + 5], 520);
});

test("chart zero bridging omits short bounded power and cadence zero runs", () => {
  const power = [190, 200, 0, 0, 230, 240, 0];
  const cadence = [78, 80, 0, 0, 84, 86, 0];
  const data = new Float64Array(power.length * 7);
  power.forEach((value, index) => {
    data[index * 7] = index;
    data[index * 7 + 1] = value;
    data[index * 7 + 2] = index === 3 ? 0 : 130;
    data[index * 7 + 3] = cadence[index];
  });

  omitShortZeroRunsForChartInPlace(data, { maximumRunSeconds: 2 });

  assert.equal(Number.isNaN(data[1 * 7 + 1]), true);
  assert.equal(Number.isNaN(data[2 * 7 + 1]), true);
  assert.equal(Number.isNaN(data[3 * 7 + 1]), true);
  assert.equal(Number.isNaN(data[4 * 7 + 1]), true);
  assert.equal(Number.isNaN(data[1 * 7 + 3]), true);
  assert.equal(Number.isNaN(data[4 * 7 + 3]), true);
  assert.equal(data[3 * 7 + 2], 0);
  assert.equal(data[0 * 7 + 1], 190);
  assert.equal(data[5 * 7 + 1], 240);
  assert.equal(data[6 * 7 + 1], 0);
  assert.equal(data[6 * 7 + 3], 0);
});

test("chart zero bridging preserves runs longer than the configured limit", () => {
  const data = buildMetricDataset([190, 200, 0, 0, 0, 220, 230], 1);

  omitShortZeroRunsForChartInPlace(data, { maximumRunSeconds: 2 });

  assert.deepEqual(
    Array.from(data).filter((_, index) => index % 7 === 1),
    [190, 200, 0, 0, 0, 220, 230]
  );
});

test("chart zero bridging keeps boundary runs when outer anchors are unavailable", () => {
  const leading = buildMetricDataset([200, 0, 0, 220, 230], 1);
  const trailing = buildMetricDataset([190, 200, 0, 0, 220], 1);

  omitShortZeroRunsForChartInPlace(leading);
  omitShortZeroRunsForChartInPlace(trailing);

  assert.deepEqual(
    Array.from(leading).filter((_, index) => index % 7 === 1),
    [200, 0, 0, 220, 230]
  );
  assert.deepEqual(
    Array.from(trailing).filter((_, index) => index % 7 === 1),
    [190, 200, 0, 0, 220]
  );
});

test("chart zero bridging is applied with smoothing enabled", () => {
  const workout = workoutWithRows(8);
  workout.getAsStrideArray = ({ smoothing }) => {
    workout.smoothingConfigs.push(smoothing);
    const power = [180, 190, 0, 0, 210, 220, 230, 240];
    const data = new Float64Array(power.length * 8);
    power.forEach((value, index) => {
      data[index * 8] = index;
      data[index * 8 + 1] = value;
      data[index * 8 + 3] = value > 0 ? 80 : 0;
      data[index * 8 + 7] = 50;
    });
    return { data, rowCount: power.length + 1 };
  };

  const levels = buildAdaptiveChartResolutionLevels(
    workout,
    "light",
    [1],
    { bridgePowerCadenceZeros: true }
  );
  const source = levels.get(1).data;

  assert.equal(Number.isNaN(source[1 * 8 + 1]), true);
  assert.equal(Number.isNaN(source[4 * 8 + 1]), true);
  assert.equal(Number.isNaN(source[1 * 8 + 3]), true);
  assert.equal(Number.isNaN(source[4 * 8 + 3]), true);
});
