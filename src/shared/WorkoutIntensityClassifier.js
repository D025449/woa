import { calculateNormalizedPowerFromSamples } from "./WorkoutEnergy.js";
import { buildIntensityTags } from "./WorkoutIntensityTags.js";

export const INTENSITY_FEATURE_VERSION = 1;
export const INTENSITY_CLASSIFIER_VERSION = 3;
export const INTENSITY_EFFORT_DURATIONS = Object.freeze([30, 60, 120, 240, 480, 900, 1200]);

const POWER_BUCKET_SECONDS = 15;
const POWER_HISTOGRAM_STEP_WATTS = 25;
const POWER_HISTOGRAM_BUCKETS = 41;
const MODEL_WINDOW_DAYS = 365;
const MODEL_TARGET_SAMPLE_COUNT = 20;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function finitePower(value, missingValue = null) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0 || (missingValue != null && numeric === missingValue)) {
    return 0;
  }
  return numeric;
}

function percentile(values, quantile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const position = clamp(quantile, 0, 1) * (sorted.length - 1);
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  if (lowerIndex === upperIndex) return sorted[lowerIndex];
  const ratio = position - lowerIndex;
  return sorted[lowerIndex] + ((sorted[upperIndex] - sorted[lowerIndex]) * ratio);
}

function overlaps(left, right) {
  const leftEndExclusive = left.endExclusive ?? (left.end + 1);
  const rightEndExclusive = right.endExclusive ?? (right.end + 1);
  return left.start < rightEndExclusive && right.start < leftEndExclusive;
}

function findTopNonOverlappingEfforts(prefixPower, recordCount, duration, limit = 3) {
  if (duration > recordCount) return [];
  const selected = [];
  for (let rank = 0; rank < limit; rank += 1) {
    let best = null;
    for (let start = 0; start <= recordCount - duration; start += 1) {
      const candidate = { start, endExclusive: start + duration };
      if (selected.some((effort) => overlaps(candidate, effort))) continue;
      const sum = prefixPower[candidate.endExclusive] - prefixPower[start];
      if (!best || sum > best.sum) best = { ...candidate, sum };
    }
    if (!best) break;
    selected.push({
      start: best.start,
      end: best.endExclusive - 1,
      duration,
      avgPower: Math.round(best.sum / duration)
    });
  }
  return selected.sort((left, right) => {
    const powerDifference = right.avgPower - left.avgPower;
    return powerDifference !== 0 ? powerDifference : left.start - right.start;
  });
}

function buildPowerBuckets(powers, bucketSeconds = POWER_BUCKET_SECONDS) {
  const bucketCount = Math.ceil(powers.length / bucketSeconds);
  const buckets = new Uint16Array(bucketCount);
  for (let bucketIndex = 0; bucketIndex < bucketCount; bucketIndex += 1) {
    const start = bucketIndex * bucketSeconds;
    const end = Math.min(powers.length, start + bucketSeconds);
    let sum = 0;
    for (let index = start; index < end; index += 1) sum += powers[index];
    buckets[bucketIndex] = Math.round(sum / Math.max(1, end - start));
  }
  return Array.from(buckets);
}

