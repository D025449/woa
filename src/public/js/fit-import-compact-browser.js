import { FIT } from "../../../vendor/fit-file-parser-fast/dist/fit.js";
import { filterPowerArtifactsInPlace } from "../../shared/powerArtifactFilter.js";

const GARMIN_TIME_OFFSET_MS = 631065600000;
const SEMICIRCLES_TO_DEGREES = 180 / 0x80000000;
const COMPACT_SENTINELS = {
  uint8: 0xff,
  uint16: 0xffff,
  uint32: 0xffffffff,
  int16: -0x8000,
  int32: -0x80000000,
};
const COMPACT_TEMPERATURE_SENTINEL = 0x7f;
const COMPACT_LEFT_RIGHT_BALANCE_SENTINEL = 0x7f;
const textDecoder = new TextDecoder();
const GARMIN_PRODUCT_NAMES = new Map([
  [4440, "Edge 1050"]
]);
const SESSION_FIELDS = new Set([
  "timestamp",
  "start_time",
  "total_elapsed_time",
  "total_timer_time",
  "total_distance",
  "total_cycles",
  "total_work",
  "total_calories",
  "total_ascent",
  "total_descent",
  "avg_speed",
  "avg_power",
  "avg_heart_rate",
  "avg_cadence",
  "normalized_power",
  "max_speed",
  "max_power",
  "max_heart_rate",
  "max_cadence",
  "nec_lat",
  "nec_long",
  "swc_lat",
  "swc_long",
  "woa_manual_gps",
  "sport",
  "sub_sport",
]);
const LAP_FIELDS = new Set([
  "timestamp",
  "start_time",
  "total_elapsed_time",
  "total_timer_time",
  "lap_trigger",
  "intensity",
  "wkt_step_index",
]);

function normalizeExcludeStartTimeSet(excludeStartTimes) {
  if (excludeStartTimes instanceof Set) {
    return excludeStartTimes.size > 0 ? excludeStartTimes : null;
  }
  if (!Array.isArray(excludeStartTimes) || excludeStartTimes.length === 0) {
    return null;
  }
  const values = excludeStartTimes.filter((value) => typeof value === "string" && value);
  return values.length > 0 ? new Set(values) : null;
}

function toIsoStartTimeKey(timestampMs) {
  return Number.isFinite(timestampMs) ? new Date(timestampMs).toISOString() : null;
}

