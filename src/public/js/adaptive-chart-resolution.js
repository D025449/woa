export const ADAPTIVE_CHART_RESOLUTION_ENABLED = true;
export const ADAPTIVE_CHART_RESOLUTION_LEVELS = Object.freeze([1, 5, 15, 30, 60, 120]);

const MANUAL_SMOOTHING_CONFIGS = Object.freeze({
  off: Object.freeze({ power: 1, hr: 1, cadence: 1, speed: 1, altitude: 1 }),
  light: Object.freeze({ power: 10, hr: 5, cadence: 12, speed: 12, altitude: 6 }),
  medium: Object.freeze({ power: 20, hr: 10, cadence: 30, speed: 30, altitude: 10 }),
  strong: Object.freeze({ power: 35, hr: 18, cadence: 45, speed: 45, altitude: 18 }),
  veryStrong: Object.freeze({ power: 60, hr: 28, cadence: 60, speed: 60, altitude: 28 })
});

const SERIES_WINDOW_FACTORS = Object.freeze({
  power: 1.5,
  hr: 0.75,
  cadence: 1,
  speed: 1,
  altitude: 0.75
});

function normalizeLevel(level) {
  return Math.max(1, Math.round(Number(level) || 1));
}

function buildSmoothingConfig(level, smoothingLevel) {
  const normalizedLevel = normalizeLevel(level);
  if (smoothingLevel !== "automatic") {
    return {
      ...(MANUAL_SMOOTHING_CONFIGS[smoothingLevel] ?? MANUAL_SMOOTHING_CONFIGS.light)
    };
  }

  return Object.fromEntries(
    Object.entries(SERIES_WINDOW_FACTORS).map(([key, factor]) => ([
      key,
      Math.max(1, Math.round(normalizedLevel * factor))
    ]))
  );
}

function copyRow(source, target, sourceIndex, targetIndex, strideSize) {
  const sourceOffset = sourceIndex * strideSize;
  const targetOffset = targetIndex * strideSize;
  target.set(source.subarray(sourceOffset, sourceOffset + strideSize), targetOffset);
}

export function buildAdaptiveChartResolutionLevels(
  workoutObject,
  smoothingLevel = "automatic",
  levels = ADAPTIVE_CHART_RESOLUTION_LEVELS
) {
  const recordCount = Math.max(0, Number(workoutObject?.length) || 0);
  const strideSize = 7;
  const result = new Map();
  const activeLevels = smoothingLevel === "automatic" ? levels : [1];

  for (const requestedLevel of activeLevels) {
    const level = normalizeLevel(requestedLevel);
    const full = workoutObject.getAsStrideArray({
      smoothing: buildSmoothingConfig(level, smoothingLevel)
    });
    const source = full.data;

    if (level === 1 || recordCount <= 1) {
      result.set(level, {
        data: source,
        rowCount: recordCount + 1,
        resolutionSeconds: level
      });
      continue;
    }

    const sampledIndices = [];
    for (let index = 0; index < recordCount; index += level) {
      sampledIndices.push(index);
    }
    if (recordCount > 0 && sampledIndices.at(-1) !== recordCount - 1) {
      sampledIndices.push(recordCount - 1);
    }

    const sampled = new Float64Array(sampledIndices.length * strideSize);
    sampledIndices.forEach((sourceIndex, targetIndex) => {
      copyRow(source, sampled, sourceIndex, targetIndex, strideSize);
    });

    result.set(level, {
      data: sampled,
      rowCount: recordCount + 1,
      resolutionSeconds: level
    });
  }

  return result;
}

export function selectAdaptiveChartResolution({
  visibleSeconds,
  chartWidth,
  smoothingLevel = "automatic",
  levels = ADAPTIVE_CHART_RESOLUTION_LEVELS
} = {}) {
  const normalizedLevels = levels.map(normalizeLevel).sort((left, right) => left - right);

  if (smoothingLevel !== "automatic") {
    return normalizedLevels[0] ?? 1;
  }

  const secondsPerPixel = Math.max(0, Number(visibleSeconds) || 0)
    / Math.max(1, Number(chartWidth) || 1);
  const targetResolution = secondsPerPixel;
  const pixelResolution = normalizedLevels.find((level) => level >= targetResolution)
    ?? normalizedLevels.at(-1)
    ?? 1;
  const visibleRangeSeconds = Math.max(0, Number(visibleSeconds) || 0);
  const durationCap = visibleRangeSeconds <= 90 * 60
    ? 5
    : visibleRangeSeconds <= 3 * 60 * 60
      ? 15
      : visibleRangeSeconds <= 6 * 60 * 60
        ? 60
        : 120;
  const cappedLevels = normalizedLevels.filter((level) => level <= durationCap);
  const maximumResolution = cappedLevels.at(-1) ?? normalizedLevels[0] ?? 1;

  return Math.min(pixelResolution, maximumResolution);
}