export function extractWorkoutIntensityFeatures({
  recordCount,
  powerAtIndex,
  normalizedPower = null,
  missingValue = null,
  effortLimit = 3,
  includeHistogram = true
}) {
  const length = Math.max(0, Math.floor(Number(recordCount) || 0));
  if (typeof powerAtIndex !== "function") throw new TypeError("powerAtIndex must be a function");

  const powers = new Uint16Array(length);
  const prefixPower = new Float64Array(length + 1);
  const histogramSeconds = includeHistogram ? new Uint32Array(POWER_HISTOGRAM_BUCKETS) : null;
  let positivePowerSeconds = 0;
  let sumPower = 0;
  let sumSquaredPower = 0;

  for (let index = 0; index < length; index += 1) {
    const power = Math.min(0xfffe, Math.round(finitePower(powerAtIndex(index), missingValue)));
    powers[index] = power;
    prefixPower[index + 1] = prefixPower[index] + power;
    sumPower += power;
    sumSquaredPower += power * power;
    if (power > 0) positivePowerSeconds += 1;
    if (histogramSeconds) {
      const histogramIndex = Math.min(POWER_HISTOGRAM_BUCKETS - 1, Math.floor(power / POWER_HISTOGRAM_STEP_WATTS));
      histogramSeconds[histogramIndex] += 1;
    }
  }

  const averagePower = length > 0 ? sumPower / length : 0;
  const variance = length > 0 ? Math.max(0, (sumSquaredPower / length) - (averagePower * averagePower)) : 0;
  const resolvedNormalizedPower = Number.isFinite(Number(normalizedPower)) && Number(normalizedPower) > 0
    ? Number(normalizedPower)
    : calculateNormalizedPowerFromSamples(powers);
  const bestEfforts = {};
  for (const duration of INTENSITY_EFFORT_DURATIONS) {
    bestEfforts[duration] = findTopNonOverlappingEfforts(
      prefixPower,
      length,
      duration,
      Math.max(1, Math.floor(Number(effortLimit) || 1))
    );
  }

  return {
    featureVersion: INTENSITY_FEATURE_VERSION,
    recordCount: length,
    positivePowerSeconds,
    powerCoverage: length > 0 ? positivePowerSeconds / length : 0,
    averagePower: Math.round(averagePower),
    normalizedPower: Math.round(resolvedNormalizedPower || 0),
    variabilityIndex: averagePower > 0 ? resolvedNormalizedPower / averagePower : 0,
    coefficientOfVariation: averagePower > 0 ? Math.sqrt(variance) / averagePower : 0,
    histogramStepWatts: POWER_HISTOGRAM_STEP_WATTS,
    histogramSeconds: histogramSeconds ? Array.from(histogramSeconds) : null,
    powerBucketSeconds: POWER_BUCKET_SECONDS,
    powerBuckets: buildPowerBuckets(powers),
    bestEfforts
  };
}

function estimateFtp(powerDurationCurve) {
  const cp8 = Number(powerDurationCurve?.[480]);
  const cp15 = Number(powerDurationCurve?.[900]);
  if (cp8 > 0 && cp15 > 0) {
    const extrapolation = (Math.log(1200) - Math.log(480)) / (Math.log(900) - Math.log(480));
    return Math.max(1, (cp8 + (extrapolation * (cp15 - cp8))) * 0.95);
  }
  const cp20 = Number(powerDurationCurve?.[1200]);
  if (cp20 > 0) return cp20 * 0.95;
  if (cp15 > 0) return cp15 * 0.90;
  if (cp8 > 0) return cp8 * 0.82;
  return null;
}

export function buildAthleteIntensityModel(featureEntries, options = {}) {
  const entries = (Array.isArray(featureEntries) ? featureEntries : [])
    .filter((entry) => entry?.features?.positivePowerSeconds > 0);
  const curve = {};
  const sampleCounts = {};
  for (const duration of INTENSITY_EFFORT_DURATIONS) {
    const values = entries
      .map((entry) => Number(entry.features?.bestEfforts?.[duration]?.[0]?.avgPower || 0))
      .filter((value) => value > 0);
    curve[duration] = values.length > 0 ? percentile(values, options.quantile ?? 0.95) : null;
    sampleCounts[duration] = values.length;
  }

  const ftp = estimateFtp(curve);
  const thresholdSampleCount = Math.min(sampleCounts[480] || 0, sampleCounts[900] || 0);
  return {
    powerDurationCurve: curve,
    sampleCounts,
    ftp,
    confidence: ftp
      ? clamp(Math.round((thresholdSampleCount / (options.targetSampleCount || MODEL_TARGET_SAMPLE_COUNT)) * 100), 5, 100)
      : 0,
    workoutCount: entries.length
  };
}

function bridgeSingleBucketGaps(flags) {
  const result = [...flags];
  for (let index = 1; index < flags.length - 1; index += 1) {
    if (!flags[index] && flags[index - 1] && flags[index + 1]) result[index] = true;
  }
  return result;
}

