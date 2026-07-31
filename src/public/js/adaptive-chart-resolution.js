export const ADAPTIVE_CHART_RESOLUTION_ENABLED = true;
export const ADAPTIVE_CHART_RESOLUTION_LEVELS = Object.freeze([1, 5, 15, 30, 60, 120]);

const MANUAL_SMOOTHING_CONFIGS = Object.freeze({
  off: Object.freeze({ power: 1, hr: 1, cadence: 1, speed: 1, altitude: 1, leftRightBalance: 1 }),
  light: Object.freeze({ power: 10, hr: 5, cadence: 12, speed: 12, altitude: 6, leftRightBalance: 15 }),
  medium: Object.freeze({ power: 20, hr: 10, cadence: 30, speed: 30, altitude: 10, leftRightBalance: 30 }),
  strong: Object.freeze({ power: 35, hr: 18, cadence: 45, speed: 45, altitude: 18, leftRightBalance: 45 }),
  veryStrong: Object.freeze({ power: 60, hr: 28, cadence: 60, speed: 60, altitude: 28, leftRightBalance: 60 })
});

const SERIES_WINDOW_FACTORS = Object.freeze({
  power: 1.5,
  hr: 0.75,
  cadence: 1,
  speed: 1,
  altitude: 0.75,
  leftRightBalance: 0.5
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

  const config = Object.fromEntries(
    Object.entries(SERIES_WINDOW_FACTORS).map(([key, factor]) => ([
      key,
      Math.max(1, Math.round(normalizedLevel * factor))
    ]))
  );
  config.leftRightBalance = Math.max(15, config.leftRightBalance);
  return config;
}

function copyRow(source, target, sourceIndex, targetIndex, strideSize) {
  const sourceOffset = sourceIndex * strideSize;
  const targetOffset = targetIndex * strideSize;
  target.set(source.subarray(sourceOffset, sourceOffset + strideSize), targetOffset);
}

export function dequantizeChartSpeedInPlace(data, {
  strideSize = 7,
  speedOffset = 4,
  distanceOffset = 6
} = {}) {
  const rowCount = Math.floor((data?.length || 0) / strideSize);
  const quantizationStepKmh = 1.8;
  const quantizationToleranceKmh = 0.05;
  const maximumCorrectionKmh = quantizationStepKmh * 2;

  // Five distance intervals reduce the 0.5 m storage step from 1.8 to 0.36 km/h.
  for (let index = 3; index < rowCount - 2; index += 1) {
    const speedIndex = index * strideSize + speedOffset;
    const rawSpeed = Number(data[speedIndex]);
    if (
      !Number.isFinite(rawSpeed)
      || rawSpeed <= 0
      || Math.abs(rawSpeed - Math.round(rawSpeed / quantizationStepKmh) * quantizationStepKmh)
        > quantizationToleranceKmh
    ) {
      continue;
    }

    let validMovingWindow = true;
    for (let cursor = index - 2; cursor <= index + 2; cursor += 1) {
      const previousDistance = Number(data[(cursor - 1) * strideSize + distanceOffset]);
      const currentDistance = Number(data[cursor * strideSize + distanceOffset]);
      if (
        !Number.isFinite(previousDistance)
        || !Number.isFinite(currentDistance)
        || currentDistance <= previousDistance
      ) {
        validMovingWindow = false;
        break;
      }
    }
    if (!validMovingWindow) {
      continue;
    }

    const startDistanceKm = Number(data[(index - 3) * strideSize + distanceOffset]);
    const endDistanceKm = Number(data[(index + 2) * strideSize + distanceOffset]);
    const reconstructedSpeed = (endDistanceKm - startDistanceKm) * 3600 / 5;
    if (
      !Number.isFinite(reconstructedSpeed)
      || reconstructedSpeed <= 0
      || Math.abs(reconstructedSpeed - rawSpeed) > maximumCorrectionKmh
    ) {
      continue;
    }

    data[speedIndex] = reconstructedSpeed;
  }

  return data;
}

export function stabilizeQuantizedChartMetricInPlace(data, {
  strideSize = 7,
  valueOffset,
  weights,
  maximumWindowRange,
  maximumCorrection,
  requirePositive = true
} = {}) {
  const rowCount = Math.floor((data?.length || 0) / strideSize);
  const normalizedWeights = Array.isArray(weights) ? weights : [];
  const radius = Math.floor(normalizedWeights.length / 2);
  const weightSum = normalizedWeights.reduce((sum, weight) => sum + weight, 0);
  if (
    !Number.isInteger(valueOffset)
    || radius < 1
    || normalizedWeights.length % 2 === 0
    || weightSum <= 0
  ) {
    return data;
  }

  const original = new Float64Array(rowCount);
  for (let index = 0; index < rowCount; index += 1) {
    original[index] = Number(data[index * strideSize + valueOffset]);
  }

  for (let index = radius; index < rowCount - radius; index += 1) {
    let weightedSum = 0;
    let minimum = Number.POSITIVE_INFINITY;
    let maximum = Number.NEGATIVE_INFINITY;
    let validWindow = true;

    for (let offset = -radius; offset <= radius; offset += 1) {
      const value = original[index + offset];
      if (!Number.isFinite(value) || (requirePositive && value <= 0)) {
        validWindow = false;
        break;
      }
      weightedSum += value * normalizedWeights[offset + radius];
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
    }

    if (!validWindow || maximum - minimum > maximumWindowRange) {
      continue;
    }

    const stabilized = weightedSum / weightSum;
    if (Math.abs(stabilized - original[index]) > maximumCorrection) {
      continue;
    }
    data[index * strideSize + valueOffset] = stabilized;
  }

  return data;
}

export function omitShortZeroRunsForChartInPlace(data, {
  strideSize = 7,
  valueOffsets = [1, 3],
  maximumRunSeconds = 30
} = {}) {
  const rowCount = Math.floor((data?.length || 0) / strideSize);
  const maximumRunLength = Math.max(0, Math.floor(Number(maximumRunSeconds) || 0));
  if (rowCount < 3 || maximumRunLength < 1) {
    return data;
  }

  for (const valueOffset of valueOffsets) {
    let index = 1;
    while (index < rowCount - 1) {
      if (Number(data[index * strideSize + valueOffset]) !== 0) {
        index += 1;
        continue;
      }

      const runStart = index;
      while (
        index < rowCount
        && Number(data[index * strideSize + valueOffset]) === 0
      ) {
        index += 1;
      }
      const runEnd = index - 1;
      const bridgeStart = runStart - 1;
      const bridgeEnd = index;
      const previousAnchorValue = bridgeStart > 0
        ? Number(data[(bridgeStart - 1) * strideSize + valueOffset])
        : Number.NaN;
      const nextAnchorValue = bridgeEnd < rowCount - 1
        ? Number(data[(bridgeEnd + 1) * strideSize + valueOffset])
        : Number.NaN;

      if (
        runEnd - runStart + 1 <= maximumRunLength
        && Number.isFinite(previousAnchorValue)
        && previousAnchorValue > 0
        && Number.isFinite(nextAnchorValue)
        && nextAnchorValue > 0
      ) {
        for (let cursor = bridgeStart; cursor <= bridgeEnd; cursor += 1) {
          data[cursor * strideSize + valueOffset] = Number.NaN;
        }
      }
    }
  }

  return data;
}

export function buildAdaptiveChartResolutionLevels(
  workoutObject,
  smoothingLevel = "automatic",
  levels = ADAPTIVE_CHART_RESOLUTION_LEVELS,
  { bridgePowerCadenceZeros = false } = {}
) {
  const recordCount = Math.max(0, Number(workoutObject?.length) || 0);
  const strideSize = 8;
  const result = new Map();
  const activeLevels = smoothingLevel === "automatic" ? levels : [1];

  for (const requestedLevel of activeLevels) {
    const level = normalizeLevel(requestedLevel);
    const smoothing = buildSmoothingConfig(level, smoothingLevel);
    const full = workoutObject.getAsStrideArray({
      smoothing,
      includeLeftRightBalance: true
    });
    const source = full.data;
    if (smoothing.speed <= 1) {
      dequantizeChartSpeedInPlace(source, { strideSize });
    }
    if (smoothing.hr <= 1) {
      stabilizeQuantizedChartMetricInPlace(source, {
        strideSize,
        valueOffset: 2,
        weights: [1, 2, 3, 2, 1],
        maximumWindowRange: 8,
        maximumCorrection: 2
      });
    }
    if (smoothing.cadence <= 1) {
      stabilizeQuantizedChartMetricInPlace(source, {
        strideSize,
        valueOffset: 3,
        weights: [1, 2, 1],
        maximumWindowRange: 12,
        maximumCorrection: 3
      });
    }
    if (smoothing.altitude <= 1) {
      stabilizeQuantizedChartMetricInPlace(source, {
        strideSize,
        valueOffset: 5,
        weights: [1, 2, 3, 2, 1],
        maximumWindowRange: 10,
        maximumCorrection: 1,
        requirePositive: false
      });
    }
    if (bridgePowerCadenceZeros) {
      omitShortZeroRunsForChartInPlace(source, { strideSize });
    }
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