function readU16LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32LE(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function readI32LE(bytes, offset) {
  return readU32LE(bytes, offset) | 0;
}

function readU16BE(bytes, offset) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readU32BE(bytes, offset) {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function readI32BE(bytes, offset) {
  return readU32BE(bytes, offset) | 0;
}

function readRawFitValue(view, offset, size, baseType, littleEndian) {
  const type = baseType & 0x1f;
  switch (type) {
    case 0x00:
    case 0x02:
    case 0x0a:
    case 0x0d:
      return view.getUint8(offset);
    case 0x01:
      return view.getInt8(offset);
    case 0x83:
    case 0x03:
      return view.getInt16(offset, littleEndian);
    case 0x84:
    case 0x04:
    case 0x0b:
      return view.getUint16(offset, littleEndian);
    case 0x85:
    case 0x05:
      return view.getInt32(offset, littleEndian);
    case 0x86:
    case 0x06:
    case 0x0c:
      return view.getUint32(offset, littleEndian);
    case 0x88:
    case 0x08:
      return view.getFloat32(offset, littleEndian);
    default:
      return null;
  }
}

function isInvalidRawValue(rawValue, size, baseType) {
  const type = baseType & 0x1f;
  if (type === 0x01) return rawValue === 0x7f;
  if (type === 0x83 || type === 0x03) return rawValue === 0x7fff;
  if (type === 0x85 || type === 0x05) return rawValue === 0x7fffffff;
  if (type === 0x02 || type === 0x00 || type === 0x0d) return rawValue === 0xff;
  if (type === 0x0a || type === 0x0b || type === 0x0c) return rawValue === 0;
  if (type === 0x84 || type === 0x04) return rawValue === 0xffff;
  if (type === 0x86 || type === 0x06) return rawValue === 0xffffffff;
  if (size === 1) return rawValue === 0xff;
  if (size === 2) return rawValue === 0xffff;
  if (size === 4) return rawValue === 0xffffffff;
  return false;
}

function compactDistanceFromCentimeters(value) {
  return Number.isFinite(value) && value >= 0
    ? Math.max(0, Math.min(0xfffffffe, Math.round(value / 50)))
    : COMPACT_SENTINELS.uint32;
}

function compactAltitude(value) {
  return Number.isFinite(value)
    ? Math.max(-32767, Math.min(32767, Math.round(value * 4)))
    : COMPACT_SENTINELS.int16;
}

function dropAllZeroAltitudeColumn(altitudesQ) {
  if (!altitudesQ || altitudesQ.length <= 0) return altitudesQ;
  let validCount = 0;
  for (let index = 0; index < altitudesQ.length; index += 1) {
    const value = altitudesQ[index];
    if (value === COMPACT_SENTINELS.int16) continue;
    validCount += 1;
    if (value !== 0) return altitudesQ;
  }
  if (validCount <= 0) return altitudesQ;
  const dropped = new Int16Array(altitudesQ.length);
  dropped.fill(COMPACT_SENTINELS.int16);
  return dropped;
}

function compactCoordFromSemicircles(raw) {
  return Math.max(-0x7fffffff, Math.min(0x7fffffff, Math.round(raw * 180000000 / 0x80000000)));
}

function compactTimestampSecFromGarmin(rawTimestampSec) {
  if (!Number.isFinite(rawTimestampSec) || rawTimestampSec < 0) {
    return COMPACT_SENTINELS.uint32;
  }
  const unixTimestampSec = Math.round(rawTimestampSec + (GARMIN_TIME_OFFSET_MS / 1000));
  return Math.max(0, Math.min(COMPACT_SENTINELS.uint32 - 1, unixTimestampSec));
}

const INITIAL_RECORD_BUFFER_CAPACITY = 7200;

function createCompactRecordBuffer(initialCapacity = INITIAL_RECORD_BUFFER_CAPACITY) {
  const capacity = Math.max(1, Number(initialCapacity) || INITIAL_RECORD_BUFFER_CAPACITY);
  return {
    length: 0,
    capacity,
    timestampsSec: new Uint32Array(capacity),
    distancesQ: new Uint32Array(capacity),
    powersW: new Uint16Array(capacity),
    heartRatesBpm: new Uint8Array(capacity),
    cadencesRpm: new Uint8Array(capacity),
    temperaturesC: new Int8Array(capacity),
    leftRightBalancesPct: new Uint8Array(capacity),
    speedsCmS: new Uint16Array(capacity),
    altitudesQ: new Int16Array(capacity),
    positionLatsE6: new Int32Array(capacity),
    positionLongsE6: new Int32Array(capacity),
  };
}

function growCompactRecordBuffer(buffer, minimumCapacity = 0) {
  const nextCapacity = Math.max(
    Math.max(1, buffer?.capacity || 0) * 2,
    Number(minimumCapacity) || 0,
    INITIAL_RECORD_BUFFER_CAPACITY
  );
  const next = createCompactRecordBuffer(nextCapacity);
  next.length = Number(buffer?.length || 0);
  next.timestampsSec.set(buffer.timestampsSec.subarray(0, next.length));
  next.distancesQ.set(buffer.distancesQ.subarray(0, next.length));
  next.powersW.set(buffer.powersW.subarray(0, next.length));
  next.heartRatesBpm.set(buffer.heartRatesBpm.subarray(0, next.length));
  next.cadencesRpm.set(buffer.cadencesRpm.subarray(0, next.length));
  next.temperaturesC.set(buffer.temperaturesC.subarray(0, next.length));
  next.leftRightBalancesPct.set(buffer.leftRightBalancesPct.subarray(0, next.length));
  next.speedsCmS.set(buffer.speedsCmS.subarray(0, next.length));
  next.altitudesQ.set(buffer.altitudesQ.subarray(0, next.length));
  next.positionLatsE6.set(buffer.positionLatsE6.subarray(0, next.length));
  next.positionLongsE6.set(buffer.positionLongsE6.subarray(0, next.length));
  return next;
}

function ensureCompactRecordCapacity(buffer, requiredLength) {
  if (requiredLength <= buffer.capacity) {
    return buffer;
  }
  return growCompactRecordBuffer(buffer, requiredLength);
}

function appendCompactRecord(buffer, {
  timestampSec,
  distance,
  power,
  heartRate,
  cadence,
  temperature,
  leftRightBalance,
  speed,
  altitude,
  lat,
  lng,
}) {
  const nextLength = buffer.length + 1;
  const target = ensureCompactRecordCapacity(buffer, nextLength);
  const index = target.length;
  target.timestampsSec[index] = timestampSec;
  target.distancesQ[index] = distance;
  target.powersW[index] = power;
  target.heartRatesBpm[index] = heartRate;
  target.cadencesRpm[index] = cadence;
  target.temperaturesC[index] = temperature;
  target.leftRightBalancesPct[index] = leftRightBalance;
  target.speedsCmS[index] = speed;
  target.altitudesQ[index] = altitude;
  target.positionLatsE6[index] = lat;
  target.positionLongsE6[index] = lng;
  target.length = nextLength;
  return target;
}

function finalizeCompactRecordBuffer(buffer, baseTimestampSec) {
  const recordCount = Number(buffer?.length || 0);
  return {
    recordCount,
    baseTimestampSec: baseTimestampSec === COMPACT_SENTINELS.uint32 ? 0 : baseTimestampSec,
    lastTimestampSec: recordCount > 0 ? buffer.timestampsSec[recordCount - 1] : 0,
    timestampsSec: buffer.timestampsSec.subarray(0, recordCount),
    distancesQ: buffer.distancesQ.subarray(0, recordCount),
    powersW: buffer.powersW.subarray(0, recordCount),
    heartRatesBpm: buffer.heartRatesBpm.subarray(0, recordCount),
    cadencesRpm: buffer.cadencesRpm.subarray(0, recordCount),
    temperaturesC: buffer.temperaturesC.subarray(0, recordCount),
    leftRightBalancesPct: buffer.leftRightBalancesPct.subarray(0, recordCount),
    speedsCmS: buffer.speedsCmS.subarray(0, recordCount),
    altitudesQ: dropAllZeroAltitudeColumn(buffer.altitudesQ.subarray(0, recordCount)),
    positionLatsE6: buffer.positionLatsE6.subarray(0, recordCount),
    positionLongsE6: buffer.positionLongsE6.subarray(0, recordCount),
  };
}

export function normalizeCompactMissingMetricsInPlace(compactRecords) {
  const recordCount = Number(compactRecords?.recordCount || 0);
  if (recordCount <= 0) return compactRecords;

  const distances = compactRecords.distancesQ;
  const powers = compactRecords.powersW;
  const heartRates = compactRecords.heartRatesBpm;
  const cadences = compactRecords.cadencesRpm;
  const speeds = compactRecords.speedsCmS;
  const altitudes = compactRecords.altitudesQ;

  let previousDistance = 0;
  for (let index = 0; index < recordCount; index += 1) {
    if (distances?.[index] === COMPACT_SENTINELS.uint32) {
      distances[index] = previousDistance;
    } else if (distances) {
      previousDistance = distances[index];
    }
    if (powers?.[index] === COMPACT_SENTINELS.uint16) powers[index] = 0;
    if (heartRates?.[index] === COMPACT_SENTINELS.uint8) heartRates[index] = 0;
    if (cadences?.[index] === COMPACT_SENTINELS.uint8) cadences[index] = 0;
    if (speeds?.[index] === COMPACT_SENTINELS.uint16) speeds[index] = 0;
  }

  if (altitudes) {
    let firstValidAltitude = COMPACT_SENTINELS.int16;
    for (let index = 0; index < recordCount; index += 1) {
      if (altitudes[index] !== COMPACT_SENTINELS.int16) {
        firstValidAltitude = altitudes[index];
        break;
      }
    }

    if (firstValidAltitude !== COMPACT_SENTINELS.int16) {
      let previousAltitude = firstValidAltitude;
      for (let index = 0; index < recordCount; index += 1) {
        if (altitudes[index] === COMPACT_SENTINELS.int16) {
          altitudes[index] = previousAltitude;
        } else {
          previousAltitude = altitudes[index];
        }
      }
    }
  }

  return compactRecords;
}

export function repairCompactPedalConnectivityDropoutsInPlace(
  compactRecords,
  {
    maxDropoutSeconds = 15,
    maxSingleSidedDropoutSeconds = 5,
    maximumSingleSidedPowerRatio = 0.75
  } = {}
) {
  const recordCount = Number(compactRecords?.recordCount || 0);
  const powers = compactRecords?.powersW;
  const cadences = compactRecords?.cadencesRpm;
  const balances = compactRecords?.leftRightBalancesPct;
  const timestamps = compactRecords?.timestampsSec;
  const stats = {
    detectedDropoutCount: 0,
    correctedDropoutCount: 0,
    correctedSampleCount: 0,
    maxCorrectedDropoutSeconds: 0,
    correctedPowerSampleCount: 0,
    correctedBalanceDropoutCount: 0,
    correctedBalanceSampleCount: 0,
    discardedBalanceSampleCount: 0
  };
  compactRecords.pedalConnectivityRepairStats = stats;

  if (recordCount < 3 || !powers || !cadences) {
    return compactRecords;
  }

  const isComplete = (index) => (
    powers[index] !== COMPACT_SENTINELS.uint16
    && cadences[index] !== COMPACT_SENTINELS.uint8
  );
  const isPedaling = (index) => isComplete(index) && powers[index] > 0 && cadences[index] > 0;
  const isJointlyMissing = (index) => (
    powers[index] === COMPACT_SENTINELS.uint16
    && cadences[index] === COMPACT_SENTINELS.uint8
  );
  const elapsedSeconds = (left, right) => {
    const leftTimestamp = Number(timestamps?.[left]);
    const rightTimestamp = Number(timestamps?.[right]);
    if (
      Number.isFinite(leftTimestamp)
      && Number.isFinite(rightTimestamp)
      && leftTimestamp !== COMPACT_SENTINELS.uint32
      && rightTimestamp !== COMPACT_SENTINELS.uint32
      && rightTimestamp > leftTimestamp
    ) {
      return rightTimestamp - leftTimestamp - 1;
    }
    return right - left - 1;
  };

  for (let start = 1; start < recordCount - 1; start += 1) {
    if (!isJointlyMissing(start) || !isPedaling(start - 1)) continue;
    stats.detectedDropoutCount += 1;

    let right = start + 1;
    while (right < recordCount && !isComplete(right)) right += 1;
    if (right >= recordCount || !isPedaling(right)) {
      start = right - 1;
      continue;
    }

    const dropoutSeconds = elapsedSeconds(start - 1, right);
    if (!(dropoutSeconds > 0) || dropoutSeconds > maxDropoutSeconds) {
      start = right - 1;
      continue;
    }

    const left = start - 1;
    const span = right - left;
    for (let index = start; index < right; index += 1) {
      const ratio = (index - left) / span;
      powers[index] = Math.max(0, Math.min(
        COMPACT_SENTINELS.uint16 - 1,
        Math.round(powers[left] + ((powers[right] - powers[left]) * ratio))
      ));
      cadences[index] = Math.max(0, Math.min(
        COMPACT_SENTINELS.uint8 - 1,
        Math.round(cadences[left] + ((cadences[right] - cadences[left]) * ratio))
      ));
    }

    stats.correctedDropoutCount += 1;
    stats.correctedSampleCount += right - start;
    stats.correctedPowerSampleCount += right - start;
    stats.maxCorrectedDropoutSeconds = Math.max(stats.maxCorrectedDropoutSeconds, dropoutSeconds);
    start = right - 1;
  }

  if (!balances) return compactRecords;

  const isValidBalance = (index) => balances[index] !== COMPACT_LEFT_RIGHT_BALANCE_SENTINEL;
  const isPlausibleBoundaryBalance = (index) => (
    isValidBalance(index) && balances[index] > 0 && balances[index] < 100
  );
  const isSingleSidedBalance = (index) => balances[index] === 0 || balances[index] === 100;

  for (let start = 1; start < recordCount - 1; start += 1) {
    if (!isSingleSidedBalance(start) || !isPlausibleBoundaryBalance(start - 1)) continue;

    let right = start + 1;
    while (right < recordCount && isSingleSidedBalance(right)) right += 1;
    if (right >= recordCount || !isPlausibleBoundaryBalance(right)) {
      start = right - 1;
      continue;
    }

    const dropoutSeconds = elapsedSeconds(start - 1, right);
    if (!(dropoutSeconds > 0) || dropoutSeconds > maxSingleSidedDropoutSeconds) {
      start = right - 1;
      continue;
    }

    let hasContinuousPedaling = true;
    let actualPowerSum = 0;
    let expectedPowerSum = 0;
    const left = start - 1;
    const span = right - left;
    for (let index = start; index < right; index += 1) {
      if (!isPedaling(index)) {
        hasContinuousPedaling = false;
        break;
      }
      const ratio = (index - left) / span;
      actualPowerSum += powers[index];
      expectedPowerSum += powers[left] + ((powers[right] - powers[left]) * ratio);
    }
    if (!hasContinuousPedaling) {
      start = right - 1;
      continue;
    }

    const repairPower = expectedPowerSum > 0
      && actualPowerSum <= expectedPowerSum * maximumSingleSidedPowerRatio;
    for (let index = start; index < right; index += 1) {
      const ratio = (index - left) / span;
      balances[index] = Math.max(0, Math.min(100, Math.round(
        balances[left] + ((balances[right] - balances[left]) * ratio)
      )));
      if (repairPower) {
        powers[index] = Math.max(0, Math.min(
          COMPACT_SENTINELS.uint16 - 1,
          Math.round(powers[left] + ((powers[right] - powers[left]) * ratio))
        ));
      }
    }

    stats.correctedDropoutCount += 1;
    stats.correctedSampleCount += right - start;
    stats.correctedBalanceDropoutCount += 1;
    stats.correctedBalanceSampleCount += right - start;
    if (repairPower) stats.correctedPowerSampleCount += right - start;
    stats.maxCorrectedDropoutSeconds = Math.max(stats.maxCorrectedDropoutSeconds, dropoutSeconds);
    start = right - 1;
  }

  for (let start = 0; start < recordCount;) {
    if (!isSingleSidedBalance(start)) {
      start += 1;
      continue;
    }
    const extremeValue = balances[start];
    let right = start + 1;
    while (right < recordCount && balances[right] === extremeValue) right += 1;

    const sampleCount = right - start;
    const left = start - 1;
    let powerSum = 0;
    for (let index = start; index < right; index += 1) powerSum += powers[index];
    const averagePower = powerSum / sampleCount;
    const leftPower = left >= 0 && isComplete(left) ? Number(powers[left]) : Number.NaN;
    const followsAbruptPowerLoss = Number.isFinite(leftPower)
      && leftPower > 0
      && averagePower <= leftPower * maximumSingleSidedPowerRatio;
    const isNegligiblePower = averagePower <= 10;

    if (
      sampleCount <= maxSingleSidedDropoutSeconds
      && left >= 0
      && isPlausibleBoundaryBalance(left)
      && (followsAbruptPowerLoss || isNegligiblePower)
    ) {
      balances.fill(COMPACT_LEFT_RIGHT_BALANCE_SENTINEL, start, right);
      stats.discardedBalanceSampleCount += sampleCount;
    }
    start = right;
  }

  for (let index = 0; index < recordCount; index += 1) {
    if (powers[index] === 0 && isValidBalance(index)) {
      balances[index] = COMPACT_LEFT_RIGHT_BALANCE_SENTINEL;
      stats.discardedBalanceSampleCount += 1;
    }
  }

  return compactRecords;
}

export function correctCompactDistanceBatchingLegacyInPlace(
  compactRecords,
  remainingPasses = 3
) {
  const recordCount = Number(compactRecords?.recordCount || 0);
  const distances = compactRecords?.distancesQ;
  const startedAt = performance.now();
  const stats = {
    correctedWindows: 0,
    correctedIntervals: 0,
    redistributedDistanceUnits: 0,
    detectedTransitions: 0,
    rejectedWindows: 0,
    passes: 1,
    elapsedMs: 0
  };

  if (recordCount < 4 || !distances) {
    stats.elapsedMs = performance.now() - startedAt;
    compactRecords.distanceBatchingCorrectionStats = stats;
    return compactRecords;
  }

  // distancesQ uses 0.5 m units at one-second intervals. The first representable
  // velocity at or above 5 km/h is therefore 3 units (5.4 km/h).
  const minimumMovingVelocityUnits = 3;
  const maximumWindowSpan = 16;
  const velocities = new Float64Array(recordCount);
  const accelerations = new Float64Array(recordCount);
  const validIntervals = new Uint8Array(recordCount);
  const transitionFlags = new Uint8Array(recordCount);
  const correctedIntervals = new Uint8Array(recordCount);
  const isolatedStalls = [];

  for (let index = 1; index < recordCount; index += 1) {
    const previousDistance = distances[index - 1];
    const currentDistance = distances[index];
    if (
      previousDistance === COMPACT_SENTINELS.uint32
      || currentDistance === COMPACT_SENTINELS.uint32
      || currentDistance < previousDistance
    ) {
      continue;
    }
    validIntervals[index] = 1;
    velocities[index] = currentDistance - previousDistance;
  }

  for (let index = 2; index < recordCount - 1; index += 1) {
    if (
      !validIntervals[index - 1]
      || !validIntervals[index]
      || !validIntervals[index + 1]
    ) {
      continue;
    }
    accelerations[index] = velocities[index] - velocities[index - 1];
    accelerations[index + 1] = velocities[index + 1] - velocities[index];
    if (
      velocities[index] === 0
      && velocities[index - 1] >= minimumMovingVelocityUnits
      && velocities[index + 1] >= minimumMovingVelocityUnits
    ) {
      transitionFlags[index] = 1;
      transitionFlags[index + 1] = 1;
      isolatedStalls.push(index);
    }
  }

  const transitions = [];
  for (let index = 2; index < recordCount; index += 1) {
    if (transitionFlags[index]) transitions.push(index);
  }
  stats.detectedTransitions = transitions.length;

  const roughness = (series, start, end) => {
    let value = 0;
    for (
      let index = Math.max(2, start);
      index <= Math.min(recordCount - 1, end);
      index += 1
    ) {
      const delta = series[index] - series[index - 1];
      value += delta * delta;
    }
    return value;
  };

  const buildCandidate = (
    firstTransition,
    lastTransition,
    transitionCount,
    padding = 2
  ) => {
    const windowStart = Math.max(1, firstTransition - padding);
    const windowEnd = Math.min(recordCount - 1, lastTransition + padding);
    const intervalCount = windowEnd - windowStart + 1;
    if (intervalCount < 2) return null;
    for (let index = windowStart; index <= windowEnd; index += 1) {
      if (!validIntervals[index]) return null;
    }

    const targetDistanceUnits = distances[windowEnd] - distances[windowStart - 1];
    if (targetDistanceUnits <= 0) return null;

    const leftAnchorIndex = windowStart > 1 ? windowStart - 1 : -1;
    const rightAnchorIndex = windowEnd + 1 < recordCount && validIntervals[windowEnd + 1]
      ? windowEnd + 1
      : -1;
    const averageVelocity = targetDistanceUnits / intervalCount;
    const leftVelocity = leftAnchorIndex >= 1 ? velocities[leftAnchorIndex] : averageVelocity;
    const rightVelocity = rightAnchorIndex >= 1 ? velocities[rightAnchorIndex] : averageVelocity;
    const exact = new Float64Array(intervalCount);
    const weights = new Float64Array(intervalCount);
    const smoothingRadius = transitionCount >= 4
      ? Math.min(6, Math.max(2, Math.ceil(transitionCount / 2)))
      : 0;
    let baseSum = 0;
    let weightSum = 0;

    for (let offset = 0; offset < intervalCount; offset += 1) {
      const ratio = (offset + 1) / (intervalCount + 1);
      let value = leftVelocity + ((rightVelocity - leftVelocity) * ratio);
      if (smoothingRadius > 0) {
        const sourceIndex = windowStart + offset;
        let localSum = 0;
        let localWeightSum = 0;
        for (
          let localIndex = Math.max(1, sourceIndex - smoothingRadius);
          localIndex <= Math.min(recordCount - 1, sourceIndex + smoothingRadius);
          localIndex += 1
        ) {
          if (!validIntervals[localIndex]) continue;
          const localWeight = smoothingRadius + 1 - Math.abs(localIndex - sourceIndex);
          localSum += velocities[localIndex] * localWeight;
          localWeightSum += localWeight;
        }
        if (localWeightSum > 0) {
          value = localSum / localWeightSum;
        }
      }
      const weight = leftAnchorIndex >= 1 && rightAnchorIndex >= 1
        ? Math.sin(Math.PI * ratio) ** 2
        : 1;
      exact[offset] = value;
      weights[offset] = weight;
      baseSum += value;
      weightSum += weight;
    }

    if (smoothingRadius > 0) {
      if (!(baseSum > 0)) return null;
      const scale = targetDistanceUnits / baseSum;
      for (let offset = 0; offset < intervalCount; offset += 1) {
        exact[offset] *= scale;
      }
    } else {
      const correction = weightSum > 0 ? (targetDistanceUnits - baseSum) / weightSum : 0;
      for (let offset = 0; offset < intervalCount; offset += 1) {
        exact[offset] += correction * weights[offset];
        if (!Number.isFinite(exact[offset]) || exact[offset] < 0) return null;
      }
    }

    const repaired = new Uint32Array(intervalCount);
    let exactCumulative = 0;
    let integerCumulative = 0;
    for (let offset = 0; offset < intervalCount; offset += 1) {
      exactCumulative += exact[offset];
      const nextCumulative = offset === intervalCount - 1
        ? targetDistanceUnits
        : Math.max(integerCumulative, Math.round(exactCumulative));
      repaired[offset] = nextCumulative - integerCumulative;
      integerCumulative = nextCumulative;
    }

    const positiveSourceVelocities = [];
    for (let index = windowStart; index <= windowEnd; index += 1) {
      if (velocities[index] > 0) {
        positiveSourceVelocities.push(velocities[index]);
      }
    }
    positiveSourceVelocities.sort((left, right) => left - right);
    const medianVelocity = positiveSourceVelocities.length > 0
      ? positiveSourceVelocities[Math.floor(positiveSourceVelocities.length / 2)]
      : 0;
    const localOutlierLimit = Math.max(25, medianVelocity * 1.7);
    let sourceOutlierCount = 0;
    let repairedOutlierCount = 0;
    for (let offset = 0; offset < intervalCount; offset += 1) {
      if (velocities[windowStart + offset] > localOutlierLimit) {
        sourceOutlierCount += 1;
      }
      if (repaired[offset] > localOutlierLimit) {
        repairedOutlierCount += 1;
      }
    }
    if (repairedOutlierCount > sourceOutlierCount) return null;

    const roughnessStart = Math.max(2, windowStart - 1);
    const roughnessEnd = Math.min(recordCount - 1, windowEnd + 1);
    const originalRoughness = roughness(velocities, roughnessStart, roughnessEnd);
    let repairedRoughness = 0;
    let previousVelocity = roughnessStart - 1 >= windowStart
      && roughnessStart - 1 <= windowEnd
      ? repaired[roughnessStart - 1 - windowStart]
      : velocities[roughnessStart - 1];
    for (let index = roughnessStart; index <= roughnessEnd; index += 1) {
      const currentVelocity = index >= windowStart && index <= windowEnd
        ? repaired[index - windowStart]
        : velocities[index];
      const delta = currentVelocity - previousVelocity;
      repairedRoughness += delta * delta;
      previousVelocity = currentVelocity;
    }
    if (!(repairedRoughness < originalRoughness * 0.6)) return null;

    return {
      windowStart,
      windowEnd,
      conflictStart: Math.max(1, windowStart - 2),
      conflictEnd: Math.min(recordCount - 1, windowEnd + 2),
      repaired,
      targetDistanceUnits,
      score: ((transitionCount ** 2) * 1_000_000_000)
        + ((originalRoughness - repairedRoughness) * 1_000)
        - intervalCount
    };
  };

  const candidatesByEnd = new Array(recordCount);
  for (let left = 0; left < isolatedStalls.length - 1;) {
    const firstStall = isolatedStalls[left];
    let right = left;
    while (
      right + 1 < isolatedStalls.length
      && isolatedStalls[right + 1] - firstStall <= maximumWindowSpan
    ) {
      right += 1;
    }
    if (right === left) {
      left += 1;
      continue;
    }

    const lastStall = isolatedStalls[right];
    const stallCount = right - left + 1;
    const candidate = buildCandidate(
      firstStall,
      lastStall + 1,
      stallCount * 2,
      16
    );
    if (candidate) {
      candidate.score += stallCount * 1_000_000_000_000_000;
      (candidatesByEnd[candidate.conflictEnd] ||= []).push(candidate);
    } else {
      stats.rejectedWindows += 1;
    }
    left = right + 1;
  }
  for (let left = 0; left < transitions.length - 1; left += 1) {
    const firstTransition = transitions[left];
    let hasPositiveAcceleration = accelerations[firstTransition] > 0;
    let hasNegativeAcceleration = accelerations[firstTransition] < 0;
    for (let right = left + 1; right < transitions.length; right += 1) {
      const lastTransition = transitions[right];
      if (lastTransition - firstTransition > maximumWindowSpan) break;
      hasPositiveAcceleration ||= accelerations[lastTransition] > 0;
      hasNegativeAcceleration ||= accelerations[lastTransition] < 0;
      if (!hasPositiveAcceleration || !hasNegativeAcceleration) continue;
      const transitionCount = right - left + 1;
      for (let padding = 2; padding <= 4; padding += 1) {
        const candidate = buildCandidate(
          firstTransition,
          lastTransition,
          transitionCount,
          padding
        );
        if (candidate) {
          (candidatesByEnd[candidate.conflictEnd] ||= []).push(candidate);
        } else {
          stats.rejectedWindows += 1;
        }
      }
    }
  }

  const bestScores = new Float64Array(recordCount);
  const selectedAtEnd = new Array(recordCount);
  for (let index = 1; index < recordCount; index += 1) {
    bestScores[index] = bestScores[index - 1];
    const candidates = candidatesByEnd[index];
    if (!candidates) {
      continue;
    }
    for (const candidate of candidates) {
      const precedingScore = candidate.conflictStart > 1
        ? bestScores[candidate.conflictStart - 1]
        : 0;
      const candidateScore = precedingScore + candidate.score;
      if (candidateScore > bestScores[index]) {
        bestScores[index] = candidateScore;
        selectedAtEnd[index] = candidate;
      }
    }
  }

  const selectedCandidates = [];
  for (let index = recordCount - 1; index > 0;) {
    const candidate = selectedAtEnd[index];
    if (!candidate) {
      index -= 1;
      continue;
    }
    selectedCandidates.push(candidate);
    index = candidate.conflictStart - 1;
  }
  selectedCandidates.reverse();
  for (const candidate of selectedCandidates) {
    let cumulativeDistance = distances[candidate.windowStart - 1];
    for (let offset = 0; offset < candidate.repaired.length; offset += 1) {
      const index = candidate.windowStart + offset;
      cumulativeDistance += candidate.repaired[offset];
      distances[index] = cumulativeDistance;
      if (!correctedIntervals[index]) {
        correctedIntervals[index] = 1;
        stats.correctedIntervals += 1;
      }
    }
    stats.correctedWindows += 1;
    stats.redistributedDistanceUnits += candidate.targetDistanceUnits;
  }

  let hasRemainingIsolatedStall = false;
  if (stats.correctedWindows > 0 && remainingPasses > 1) {
    let previousVelocity = null;
    let currentVelocity = null;
    for (let index = 1; index < recordCount - 1; index += 1) {
      const previousDistance = distances[index - 1];
      const currentDistance = distances[index];
      const nextDistance = distances[index + 1];
      if (
        previousDistance === COMPACT_SENTINELS.uint32
        || currentDistance === COMPACT_SENTINELS.uint32
        || nextDistance === COMPACT_SENTINELS.uint32
        || currentDistance < previousDistance
        || nextDistance < currentDistance
      ) {
        previousVelocity = null;
        currentVelocity = null;
        continue;
      }
      currentVelocity = currentDistance - previousDistance;
      const nextVelocity = nextDistance - currentDistance;
      if (
        previousVelocity != null
        && currentVelocity === 0
        && previousVelocity >= minimumMovingVelocityUnits
        && nextVelocity >= minimumMovingVelocityUnits
      ) {
        hasRemainingIsolatedStall = true;
        break;
      }
      previousVelocity = currentVelocity;
    }
  }

  if (hasRemainingIsolatedStall) {
    correctCompactDistanceBatchingLegacyInPlace(compactRecords, remainingPasses - 1);
    const subsequentStats = compactRecords.distanceBatchingCorrectionStats;
    stats.correctedWindows += subsequentStats.correctedWindows;
    stats.correctedIntervals += subsequentStats.correctedIntervals;
    stats.redistributedDistanceUnits += subsequentStats.redistributedDistanceUnits;
    stats.rejectedWindows += subsequentStats.rejectedWindows;
    stats.passes += subsequentStats.passes;
  }

  stats.elapsedMs = performance.now() - startedAt;
  compactRecords.distanceBatchingCorrectionStats = stats;
  return compactRecords;
}

export function correctCompactDistanceBatchingInPlace(
  compactRecords,
  remainingPasses = 1
) {
  const recordCount = Number(compactRecords?.recordCount || 0);
  const distances = compactRecords?.distancesQ;
  const speeds = compactRecords?.speedsCmS;
  const startedAt = performance.now();
  const stats = {
    mode: "fit-speed-assisted",
    correctedWindows: 0,
    correctedIntervals: 0,
    redistributedDistanceUnits: 0,
    detectedTransitions: 0,
    rejectedWindows: 0,
    passes: 1,
    elapsedMs: 0
  };

  if (recordCount < 3 || !distances || !speeds) {
    stats.elapsedMs = performance.now() - startedAt;
    compactRecords.distanceBatchingCorrectionStats = stats;
    return compactRecords;
  }

  let hasFitSpeedSamples = false;
  for (let index = 0; index < recordCount; index += 1) {
    if (speeds[index] !== COMPACT_SENTINELS.uint16) {
      hasFitSpeedSamples = true;
      break;
    }
  }
  if (!hasFitSpeedSamples) {
    correctCompactDistanceBatchingLegacyInPlace(compactRecords);
    compactRecords.distanceBatchingCorrectionStats = {
      ...compactRecords.distanceBatchingCorrectionStats,
      mode: "distance-only-fallback"
    };
    return compactRecords;
  }

  const maximumWindowIntervals = 48;
  const minimumFitSpeedCmS = 139;
  const actualUnits = new Float64Array(recordCount);
  const expectedUnits = new Float64Array(recordCount);
  const validIntervals = new Uint8Array(recordCount);
  const candidatesByEnd = new Array(recordCount);

  const discrepancyThreshold = (expected) => Math.max(2.5, expected * 0.45);
  for (let index = 1; index < recordCount; index += 1) {
    const previousDistance = distances[index - 1];
    const currentDistance = distances[index];
    const speedCmS = speeds[index];
    if (
      previousDistance === COMPACT_SENTINELS.uint32
      || currentDistance === COMPACT_SENTINELS.uint32
      || currentDistance < previousDistance
      || speedCmS === COMPACT_SENTINELS.uint16
      || speedCmS < minimumFitSpeedCmS
    ) {
      continue;
    }
    validIntervals[index] = 1;
    actualUnits[index] = currentDistance - previousDistance;
    expectedUnits[index] = speedCmS / 50;
  }

  for (let start = 1; start < recordCount - 1; start += 1) {
    if (!validIntervals[start]) continue;
    const startError = actualUnits[start] - expectedUnits[start];
    if (Math.abs(startError) < discrepancyThreshold(expectedUnits[start])) {
      continue;
    }
    stats.detectedTransitions += 1;

    let actualSum = 0;
    let expectedSum = 0;
    let hasNegativeError = false;
    let hasPositiveError = false;
    let candidateCount = 0;
    const maximumEnd = Math.min(recordCount - 1, start + maximumWindowIntervals - 1);

    for (let end = start; end <= maximumEnd; end += 1) {
      if (!validIntervals[end]) break;
      const error = actualUnits[end] - expectedUnits[end];
      actualSum += actualUnits[end];
      expectedSum += expectedUnits[end];
      const signThreshold = discrepancyThreshold(expectedUnits[end]) * 0.5;
      hasNegativeError ||= error <= -signThreshold;
      hasPositiveError ||= error >= signThreshold;
      if (end === start || !hasNegativeError || !hasPositiveError) continue;

      const intervalCount = end - start + 1;
      const closureTolerance = Math.max(
        intervalCount === 2 ? 1.5 : 1.25,
        expectedSum * 0.04
      );
      if (Math.abs(actualSum - expectedSum) > closureTolerance) continue;

      const repaired = new Uint32Array(intervalCount);
      let exactCumulative = 0;
      let integerCumulative = 0;
      let originalSquaredError = 0;
      let repairedSquaredError = 0;
      let resolvedTransitionCount = 0;
      for (let offset = 0; offset < intervalCount; offset += 1) {
        const index = start + offset;
        exactCumulative += expectedUnits[index] * (actualSum / expectedSum);
        const nextCumulative = offset === intervalCount - 1
          ? actualSum
          : Math.max(integerCumulative, Math.round(exactCumulative));
        repaired[offset] = nextCumulative - integerCumulative;
        integerCumulative = nextCumulative;
        originalSquaredError += (actualUnits[index] - expectedUnits[index]) ** 2;
        repairedSquaredError += (repaired[offset] - expectedUnits[index]) ** 2;
        if (
          Math.abs(actualUnits[index] - expectedUnits[index])
            >= discrepancyThreshold(expectedUnits[index])
          && Math.abs(repaired[offset] - expectedUnits[index])
            < discrepancyThreshold(expectedUnits[index])
        ) {
          resolvedTransitionCount += 1;
        }
      }
      if (!(repairedSquaredError < originalSquaredError * 0.25)) continue;

      const candidate = {
        windowStart: start,
        windowEnd: end,
        repaired,
        targetDistanceUnits: actualSum,
        // First maximize the number of removed batching transitions. Error
        // reduction and shorter windows only break otherwise equivalent ties.
        score: (resolvedTransitionCount * 1_000_000)
          + originalSquaredError
          - repairedSquaredError
          + (1 / intervalCount)
      };
      (candidatesByEnd[candidate.windowEnd] ||= []).push(candidate);
      candidateCount += 1;
    }

    if (candidateCount === 0) {
      stats.rejectedWindows += 1;
    }
  }

  const bestScores = new Float64Array(recordCount);
  const selectedAtEnd = new Array(recordCount);
  for (let index = 1; index < recordCount; index += 1) {
    bestScores[index] = bestScores[index - 1];
    for (const candidate of candidatesByEnd[index] || []) {
      const precedingScore = candidate.windowStart > 1
        ? bestScores[candidate.windowStart - 1]
        : 0;
      const candidateScore = precedingScore + candidate.score;
      if (candidateScore > bestScores[index]) {
        bestScores[index] = candidateScore;
        selectedAtEnd[index] = candidate;
      }
    }
  }

  const selectedCandidates = [];
  for (let index = recordCount - 1; index > 0;) {
    const candidate = selectedAtEnd[index];
    if (!candidate) {
      index -= 1;
      continue;
    }
    selectedCandidates.push(candidate);
    index = candidate.windowStart - 1;
  }
  selectedCandidates.reverse();

  for (const candidate of selectedCandidates) {
    let cumulativeDistance = distances[candidate.windowStart - 1];
    for (let offset = 0; offset < candidate.repaired.length; offset += 1) {
      cumulativeDistance += candidate.repaired[offset];
      distances[candidate.windowStart + offset] = cumulativeDistance;
      stats.correctedIntervals += 1;
    }
    stats.correctedWindows += 1;
    stats.redistributedDistanceUnits += candidate.targetDistanceUnits;
  }

  if (stats.correctedWindows > 0 && remainingPasses > 1) {
    correctCompactDistanceBatchingInPlace(compactRecords, remainingPasses - 1);
    const subsequentStats = compactRecords.distanceBatchingCorrectionStats;
    stats.correctedWindows += subsequentStats.correctedWindows;
    stats.correctedIntervals += subsequentStats.correctedIntervals;
    stats.redistributedDistanceUnits += subsequentStats.redistributedDistanceUnits;
    stats.detectedTransitions += subsequentStats.detectedTransitions;
    stats.rejectedWindows += subsequentStats.rejectedWindows;
    stats.passes += subsequentStats.passes;
  }

  stats.elapsedMs = performance.now() - startedAt;
  compactRecords.distanceBatchingCorrectionStats = stats;
  return compactRecords;
}

export function repairCompactSentinelPowerCorruptionInPlace(compactRecords, ranges = []) {
  const distances = compactRecords?.distancesQ;
  const speeds = compactRecords?.speedsCmS;
  const recordCount = Number(compactRecords?.recordCount || 0);
  const stats = {
    correctedWindows: 0,
    correctedSpeedSamples: 0,
    removedDistanceUnits: 0
  };

  if (!distances || !speeds || recordCount < 5) {
    return stats;
  }

  for (const range of ranges) {
    if (!range?.sentinel) continue;
    const repairStart = Number(range.start) - 1;
    const repairEnd = Number(range.end) + 1;
    const leftAnchor = repairStart - 1;
    const rightAnchor = repairEnd + 1;
    if (leftAnchor < 0 || rightAnchor >= recordCount) continue;

    const leftSpeed = Number(speeds[leftAnchor]);
    const rightSpeed = Number(speeds[rightAnchor]);
    const leftDistance = Number(distances[leftAnchor]);
    const originalEndDistance = Number(distances[repairEnd]);
    if (
      leftSpeed === COMPACT_SENTINELS.uint16
      || rightSpeed === COMPACT_SENTINELS.uint16
      || leftDistance === COMPACT_SENTINELS.uint32
      || originalEndDistance === COMPACT_SENTINELS.uint32
      || originalEndDistance < leftDistance
    ) {
      continue;
    }

    let peakWindowSpeed = 0;
    for (let index = repairStart; index <= repairEnd; index += 1) {
      if (speeds[index] !== COMPACT_SENTINELS.uint16) {
        peakWindowSpeed = Math.max(peakWindowSpeed, Number(speeds[index]));
      }
    }
    const anchorSpeed = Math.max(leftSpeed, rightSpeed);
    if (peakWindowSpeed < Math.max(2000, anchorSpeed + 1000)) {
      continue;
    }

    const sampleCount = repairEnd - repairStart + 1;
    const repairedSpeeds = new Uint16Array(sampleCount);
    const repairedDistanceUnits = new Uint32Array(sampleCount);
    let cumulativeExactUnits = 0;
    let cumulativeIntegerUnits = 0;
    for (let offset = 1; offset <= sampleCount; offset += 1) {
      const ratio = offset / (sampleCount + 1);
      const speed = Math.round(leftSpeed + ((rightSpeed - leftSpeed) * ratio));
      repairedSpeeds[offset - 1] = speed;
      cumulativeExactUnits += speed / 50;
      const nextIntegerUnits = Math.round(cumulativeExactUnits);
      repairedDistanceUnits[offset - 1] = nextIntegerUnits;
      cumulativeIntegerUnits = nextIntegerUnits;
    }

    const correctedEndDistance = leftDistance + cumulativeIntegerUnits;
    if (correctedEndDistance >= originalEndDistance) {
      continue;
    }
    const removedDistanceUnits = originalEndDistance - correctedEndDistance;
    for (let offset = 0; offset < sampleCount; offset += 1) {
      const index = repairStart + offset;
      speeds[index] = repairedSpeeds[offset];
      distances[index] = leftDistance + repairedDistanceUnits[offset];
    }
    if (removedDistanceUnits > 0) {
      for (let index = repairEnd + 1; index < recordCount; index += 1) {
        if (distances[index] === COMPACT_SENTINELS.uint32) continue;
        distances[index] = Math.max(0, Number(distances[index]) - removedDistanceUnits);
      }
    }

    stats.correctedWindows += 1;
    stats.correctedSpeedSamples += sampleCount;
    stats.removedDistanceUnits += removedDistanceUnits;
  }

  return stats;
}

function cleanCompactPowerArtifacts(
  compactRecords,
  { correctDistanceBatching = true } = {}
) {
  normalizeCompactMissingMetricsInPlace(compactRecords);
  const startedAt = performance.now();
  const correctedRanges = [];
  const stats = filterPowerArtifactsInPlace({
    recordCount: compactRecords.recordCount,
    powersW: compactRecords.powersW,
    cadencesRpm: compactRecords.cadencesRpm,
    heartRatesBpm: compactRecords.heartRatesBpm,
    speeds: compactRecords.speedsCmS
  }, {
    invalidPowerValue: COMPACT_SENTINELS.uint16,
    invalidCadenceValue: COMPACT_SENTINELS.uint8,
    invalidHeartRateValue: COMPACT_SENTINELS.uint8,
    invalidSpeedValue: COMPACT_SENTINELS.uint16,
    maximumSpeedDelta: 150,
    onCorrectedRange: (range) => correctedRanges.push(range)
  });
  const sentinelStats = repairCompactSentinelPowerCorruptionInPlace(
    compactRecords,
    correctedRanges
  );
  if (correctDistanceBatching) {
    correctCompactDistanceBatchingInPlace(compactRecords);
  }
  compactRecords.powerArtifactStats = {
    ...stats,
    sentinelMetricCorrections: sentinelStats,
    elapsedMs: performance.now() - startedAt
  };
  return compactRecords;
}

const COMPACT_RECORD_COLUMNS = [
  "timestampsSec",
  "distancesQ",
  "powersW",
  "heartRatesBpm",
  "cadencesRpm",
  "temperaturesC",
  "leftRightBalancesPct",
  "speedsCmS",
  "altitudesQ",
  "positionLatsE6",
  "positionLongsE6"
];

export function trimCompactCorruptTerminalTail(compactRecords) {
  const recordCount = Number(compactRecords?.recordCount || 0);
  const powers = compactRecords?.powersW;
  const cadences = compactRecords?.cadencesRpm;
  const heartRates = compactRecords?.heartRatesBpm;
  const speeds = compactRecords?.speedsCmS;
  if (recordCount < 16 || !powers || !cadences || !heartRates || !speeds) {
    return compactRecords;
  }

  let zeroTailStart = recordCount;
  while (zeroTailStart > 0) {
    const index = zeroTailStart - 1;
    if (powers[index] !== 0 || cadences[index] !== 0 || heartRates[index] !== 0 || speeds[index] !== 0) {
      break;
    }
    zeroTailStart -= 1;
  }
  if (recordCount - zeroTailStart < 3) {
    return compactRecords;
  }

  const searchStart = Math.max(6, zeroTailStart - 24);
  let cutoffIndex = -1;
  for (let index = searchStart; index < zeroTailStart; index += 1) {
    let baselinePower = 0;
    let baselineCadence = 0;
    for (let offset = index - 6; offset < index; offset += 1) {
      baselinePower += Number(powers[offset]);
      baselineCadence += Number(cadences[offset]);
    }
    baselinePower /= 6;
    baselineCadence /= 6;
    if (
      powers[index] >= 600
      && cadences[index] >= 130
      && powers[index] - baselinePower >= 250
      && cadences[index] - baselineCadence >= 25
      && baselinePower < 500
      && baselineCadence < 120
    ) {
      cutoffIndex = index;
      break;
    }
  }
  if (cutoffIndex < 0 || recordCount - cutoffIndex < 10) {
    return compactRecords;
  }

  let highPowerCount = 0;
  let highCadenceCount = 0;
  let stoppedPowerCount = 0;
  let missingHeartRatePowerCount = 0;
  for (let index = cutoffIndex; index < zeroTailStart; index += 1) {
    if (powers[index] >= 900) highPowerCount += 1;
    if (cadences[index] >= 140) highCadenceCount += 1;
    if (speeds[index] === 0 && powers[index] >= 500) stoppedPowerCount += 1;
    if (heartRates[index] === 0 && powers[index] >= 500) missingHeartRatePowerCount += 1;
  }
  if (
    highPowerCount < 5
    || highCadenceCount < 5
    || stoppedPowerCount < 5
    || missingHeartRatePowerCount < 5
  ) {
    return compactRecords;
  }

  const trimmedRecordCount = recordCount - cutoffIndex;
  for (const key of COMPACT_RECORD_COLUMNS) {
    const values = compactRecords[key];
    if (values?.subarray) {
      compactRecords[key] = values.subarray(0, cutoffIndex);
    }
  }
  compactRecords.recordCount = cutoffIndex;
  if (Number.isFinite(Number(compactRecords.lastTimestampSec))) {
    compactRecords.lastTimestampSec = Number(compactRecords.lastTimestampSec) - trimmedRecordCount;
  }
  compactRecords.terminalCorruptionTrimStats = {
    originalRecordCount: recordCount,
    correctedRecordCount: cutoffIndex,
    trimmedRecordCount
  };
  return compactRecords;
}

function adjustSessionsForTerminalTrim(sessions, compactRecords) {
  const trimStats = compactRecords?.terminalCorruptionTrimStats;
  const trimmedSeconds = Number(trimStats?.trimmedRecordCount || 0);
  if (!(trimmedSeconds > 0) || !Array.isArray(sessions) || sessions.length === 0) {
    return sessions;
  }

  const adjusted = sessions.map((session) => ({ ...session }));
  const lastSession = adjusted.at(-1);
  for (const key of ["total_timer_time", "total_elapsed_time"]) {
    const value = Number(lastSession?.[key]);
    if (Number.isFinite(value)) {
      lastSession[key] = Math.max(0, value - trimmedSeconds);
    }
  }

  if (adjusted.length === 1 && compactRecords.recordCount > 0) {
    const distanceQ = Number(compactRecords.distancesQ?.[compactRecords.recordCount - 1]);
    if (Number.isFinite(distanceQ) && distanceQ !== COMPACT_SENTINELS.uint32) {
      lastSession.total_distance = distanceQ * 0.5;
    }
  }
  return adjusted;
}

function fillGapsCompactRecords(compactRecords, options = {}) {
  const recordCount = Number(compactRecords?.recordCount || 0);
  const timestampsSec = compactRecords?.timestampsSec;
  if (!(recordCount > 1) || !timestampsSec || timestampsSec.length !== recordCount) {
    return { ...compactRecords, timestampsSec: null };
  }

  repairCompactPedalConnectivityDropoutsInPlace(compactRecords);

  const maxGap = 5;

  const lerp = (left, right, ratio, fallback = Number.NaN) => {
    const leftValid = Number.isFinite(left);
    const rightValid = Number.isFinite(right);
    if (!leftValid && !rightValid) return fallback;
    if (!leftValid) return right;
    if (!rightValid) return left;
    return left + ((right - left) * ratio);
  };

  const decodeUint32Sentinel = (value) => value !== COMPACT_SENTINELS.uint32 ? Number(value) : Number.NaN;
  const decodeUint16Sentinel = (value) => value !== COMPACT_SENTINELS.uint16 ? Number(value) : Number.NaN;
  const decodeUint8Sentinel = (value) => value !== COMPACT_SENTINELS.uint8 ? Number(value) : Number.NaN;
  const decodeInt16Sentinel = (value) => value !== COMPACT_SENTINELS.int16 ? Number(value) : Number.NaN;
  const decodeInt8Sentinel = (value) => value !== COMPACT_TEMPERATURE_SENTINEL ? Number(value) : Number.NaN;
  const decodeBalanceSentinel = (value) => value !== COMPACT_LEFT_RIGHT_BALANCE_SENTINEL ? Number(value) : Number.NaN;

  const encodeUint32 = (value) => Number.isFinite(value)
    ? Math.max(0, Math.min(COMPACT_SENTINELS.uint32 - 1, Math.round(value)))
    : COMPACT_SENTINELS.uint32;
  const encodeUint16 = (value) => Number.isFinite(value)
    ? Math.max(0, Math.min(COMPACT_SENTINELS.uint16 - 1, Math.round(value)))
    : COMPACT_SENTINELS.uint16;
  const encodeUint8 = (value) => Number.isFinite(value)
    ? Math.max(0, Math.min(COMPACT_SENTINELS.uint8 - 1, Math.round(value)))
    : COMPACT_SENTINELS.uint8;
  const encodeInt16 = (value) => Number.isFinite(value)
    ? Math.max(-32767, Math.min(32767, Math.round(value)))
    : COMPACT_SENTINELS.int16;
  const encodeInt8 = (value) => Number.isFinite(value)
    ? Math.max(-128, Math.min(126, Math.round(value)))
    : COMPACT_TEMPERATURE_SENTINEL;
  const encodeBalance = (value) => Number.isFinite(value)
    ? Math.max(0, Math.min(100, Math.round(value)))
    : COMPACT_LEFT_RIGHT_BALANCE_SENTINEL;

  const countInterpolatedSteps = () => {
    let interpolatedCount = 0;
    for (let index = 0; index < recordCount - 1; index += 1) {
      const t0Sec = Number(timestampsSec[index]);
      const t1Sec = Number(timestampsSec[index + 1]);
      if (!Number.isFinite(t0Sec) || !Number.isFinite(t1Sec) || t0Sec === COMPACT_SENTINELS.uint32 || t1Sec === COMPACT_SENTINELS.uint32) {
        continue;
      }

      const gap = t1Sec - t0Sec;
      if (gap > 1 && gap <= maxGap) {
        interpolatedCount += gap - 1;
      }
    }
    return interpolatedCount;
  };

  const outputRecordCount = recordCount + countInterpolatedSteps();
  if (outputRecordCount === recordCount) {
    return cleanCompactPowerArtifacts(
      { ...compactRecords, timestampsSec: null },
      options
    );
  }

  const outDistancesQ = new Uint32Array(outputRecordCount);
  const outPowersW = new Uint16Array(outputRecordCount);
  const outHeartRatesBpm = new Uint8Array(outputRecordCount);
  const outCadencesRpm = new Uint8Array(outputRecordCount);
  const outTemperaturesC = new Int8Array(outputRecordCount);
  const outLeftRightBalancesPct = new Uint8Array(outputRecordCount);
  const outSpeedsCmS = new Uint16Array(outputRecordCount);
  const outAltitudesQ = new Int16Array(outputRecordCount);
  const outPositionLatsE6 = new Int32Array(outputRecordCount);
  const outPositionLongsE6 = new Int32Array(outputRecordCount);

  const pushRecord = (writeIndex, sourceIndex) => {
    outDistancesQ[writeIndex] = Number(compactRecords.distancesQ[sourceIndex]);
    outPowersW[writeIndex] = Number(compactRecords.powersW[sourceIndex]);
    outHeartRatesBpm[writeIndex] = Number(compactRecords.heartRatesBpm[sourceIndex]);
    outCadencesRpm[writeIndex] = Number(compactRecords.cadencesRpm[sourceIndex]);
    outTemperaturesC[writeIndex] = Number(compactRecords.temperaturesC[sourceIndex]);
    outLeftRightBalancesPct[writeIndex] = Number(compactRecords.leftRightBalancesPct[sourceIndex]);
    outSpeedsCmS[writeIndex] = Number(compactRecords.speedsCmS[sourceIndex]);
    outAltitudesQ[writeIndex] = Number(compactRecords.altitudesQ[sourceIndex]);
    outPositionLatsE6[writeIndex] = Number(compactRecords.positionLatsE6[sourceIndex]);
    outPositionLongsE6[writeIndex] = Number(compactRecords.positionLongsE6[sourceIndex]);
    return writeIndex + 1;
  };

  let writeIndex = 0;
  for (let index = 0; index < recordCount - 1; index += 1) {
    writeIndex = pushRecord(writeIndex, index);

    const t0Sec = Number(timestampsSec[index]);
    const t1Sec = Number(timestampsSec[index + 1]);
    if (!Number.isFinite(t0Sec) || !Number.isFinite(t1Sec) || t0Sec === COMPACT_SENTINELS.uint32 || t1Sec === COMPACT_SENTINELS.uint32) {
      continue;
    }

    const gap = t1Sec - t0Sec;
    if (gap > 1 && gap <= maxGap) {
      const steps = gap - 1;
      for (let step = 1; step <= steps; step += 1) {
        const ratio = step / gap;
        outDistancesQ[writeIndex] = encodeUint32(lerp(
          decodeUint32Sentinel(compactRecords.distancesQ[index]),
          decodeUint32Sentinel(compactRecords.distancesQ[index + 1]),
          ratio,
          Number.NaN
        ));
        outPowersW[writeIndex] = encodeUint16(lerp(
          decodeUint16Sentinel(compactRecords.powersW[index]),
          decodeUint16Sentinel(compactRecords.powersW[index + 1]),
          ratio,
          0
        ));
        outHeartRatesBpm[writeIndex] = encodeUint8(lerp(
          decodeUint8Sentinel(compactRecords.heartRatesBpm[index]),
          decodeUint8Sentinel(compactRecords.heartRatesBpm[index + 1]),
          ratio,
          Number.NaN
        ));
        outCadencesRpm[writeIndex] = encodeUint8(lerp(
          decodeUint8Sentinel(compactRecords.cadencesRpm[index]),
          decodeUint8Sentinel(compactRecords.cadencesRpm[index + 1]),
          ratio,
          Number.NaN
        ));
        outTemperaturesC[writeIndex] = encodeInt8(lerp(
          decodeInt8Sentinel(compactRecords.temperaturesC[index]),
          decodeInt8Sentinel(compactRecords.temperaturesC[index + 1]),
          ratio,
          Number.NaN
        ));
        outLeftRightBalancesPct[writeIndex] = encodeBalance(lerp(
          decodeBalanceSentinel(compactRecords.leftRightBalancesPct[index]),
          decodeBalanceSentinel(compactRecords.leftRightBalancesPct[index + 1]),
          ratio,
          Number.NaN
        ));
        outSpeedsCmS[writeIndex] = encodeUint16(lerp(
          decodeUint16Sentinel(compactRecords.speedsCmS[index]),
          decodeUint16Sentinel(compactRecords.speedsCmS[index + 1]),
          ratio,
          Number.NaN
        ));
        outAltitudesQ[writeIndex] = encodeInt16(lerp(
          decodeInt16Sentinel(compactRecords.altitudesQ[index]),
          decodeInt16Sentinel(compactRecords.altitudesQ[index + 1]),
          ratio,
          Number.NaN
        ));
        outPositionLatsE6[writeIndex] = COMPACT_SENTINELS.int32;
        outPositionLongsE6[writeIndex] = COMPACT_SENTINELS.int32;
        writeIndex += 1;
      }
    }
  }

  writeIndex = pushRecord(writeIndex, recordCount - 1);

  const filledRecords = {
    ...compactRecords,
    recordCount: writeIndex,
    timestampsSec: null,
    distancesQ: outDistancesQ,
    powersW: outPowersW,
    heartRatesBpm: outHeartRatesBpm,
    cadencesRpm: outCadencesRpm,
    temperaturesC: outTemperaturesC,
    leftRightBalancesPct: outLeftRightBalancesPct,
    speedsCmS: outSpeedsCmS,
    altitudesQ: dropAllZeroAltitudeColumn(outAltitudesQ),
    positionLatsE6: outPositionLatsE6,
    positionLongsE6: outPositionLongsE6
  };
  return cleanCompactPowerArtifacts(filledRecords, options);
}

export function discardPlaceholderLeftRightBalance(compactRecords) {
  const values = compactRecords?.leftRightBalancesPct;
  if (!values?.length) {
    return compactRecords;
  }

  let hasValidValue = false;
  let hasMeasuredVariation = false;
  for (let index = 0; index < values.length; index += 1) {
    const value = Number(values[index]);
    if (value === COMPACT_LEFT_RIGHT_BALANCE_SENTINEL) continue;
    if (value >= 0 && value <= 100) {
      hasValidValue = true;
      if (value !== 50) {
        hasMeasuredVariation = true;
        break;
      }
    }
  }

  if (hasValidValue && !hasMeasuredVariation) {
    values.fill(COMPACT_LEFT_RIGHT_BALANCE_SENTINEL);
  }
  return compactRecords;
}

function makeCompactRecordOps(fields, littleEndian) {
  const ops = [];
  let offset = 0;
  for (const field of fields) {
    const number = field.number;
    const size = field.size;
    let kind = 0;
    if (number === 253 && size === 4) kind = 1;
    else if (number === 0 && size === 4) kind = 2;
    else if (number === 1 && size === 4) kind = 3;
    else if (number === 2 && size === 2) kind = 4;
    else if (number === 78 && size === 4) kind = 12;
    else if (number === 3 && size === 1) kind = 5;
    else if (number === 4 && size === 1) kind = 6;
    else if (number === 5 && size === 4) kind = 7;
    else if (number === 6 && size === 2) kind = 8;
    else if (number === 73 && size === 4) kind = 11;
    else if (number === 7 && size === 2) kind = 9;
    else if (number === 13 && size === 1) kind = 13;
    else if (number === 30 && size === 1) kind = 14;
    if (kind !== 0) {
      ops.push({ kind, offset, littleEndian });
    }
    offset += size;
  }
  return { ops, messageBytes: offset };
}

function makeMetadataOps(globalMessage, fields, littleEndian) {
  const message = FIT.messages[globalMessage] || {};
  const ops = [];
  let offset = 0;
  for (const field of fields) {
    const definition = message[field.number];
    if (definition?.field) {
      ops.push({
        field: definition.field,
        type: definition.type || "byte",
        scale: definition.scale ?? null,
        valueOffset: definition.offset || 0,
        size: field.size,
        baseType: field.baseType,
        littleEndian,
        offset
      });
    }
    offset += field.size;
  }
  return ops;
}

function readMetadataValue(bytes, dataOffset, op) {
  if ((op.baseType & 0x1f) === 0x07) {
    const raw = bytes.subarray(dataOffset + op.offset, dataOffset + op.offset + op.size);
    const nullIndex = raw.indexOf(0);
    const value = textDecoder.decode(nullIndex >= 0 ? raw.subarray(0, nullIndex) : raw).trim();
    return value || null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset + dataOffset);
  const rawValue = readRawFitValue(view, op.offset, op.size, op.baseType, op.littleEndian);
  if (rawValue == null || isInvalidRawValue(rawValue, op.size, op.baseType)) return null;
  if (op.type === "date_time") return (rawValue * 1000) + GARMIN_TIME_OFFSET_MS;
  return op.scale ? (rawValue / op.scale) + op.valueOffset : rawValue;
}

function fitTypeName(type, value) {
  if (value == null) return null;
  return FIT.types?.[type]?.[value] ?? null;
}

function resolveProductName(manufacturer, product, explicitName = null) {
  if (explicitName) return explicitName;
  if (Number(manufacturer) === 1) {
    return GARMIN_PRODUCT_NAMES.get(Number(product))
      || FIT.types?.garmin_product?.[product]
      || null;
  }
  return null;
}

function normalizeFileId(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    type: raw.type ?? null,
    typeName: fitTypeName("file", raw.type),
    manufacturer: raw.manufacturer ?? null,
    manufacturerName: fitTypeName("manufacturer", raw.manufacturer),
    product: raw.product ?? null,
    productName: resolveProductName(raw.manufacturer, raw.product, raw.product_name),
    serialNumber: raw.serial_number ?? null,
    timeCreated: Number.isFinite(Number(raw.time_created))
      ? new Date(Number(raw.time_created)).toISOString()
      : null,
    number: raw.number ?? null
  };
}

function normalizeDeviceInfo(raw) {
  if (!raw || typeof raw !== "object") return null;
  const sourceTypeName = fitTypeName("source_type", raw.source_type);
  const deviceTypeMap = sourceTypeName === "ant" || sourceTypeName === "antplus"
    ? "antplus_device_type"
    : "local_device_type";
  return {
    timestamp: Number.isFinite(Number(raw.timestamp)) ? new Date(Number(raw.timestamp)).toISOString() : null,
    deviceIndex: raw.device_index ?? null,
    deviceType: raw.device_type ?? null,
    deviceTypeName: fitTypeName(deviceTypeMap, raw.device_type),
    manufacturer: raw.manufacturer ?? null,
    manufacturerName: fitTypeName("manufacturer", raw.manufacturer),
    serialNumber: raw.serial_number ?? null,
    product: raw.product ?? null,
    productName: resolveProductName(raw.manufacturer, raw.product, raw.product_name),
    softwareVersion: raw.software_version ?? null,
    hardwareVersion: raw.hardware_version ?? null,
    cumulativeOperatingTime: raw.cum_operating_time ?? null,
    batteryVoltage: raw.battery_voltage ?? null,
    batteryStatus: raw.battery_status ?? null,
    batteryStatusName: fitTypeName("battery_status", raw.battery_status),
    batteryLevel: raw.battery_level ?? null,
    sensorPosition: raw.sensor_position ?? null,
    sensorPositionName: fitTypeName("body_location", raw.sensor_position),
    descriptor: raw.descriptor ?? null,
    antTransmissionType: raw.ant_transmission_type ?? null,
    antDeviceNumber: raw.ant_device_number ?? null,
    antNetwork: raw.ant_network ?? null,
    antId: raw.ant_id ?? null,
    sourceType: raw.source_type ?? null,
    sourceTypeName
  };
}

function deduplicateDeviceInfo(devices) {
  const byKey = new Map();
  for (const device of devices) {
    const normalized = normalizeDeviceInfo(device);
    if (!normalized) continue;
    const key = [
      normalized.deviceIndex,
      normalized.sourceType,
      normalized.antId,
      normalized.serialNumber,
      normalized.deviceType
    ].join(":");
    byKey.set(key, normalized);
  }
  return [...byKey.values()];
}

function makeSessionOps(fields, littleEndian) {
  const message = FIT.messages[18] || {};
  const ops = [];
  let offset = 0;
  for (const field of fields) {
    const definition = message[field.number] || {};
    if (SESSION_FIELDS.has(definition.field)) {
      ops.push({
        field: definition.field,
        type: definition.type || "byte",
        scale: definition.scale ?? null,
        valueOffset: definition.offset || 0,
        size: field.size,
        baseType: field.baseType,
        littleEndian,
        offset,
      });
    }
    offset += field.size;
  }
  return ops;
}

function makeLapOps(fields, littleEndian) {
  const message = FIT.messages[19] || {};
  const ops = [];
  let offset = 0;
  for (const field of fields) {
    const definition = message[field.number] || {};
    if (LAP_FIELDS.has(definition.field)) {
      ops.push({
        field: definition.field,
        type: definition.type || "byte",
        scale: definition.scale ?? null,
        valueOffset: definition.offset || 0,
        size: field.size,
        baseType: field.baseType,
        littleEndian,
        offset,
      });
    }
    offset += field.size;
  }
  return ops;
}

function decodeSessionValue(rawValue, op) {
  if (rawValue == null || isInvalidRawValue(rawValue, op.size, op.baseType)) {
    return null;
  }
  switch (op.field) {
    case "timestamp":
    case "start_time":
      return (rawValue * 1000) + GARMIN_TIME_OFFSET_MS;
    case "nec_lat":
    case "nec_long":
    case "swc_lat":
    case "swc_long":
      return rawValue * SEMICIRCLES_TO_DEGREES;
    default:
      return op.scale ? (rawValue / op.scale) + op.valueOffset : rawValue;
  }
}

function decodeLapValue(rawValue, op) {
  if (rawValue == null || isInvalidRawValue(rawValue, op.size, op.baseType)) {
    return null;
  }
  if (op.field === "timestamp" || op.field === "start_time") {
    return (rawValue * 1000) + GARMIN_TIME_OFFSET_MS;
  }
  return op.scale ? (rawValue / op.scale) + op.valueOffset : rawValue;
}

export function parseFitBufferCompactBrowser(
  buffer,
  {
    excludeStartTimes = null,
    correctDistanceBatching = true
  } = {}
) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length < 12 || (bytes[0] !== 12 && bytes[0] !== 14)) {
    throw new Error("Invalid FIT header");
  }
  if (bytes[8] !== 46 || bytes[9] !== 70 || bytes[10] !== 73 || bytes[11] !== 84) {
    throw new Error("Missing .FIT in FIT header");
  }

  const excluded = normalizeExcludeStartTimeSet(excludeStartTimes);
  const headerLength = bytes[0];
  const dataLength = readU32LE(bytes, 4);
  const end = headerLength + dataLength;
  const definitions = [];
  let compactRecordBuffer = createCompactRecordBuffer();
  const sessions = [];
  const laps = [];
  let fileId = null;
  const deviceInfo = [];
  let baseTimestampSec = COMPACT_SENTINELS.uint32;
  let cursor = headerLength;

  while (cursor < end) {
    const header = bytes[cursor];
    const compressed = (header & 0x80) !== 0;
    const localMessage = compressed ? ((header & 0x60) >> 5) : (header & 0x0f);

    if (!compressed && (header & 0x40) !== 0) {
      const hasDeveloper = (header & 0x20) !== 0;
      const littleEndian = bytes[cursor + 2] === 0;
      const globalMessage = littleEndian ? readU16LE(bytes, cursor + 3) : readU16BE(bytes, cursor + 3);
      const fieldCount = bytes[cursor + 5];
      const fields = new Array(fieldCount);
      let offset = cursor + 6;
      for (let index = 0; index < fieldCount; index += 1) {
        fields[index] = {
          number: bytes[offset],
          size: bytes[offset + 1],
          baseType: bytes[offset + 2],
        };
        offset += 3;
      }
      let developerMessageBytes = 0;
      if (hasDeveloper) {
        const developerCount = bytes[offset];
        offset += 1;
        for (let index = 0; index < developerCount; index += 1) {
          developerMessageBytes += bytes[offset + 1];
          offset += 3;
        }
      }
      const recordDefinition = globalMessage === 20
        ? makeCompactRecordOps(fields, littleEndian)
        : { ops: null, messageBytes: fields.reduce((sum, field) => sum + field.size, 0) };
      definitions[localMessage] = {
        globalMessage,
        ...recordDefinition,
        messageBytes: recordDefinition.messageBytes + developerMessageBytes,
        sessionOps: globalMessage === 18 ? makeSessionOps(fields, littleEndian) : null,
        lapOps: globalMessage === 19 ? makeLapOps(fields, littleEndian) : null,
        metadataOps: globalMessage === 0 || globalMessage === 23
          ? makeMetadataOps(globalMessage, fields, littleEndian)
          : null,
      };
      cursor = offset;
      continue;
    }

    const definition = definitions[localMessage];
    if (!definition) {
      throw new Error(`Missing FIT message definition for local message type ${localMessage}`);
    }

    const dataOffset = cursor + 1;
    if (definition.globalMessage === 20) {
      let timestampSec = COMPACT_SENTINELS.uint32;
      let distance = COMPACT_SENTINELS.uint32;
      let power = COMPACT_SENTINELS.uint16;
      let heartRate = COMPACT_SENTINELS.uint8;
      let cadence = COMPACT_SENTINELS.uint8;
      let temperature = COMPACT_TEMPERATURE_SENTINEL;
      let leftRightBalance = COMPACT_LEFT_RIGHT_BALANCE_SENTINEL;
      let speed = COMPACT_SENTINELS.uint16;
      let altitude = COMPACT_SENTINELS.int16;
      let lat = COMPACT_SENTINELS.int32;
      let lng = COMPACT_SENTINELS.int32;

      for (const op of definition.ops || []) {
        const o = dataOffset + op.offset;
        switch (op.kind) {
          case 1: {
            const raw = op.littleEndian ? readU32LE(bytes, o) : readU32BE(bytes, o);
            if (raw !== 0xffffffff) {
              timestampSec = compactTimestampSecFromGarmin(raw);
              if (baseTimestampSec === COMPACT_SENTINELS.uint32) baseTimestampSec = timestampSec;
            }
            break;
          }
          case 2: {
            const raw = op.littleEndian ? readI32LE(bytes, o) : readI32BE(bytes, o);
            if (raw !== 0x7fffffff) lat = compactCoordFromSemicircles(raw);
            break;
          }
          case 3: {
            const raw = op.littleEndian ? readI32LE(bytes, o) : readI32BE(bytes, o);
            if (raw !== 0x7fffffff) lng = compactCoordFromSemicircles(raw);
            break;
          }
          case 4: {
            const raw = op.littleEndian ? readU16LE(bytes, o) : readU16BE(bytes, o);
            if (raw !== 0xffff) altitude = compactAltitude(raw / 5 - 500);
            break;
          }
          case 12: {
            const raw = op.littleEndian ? readU32LE(bytes, o) : readU32BE(bytes, o);
            if (raw !== 0xffffffff) altitude = compactAltitude(raw / 5 - 500);
            break;
          }
          case 5:
            if (bytes[o] !== 0xff) heartRate = bytes[o];
            break;
          case 6:
            if (bytes[o] !== 0xff) cadence = bytes[o];
            break;
          case 7: {
            const raw = op.littleEndian ? readU32LE(bytes, o) : readU32BE(bytes, o);
            if (raw !== 0xffffffff) distance = compactDistanceFromCentimeters(raw);
            break;
          }
          case 8: {
            const raw = op.littleEndian ? readU16LE(bytes, o) : readU16BE(bytes, o);
            if (raw !== 0xffff) speed = Math.min(0xfffe, Math.round(raw / 10));
            break;
          }
          case 11: {
            const raw = op.littleEndian ? readU32LE(bytes, o) : readU32BE(bytes, o);
            if (raw !== 0xffffffff) speed = Math.min(0xfffe, Math.round(raw / 10));
            break;
          }
          case 9: {
            const raw = op.littleEndian ? readU16LE(bytes, o) : readU16BE(bytes, o);
            if (raw !== 0xffff) power = Math.min(0xfffe, raw);
            break;
          }
          case 13: {
            const raw = bytes[o];
            if (raw !== 0x7f) temperature = raw > 0x7f ? raw - 0x100 : raw;
            break;
          }
          case 14: {
            const raw = bytes[o];
            if (raw !== 0xff) {
              const percentage = raw & 0x7f;
              leftRightBalance = Math.min(100, (raw & 0x80) !== 0 ? percentage : 100 - percentage);
            }
            break;
          }
          default:
            break;
        }
      }

      compactRecordBuffer = appendCompactRecord(compactRecordBuffer, {
        timestampSec,
        distance,
        power,
        heartRate,
        cadence,
        temperature,
        leftRightBalance,
        speed,
        altitude,
        lat,
        lng,
      });
    } else if (definition.globalMessage === 18) {
      const session = {};
      const view = new DataView(bytes.buffer, bytes.byteOffset + dataOffset);
      for (const op of definition.sessionOps || []) {
        const raw = readRawFitValue(view, op.offset, op.size, op.baseType, op.littleEndian);
        session[op.field] = decodeSessionValue(raw, op);
      }
      sessions.push(session);
    } else if (definition.globalMessage === 19) {
      const lap = {};
      const view = new DataView(bytes.buffer, bytes.byteOffset + dataOffset);
      for (const op of definition.lapOps || []) {
        const raw = readRawFitValue(view, op.offset, op.size, op.baseType, op.littleEndian);
        lap[op.field] = decodeLapValue(raw, op);
      }
      laps.push(lap);
    } else if (definition.globalMessage === 0 || definition.globalMessage === 23) {
      const metadata = {};
      for (const op of definition.metadataOps || []) {
        metadata[op.field] = readMetadataValue(bytes, dataOffset, op);
      }
      if (definition.globalMessage === 0) fileId = normalizeFileId(metadata);
      else deviceInfo.push(metadata);
    }

    cursor += 1 + definition.messageBytes;
  }

  let minStartTimeMs = Number.POSITIVE_INFINITY;
  for (const session of sessions) {
    const value = Number(session?.start_time);
    if (Number.isFinite(value) && value < minStartTimeMs) {
      minStartTimeMs = value;
    }
  }
  const startTimeKey = toIsoStartTimeKey(minStartTimeMs);
  if (excluded && startTimeKey && excluded.has(startTimeKey)) {
    return {
      skippedExisting: true,
      skippedStartTime: startTimeKey,
      sessions,
      laps,
      fitDeviceMetadata: {
        version: 1,
        fileId,
        devices: deduplicateDeviceInfo(deviceInfo)
      },
      compactRecords: null,
    };
  }

  const cleanedCompactRecords = discardPlaceholderLeftRightBalance(
    fillGapsCompactRecords(
      finalizeCompactRecordBuffer(compactRecordBuffer, baseTimestampSec),
      { correctDistanceBatching }
    )
  );
  // A terminal corruption can be mapped safely only for a single-session FIT.
  const compactRecords = sessions.length === 1
    ? trimCompactCorruptTerminalTail(cleanedCompactRecords)
    : cleanedCompactRecords;
  return {
    skippedExisting: false,
    skippedStartTime: null,
    sessions: adjustSessionsForTerminalTrim(sessions, compactRecords),
    laps,
    fitDeviceMetadata: {
      version: 1,
      fileId,
      devices: deduplicateDeviceInfo(deviceInfo)
    },
    compactRecords,
  };
}