function detectBlocks(features, thresholdWatts, minimumSeconds, maximumSeconds, options = {}) {
  const bucketSeconds = Number(features.powerBucketSeconds || POWER_BUCKET_SECONDS);
  const values = features.powerBuckets || [];
  const rawFlags = values.map((value) => Number(value) >= thresholdWatts);
  const flags = options.bridgeGaps === false ? rawFlags : bridgeSingleBucketGaps(rawFlags);
  const blocks = [];
  let start = null;
  for (let index = 0; index <= flags.length; index += 1) {
    if (flags[index] && start == null) start = index;
    if ((!flags[index] || index === flags.length) && start != null) {
      const endExclusive = index;
      const duration = (endExclusive - start) * bucketSeconds;
      if (duration >= minimumSeconds && duration <= maximumSeconds) {
        const slice = values.slice(start, endExclusive);
        const avgPower = slice.reduce((sum, value) => sum + Number(value || 0), 0) / slice.length;
        blocks.push({
          start: start * bucketSeconds,
          end: (endExclusive * bucketSeconds) - 1,
          duration,
          avgPower: Math.round(avgPower)
        });
      }
      start = null;
    }
  }
  return blocks;
}

function intervalGapSeconds(left, right) {
  return Math.max(0, right.start - left.end - 1);
}

function summarizeMicroIntervalSeries(blocks, model) {
  const series = [];
  let current = [];

  const flush = () => {
    if (current.length < 4) {
      current = [];
      return;
    }
    const durations = current.map((block) => block.duration);
    const powers = current.map((block) => block.avgPower);
    const recoveryDurations = current.slice(1).map((block, index) => intervalGapSeconds(current[index], block));
    const totalWorkSeconds = durations.reduce((sum, duration) => sum + duration, 0);
    const averageWorkSeconds = totalWorkSeconds / current.length;
    const averagePower = powers.reduce((sum, power) => sum + power, 0) / powers.length;
    const expectedPower = expectedPowerForDuration(model, averageWorkSeconds);
    const durationConsistency = Math.min(...durations) / Math.max(...durations);
    const powerConsistency = Math.min(...powers) / Math.max(...powers);
    const recoveryConsistency = Math.min(...recoveryDurations) / Math.max(...recoveryDurations);
    if (
      totalWorkSeconds >= 120
      && durationConsistency >= 0.50
      && powerConsistency >= 0.65
      && recoveryConsistency >= 0.50
      && expectedPower > 0
      && averagePower / expectedPower >= 0.62
    ) {
      series.push({
        start: current[0].start,
        end: current[current.length - 1].end,
        repetitionCount: current.length,
        totalWorkSeconds,
        averageWorkSeconds: Math.round(averageWorkSeconds),
        averagePower: Math.round(averagePower),
        personalPowerRatio: Number((averagePower / expectedPower).toFixed(3)),
        blocks: current
      });
    }
    current = [];
  };

  for (const block of blocks) {
    if (current.length === 0) {
      current.push(block);
      continue;
    }
    const previous = current[current.length - 1];
    const gap = intervalGapSeconds(previous, block);
    const workRatio = Math.min(previous.duration, block.duration) / Math.max(previous.duration, block.duration);
    const averageWorkDuration = (previous.duration + block.duration) / 2;
    const recoveryToWorkRatio = gap / averageWorkDuration;
    if (
      gap >= 15
      && gap <= 60
      && workRatio >= 0.50
      && recoveryToWorkRatio >= 0.50
      && recoveryToWorkRatio <= 2.0
    ) {
      current.push(block);
    } else {
      flush();
      current.push(block);
    }
  }
  flush();
  return series;
}

function detectMicroIntervalSeries(features, ftp, model) {
  const workBlocks = detectBlocks(features, ftp * 1.12, 15, 90, { bridgeGaps: false });
  return summarizeMicroIntervalSeries(workBlocks, model);
}

function secondsInRatioRange(features, ftp, lowerInclusive, upperExclusive = Infinity) {
  const bucketSeconds = Number(features.powerBucketSeconds || POWER_BUCKET_SECONDS);
  return (features.powerBuckets || []).reduce((sum, power) => {
    const ratio = Number(power || 0) / ftp;
    return sum + (ratio >= lowerInclusive && ratio < upperExclusive ? bucketSeconds : 0);
  }, 0);
}

