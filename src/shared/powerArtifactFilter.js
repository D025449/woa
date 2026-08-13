const DEFAULT_OPTIONS = Object.freeze({
  minimumPeakPowerW: 800,
  minimumPowerJumpW: 500,
  minimumBaselineRatio: 2.5,
  maximumArtifactSamples: 3,
  maximumStoppedArtifactSamples: 5,
  neighborhoodSamples: 5,
  maximumCadenceDeltaRpm: 12,
  maximumHeartRateDeltaBpm: 6,
  maximumSpeedDelta: 1.5,
  sentinelPowerMinimumW: 4090,
  sentinelPowerMaximumW: 4095,
  invalidPowerValue: null,
  invalidCadenceValue: null,
  invalidHeartRateValue: null,
  invalidSpeedValue: null
});

function isValidSample(value, invalidValue, requirePositive = false) {
  const numeric = Number(value);
  return Number.isFinite(numeric)
    && numeric !== invalidValue
    && (!requirePositive || numeric > 0);
}

function median(values) {
  if (values.length === 0) {
    return Number.NaN;
  }
  values.sort((left, right) => left - right);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 0
    ? (values[middle - 1] + values[middle]) / 2
    : values[middle];
}

function collectNeighborhoodMedian(series, start, end, radius, invalidValue, requirePositive = false) {
  if (!series) {
    return Number.NaN;
  }

  const values = [];
  const leftStart = Math.max(0, start - radius);
  const rightEnd = Math.min(series.length - 1, end + radius);

  for (let index = leftStart; index < start; index += 1) {
    if (isValidSample(series[index], invalidValue, requirePositive)) {
      values.push(Number(series[index]));
    }
  }
  for (let index = end + 1; index <= rightEnd; index += 1) {
    if (isValidSample(series[index], invalidValue, requirePositive)) {
      values.push(Number(series[index]));
    }
  }

  return median(values);
}

function collectRunMedian(series, start, end, invalidValue, requirePositive = false) {
  if (!series) {
    return Number.NaN;
  }

  const values = [];
  for (let index = start; index <= end; index += 1) {
    if (isValidSample(series[index], invalidValue, requirePositive)) {
      values.push(Number(series[index]));
    }
  }
  return median(values);
}

function isStoppedRun(series, start, end, invalidValue) {
  if (!series) {
    return false;
  }
  for (let index = start; index <= end; index += 1) {
    const value = Number(series[index]);
    if (!Number.isFinite(value) || value === invalidValue || value !== 0) {
      return false;
    }
  }
  return true;
}

function signalSupportsPeak(series, start, end, options) {
  const peakMedian = collectRunMedian(
    series,
    start,
    end,
    options.invalidValue,
    true
  );
  const neighborhoodMedian = collectNeighborhoodMedian(
    series,
    start,
    end,
    options.neighborhoodSamples,
    options.invalidValue,
    true
  );

  if (!Number.isFinite(peakMedian) || !Number.isFinite(neighborhoodMedian)) {
    return { available: false, supportsPeak: false };
  }

  return {
    available: true,
    // A power peak can be corroborated only by a rising signal. A cadence
    // collapse or deceleration is evidence against, not support for, the peak.
    supportsPeak: peakMedian - neighborhoodMedian > options.maximumDelta
  };
}

/**
 * Removes only short, unsupported power spikes. The input power array is changed
 * in place so the browser upload does not allocate another workout-sized column.
 */