function quantizeCompactUintArrayInPlace(sourceArray, step, sentinel, maxValue) {
  const normalizedStep = Math.max(1, Number.parseInt(String(step ?? 1), 10) || 1);
  if (normalizedStep <= 1 || !sourceArray) {
    return sourceArray;
  }

  for (let index = 0; index < sourceArray.length; index += 1) {
    const value = Number(sourceArray[index]);
    if (!Number.isFinite(value) || value === sentinel) {
      continue;
    }
    sourceArray[index] = Math.max(0, Math.min(maxValue, Math.round(value / normalizedStep) * normalizedStep));
  }
  return sourceArray;
}

export function applyCompactEncodingOptions(parsedCompact, encodingOptions = {}) {
  const compact = parsedCompact?.compactRecords;
  if (!compact || !Number.isFinite(Number(compact.recordCount))) {
    return parsedCompact;
  }

  const powerStep = Math.max(1, Number.parseInt(String(encodingOptions.powerStep ?? 4), 10) || 4);
  const cadenceStep = Math.max(1, Number.parseInt(String(encodingOptions.cadenceStep ?? 2), 10) || 2);
  const hrStep = Math.max(1, Number.parseInt(String(encodingOptions.hrStep ?? 2), 10) || 2);

  quantizeCompactUintArrayInPlace(
    compact.powersW,
    powerStep,
    COMPACT_SENTINELS.uint16,
    COMPACT_SENTINELS.uint16 - 1
  );
  quantizeCompactUintArrayInPlace(
    compact.cadencesRpm,
    cadenceStep,
    COMPACT_SENTINELS.uint8,
    COMPACT_SENTINELS.uint8 - 1
  );
  quantizeCompactUintArrayInPlace(
    compact.heartRatesBpm,
    hrStep,
    COMPACT_SENTINELS.uint8,
    COMPACT_SENTINELS.uint8 - 1
  );
  return parsedCompact;
}