function expectedPowerForDuration(model, duration) {
  const curve = model?.powerDurationCurve || {};
  const points = INTENSITY_EFFORT_DURATIONS
    .map((pointDuration) => ({
      duration: pointDuration,
      power: Number(curve[pointDuration])
    }))
    .filter((point) => point.power > 0);
  if (points.length === 0) return null;
  if (duration <= points[0].duration) return points[0].power;
  if (duration >= points[points.length - 1].duration) return points[points.length - 1].power;
  for (let index = 1; index < points.length; index += 1) {
    const right = points[index];
    if (duration > right.duration) continue;
    const left = points[index - 1];
    const ratio = (Math.log(duration) - Math.log(left.duration))
      / (Math.log(right.duration) - Math.log(left.duration));
    return left.power + ((right.power - left.power) * ratio);
  }
  return null;
}

function retainPersonallyHardBlocks(blocks, model, minimumRatio) {
  return blocks.filter((block) => {
    const expectedPower = expectedPowerForDuration(model, block.duration);
    return expectedPower > 0 && block.avgPower / expectedPower >= minimumRatio;
  });
}

function selectVo2Blocks(blocks, model) {
  const repeatedCandidates = retainPersonallyHardBlocks(blocks, model, 0.92);
  if (looksLikeRepeatedIntervals(repeatedCandidates)) return repeatedCandidates;
  return retainPersonallyHardBlocks(blocks, model, 0.97)
    .filter((block) => block.duration >= 240);
}

function looksLikeRepeatedIntervals(blocks) {
  if (blocks.length < 2) return false;
  for (let leftIndex = 0; leftIndex < blocks.length - 1; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < blocks.length; rightIndex += 1) {
      const left = blocks[leftIndex];
      const right = blocks[rightIndex];
      const durationRatio = Math.min(left.duration, right.duration) / Math.max(left.duration, right.duration);
      const powerRatio = Math.min(left.avgPower, right.avgPower) / Math.max(left.avgPower, right.avgPower);
      const recoveryGap = right.start - left.end;
      if (durationRatio >= 0.70 && powerRatio >= 0.85 && recoveryGap >= 30) return true;
    }
  }
  return false;
}