export function filterPowerArtifactsInPlace(series, options = {}) {
  const config = { ...DEFAULT_OPTIONS, ...options };
  const powers = series?.powersW;
  const recordCount = Math.min(
    Number(series?.recordCount ?? powers?.length ?? 0),
    Number(powers?.length ?? 0)
  );
  const stats = {
    artifactCount: 0,
    correctedSampleCount: 0,
    maximumCorrectedPowerW: 0
  };

  if (recordCount < 3) {
    return stats;
  }

  let index = 1;
  while (index < recordCount - 1) {
    const value = Number(powers[index]);
    if (
      !isValidSample(value, config.invalidPowerValue)
      || value < config.minimumPeakPowerW
    ) {
      index += 1;
      continue;
    }

    const start = index;
    let end = index;
    let peakPower = value;
    while (
      end + 1 < recordCount - 1
      && isValidSample(powers[end + 1], config.invalidPowerValue)
      && Number(powers[end + 1]) >= config.minimumPeakPowerW
    ) {
      end += 1;
      peakPower = Math.max(peakPower, Number(powers[end]));
    }
    index = end + 1;

    const sampleCount = end - start + 1;
    const stoppedRun = isStoppedRun(
      series.cadencesRpm,
      start,
      end,
      config.invalidCadenceValue
    ) && isStoppedRun(
      series.speeds,
      start,
      end,
      config.invalidSpeedValue
    );
    const maximumSamples = stoppedRun
      ? config.maximumStoppedArtifactSamples
      : config.maximumArtifactSamples;
    if (sampleCount > maximumSamples) {
      continue;
    }

    const isSentinelRun = peakPower >= config.sentinelPowerMinimumW
      && peakPower <= config.sentinelPowerMaximumW;

    const leftPower = Number(powers[start - 1]);
    const rightPower = Number(powers[end + 1]);
    if (
      !isValidSample(leftPower, config.invalidPowerValue)
      || !isValidSample(rightPower, config.invalidPowerValue)
    ) {
      continue;
    }

    const baselinePower = collectNeighborhoodMedian(
      powers,
      start,
      end,
      config.neighborhoodSamples,
      config.invalidPowerValue
    );
    if (!isSentinelRun && (
      !Number.isFinite(baselinePower)
      || peakPower < baselinePower * config.minimumBaselineRatio
      || peakPower - leftPower < config.minimumPowerJumpW
      || peakPower - rightPower < config.minimumPowerJumpW
    )) {
      continue;
    }

    const supportSignals = [
      signalSupportsPeak(series.cadencesRpm, start, end, {
        invalidValue: config.invalidCadenceValue,
        maximumDelta: config.maximumCadenceDeltaRpm,
        neighborhoodSamples: config.neighborhoodSamples
      }),
      signalSupportsPeak(series.heartRatesBpm, start, end, {
        invalidValue: config.invalidHeartRateValue,
        maximumDelta: config.maximumHeartRateDeltaBpm,
        neighborhoodSamples: config.neighborhoodSamples
      }),
      signalSupportsPeak(series.speeds, start, end, {
        invalidValue: config.invalidSpeedValue,
        maximumDelta: config.maximumSpeedDelta,
        neighborhoodSamples: config.neighborhoodSamples
      })
    ];
    const availableSignalCount = supportSignals.filter((signal) => signal.available).length;
    const supportingSignalCount = supportSignals.filter(
      (signal) => signal.available && signal.supportsPeak
    ).length;
    const requiredSupportingSignalCount = Math.min(2, availableSignalCount);
    if (!isSentinelRun && (
      availableSignalCount === 0
      || supportingSignalCount >= requiredSupportingSignalCount
    )) {
      continue;
    }

    const interpolationSteps = sampleCount + 1;
    for (let offset = 1; offset <= sampleCount; offset += 1) {
      const ratio = offset / interpolationSteps;
      powers[start + offset - 1] = Math.round(
        leftPower + ((rightPower - leftPower) * ratio)
      );
    }

    stats.artifactCount += 1;
    stats.correctedSampleCount += sampleCount;
    stats.maximumCorrectedPowerW = Math.max(stats.maximumCorrectedPowerW, peakPower);
    config.onCorrectedRange?.({
      start,
      end,
      peakPower,
      sentinel: isSentinelRun
    });
  }

  return stats;
}