export function classifyWorkoutIntensity(features, model) {
  const ftp = Number(model?.ftp);
  if (!features || features.positivePowerSeconds < 30 || !Number.isFinite(ftp) || ftp <= 0) {
    return {
      profile: "unknown",
      tags: 0,
      structure: "unknown",
      dose: "unknown",
      confidence: 0,
      classifierVersion: INTENSITY_CLASSIFIER_VERSION,
      reason: features?.positivePowerSeconds < 30 ? "insufficient_power" : "missing_model"
    };
  }

  const intensityFactor = Number(features.normalizedPower || 0) / ftp;
  const loadScore = (features.recordCount / 3600) * intensityFactor * intensityFactor * 100;
  const microIntervalSeries = detectMicroIntervalSeries(features, ftp, model);
  const vo2Blocks = selectVo2Blocks(
    detectBlocks(features, ftp * 1.08, 120, 600),
    model
  );
  const rawAnaerobicBlocks = retainPersonallyHardBlocks(
    detectBlocks(features, ftp * 1.30, 15, 119),
    model,
    0.90
  );
  const anaerobicBlocks = rawAnaerobicBlocks.filter((block) => !microIntervalSeries.some((series) => overlaps(
    { start: block.start, end: block.end },
    { start: series.start, end: series.end }
  )));
  const thresholdBlocks = retainPersonallyHardBlocks(
    detectBlocks(features, ftp * 0.91, 480, 1800),
    model,
    0.78
  );
  const vo2Seconds = vo2Blocks.reduce((sum, block) => sum + block.duration, 0);
  const microIntervalSeconds = microIntervalSeries.reduce((sum, series) => sum + series.totalWorkSeconds, 0);
  const microIntervalRepetitionCount = microIntervalSeries.reduce(
    (sum, series) => sum + series.repetitionCount,
    0
  );
  const anaerobicSeconds = anaerobicBlocks.reduce((sum, block) => sum + block.duration, 0);
  const thresholdSeconds = thresholdBlocks.reduce((sum, block) => sum + block.duration, 0);
  const tempoSeconds = secondsInRatioRange(features, ftp, 0.76, 0.91);
  const enduranceSeconds = secondsInRatioRange(features, ftp, 0.60, 0.76);
  const highSeconds = secondsInRatioRange(features, ftp, 1.08);

  let profile;
  let dominantBlocks = [];
  const hasSubstantialMicroIntervals = (microIntervalRepetitionCount >= 8 && microIntervalSeconds >= 180)
    || microIntervalSeries.some((series) => series.repetitionCount >= 6 && series.totalWorkSeconds >= 180);
  if (hasSubstantialMicroIntervals) {
    profile = "vo2max";
    dominantBlocks = microIntervalSeries.flatMap((series) => series.blocks);
  } else if (vo2Seconds >= 240) {
    profile = "vo2max";
    dominantBlocks = vo2Blocks;
  } else if (anaerobicSeconds >= 60 && highSeconds >= 90) {
    profile = "anaerobic";
    dominantBlocks = anaerobicBlocks;
  } else if (thresholdSeconds >= 480) {
    profile = "threshold";
    dominantBlocks = thresholdBlocks;
  } else if (tempoSeconds >= 900 || intensityFactor >= 0.80) {
    profile = "tempo";
  } else if (intensityFactor < 0.60 && highSeconds < 60) {
    profile = "recovery";
  } else {
    profile = "endurance";
  }

  const detectedProfiles = [];
  if (hasSubstantialMicroIntervals || vo2Seconds >= 240) detectedProfiles.push("vo2max");
  if (anaerobicSeconds >= 60 && highSeconds >= 90) detectedProfiles.push("anaerobic");
  if (thresholdSeconds >= 480) detectedProfiles.push("threshold");
  if (tempoSeconds >= 600) detectedProfiles.push("tempo");
  if (enduranceSeconds >= 1800) detectedProfiles.push("endurance");
  if (profile === "recovery") detectedProfiles.push("recovery");
  detectedProfiles.push(profile);
  const tags = buildIntensityTags(detectedProfiles);

  let structure = "steady";
  if (looksLikeRepeatedIntervals(dominantBlocks)) {
    structure = "intervals";
  } else if (features.variabilityIndex >= 1.10 || features.coefficientOfVariation >= 0.55) {
    structure = "variable";
  }

  let dose = loadScore >= 110 ? "high" : loadScore >= 50 ? "moderate" : "low";
  if ((profile === "vo2max" && vo2Seconds >= 360) || (profile === "anaerobic" && anaerobicSeconds >= 120)) {
    if (dose === "low") dose = "moderate";
  }

  const coverageConfidence = clamp(Math.round(features.powerCoverage * 100), 0, 100);
  const confidence = Math.round((Math.min(100, Number(model.confidence || 0)) * 0.65) + (coverageConfidence * 0.35));
  return {
    profile,
    tags,
    structure,
    dose,
    confidence,
    classifierVersion: INTENSITY_CLASSIFIER_VERSION,
    ftp: Math.round(ftp),
    intensityFactor: Number(intensityFactor.toFixed(3)),
    loadScore: Math.round(loadScore),
    evidence: {
      vo2Seconds,
      microIntervalSeconds,
      microIntervalSeriesCount: microIntervalSeries.length,
      microIntervalRepetitionCount,
      anaerobicSeconds,
      thresholdSeconds,
      tempoSeconds,
      enduranceSeconds,
      highSeconds,
      vo2BlockCount: vo2Blocks.length,
      anaerobicBlockCount: anaerobicBlocks.length,
      thresholdBlockCount: thresholdBlocks.length
    }
  };
}

export function classifyWorkoutIntensityChronologically(entries, options = {}) {
  const windowDays = Number(options.windowDays || MODEL_WINDOW_DAYS);
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  const sorted = [...(Array.isArray(entries) ? entries : [])]
    .filter((entry) => entry?.features)
    .sort((left, right) => new Date(left.startTime) - new Date(right.startTime));
  const history = [];
  return sorted.map((entry) => {
    const timestamp = new Date(entry.startTime).getTime();
    while (history.length > 0 && timestamp - new Date(history[0].startTime).getTime() > windowMs) {
      history.shift();
    }
    if (entry.classify === false) {
      history.push(entry);
      return {
        ...entry,
        model: null,
        classification: null
      };
    }
    const model = buildAthleteIntensityModel(history, options);
    const result = {
      ...entry,
      model,
      classification: classifyWorkoutIntensity(entry.features, model)
    };
    history.push(entry);
    return result;
  });
}
