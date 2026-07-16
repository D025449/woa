import IntervalDetector from "./IntervalDetector.js";

const UINT8_NAN = 0xff;
const UINT16_NAN = 0xffff;
const UINT32_NAN = 0xffffffff;
const INT16_NAN = -0x8000;
const BEST_EFFORT_DURATIONS = [5, 15, 60, 120, 240, 480, 900, 1800];
const textEncoder = new TextEncoder();

function recordCountOf(compact) {
  return Math.max(0, Number(compact?.recordCount || 0));
}

function powerAt(compact, index) {
  const value = Number(compact.powersW[index]);
  return value === UINT16_NAN ? 0 : value;
}

function heartRateAt(compact, index) {
  const value = Number(compact.heartRatesBpm[index]);
  return value === UINT8_NAN ? 0 : value;
}

function cadenceAt(compact, index) {
  const value = Number(compact.cadencesRpm[index]);
  return value === UINT8_NAN ? 0 : value;
}

function altitudeMetersAt(compact, index) {
  const value = Number(compact.altitudesQ[index]);
  return value === INT16_NAN ? 0 : Math.round(value / 4);
}

function hasCompleteDistanceSeries(compact, recordCount) {
  for (let index = 0; index < recordCount; index += 1) {
    if (Number(compact.distancesQ[index]) === UINT32_NAN) return false;
  }
  return recordCount > 0;
}

function speedMpsAt(compact, index, useDistance) {
  if (useDistance) {
    if (index === 0) return 0;
    return Math.max(0, (Number(compact.distancesQ[index]) - Number(compact.distancesQ[index - 1])) * 0.5);
  }
  const value = Number(compact.speedsCmS[index]);
  return value === UINT16_NAN ? 0 : value / 100;
}

function buildAutoInterval(compact, smoothPower, start, end, useDistance) {
  let sumPower = 0;
  let sumHeartRate = 0;
  let sumSpeed = 0;
  let sumCadence = 0;

  for (let index = start; index < end; index += 1) {
    sumPower += smoothPower[index];
    sumHeartRate += heartRateAt(compact, index);
    sumSpeed += speedMpsAt(compact, index, useDistance);
    sumCadence += cadenceAt(compact, index);
  }

  const duration = end - start;
  const altitudeStart = altitudeMetersAt(compact, start) * 1000;
  const altitudeEnd = altitudeMetersAt(compact, end - 1) * 1000;
  return {
    start,
    end,
    duration,
    avgPower: Math.round(sumPower / duration),
    avgHeartRate: Math.round(sumHeartRate / duration),
    avgSpeed: IntervalDetector.round1(sumSpeed / duration),
    avgCadence: Math.round(sumCadence / duration),
    altitude_start: altitudeStart,
    altitude_end: altitudeEnd,
    altimeters: altitudeEnd - altitudeStart
  };
}

function detectAutoSegments(compact) {
  const recordCount = recordCountOf(compact);
  const power = new Float32Array(recordCount);
  for (let index = 0; index < recordCount; index += 1) power[index] = powerAt(compact, index);

  const smoothPower = IntervalDetector.movingAverage(power, 7);
  const baseline = IntervalDetector.computeBaseline(smoothPower);
  const enterThreshold = baseline * 1.4;
  const exitThreshold = baseline * 1.1;
  const intervals = [];
  const useDistance = hasCompleteDistanceSeries(compact, recordCount);
  let state = 0;
  let start = 0;

  for (let index = 0; index < recordCount; index += 1) {
    const currentPower = smoothPower[index];
    if (state === 0) {
      if (currentPower > enterThreshold) {
        state = 1;
        start = index;
      }
      continue;
    }
    if (currentPower >= exitThreshold) continue;

    const duration = index - start;
    if (duration >= 20) {
      const startHeartRate = heartRateAt(compact, start);
      const endHeartRate = heartRateAt(compact, index - 1);
      let valid = endHeartRate >= startHeartRate + 5;

      if (valid) {
        let activeCadenceSamples = 0;
        for (let sample = start; sample < index; sample += 1) {
          if (cadenceAt(compact, sample) > 0) activeCadenceSamples += 1;
        }
        valid = activeCadenceSamples > duration * 0.5;
      }
      if (valid) intervals.push(buildAutoInterval(compact, smoothPower, start, index, useDistance));
    }
    state = 0;
  }

  return IntervalDetector.mergeCloseIntervals(intervals, 10);
}

function detectBestEffortSegments(compact) {
  const recordCount = recordCountOf(compact);
  if (recordCount === 0) return [];

  const powerPrefix = new Float64Array(recordCount + 1);
  for (let index = 0; index < recordCount; index += 1) {
    powerPrefix[index + 1] = powerPrefix[index] + powerAt(compact, index);
  }

  const useDistance = hasCompleteDistanceSeries(compact, recordCount);
  const results = [];
  for (const duration of BEST_EFFORT_DURATIONS) {
    if (duration > recordCount) continue;
    let bestOffset = 0;
    let bestPowerSum = -Infinity;
    for (let offset = 0; offset <= recordCount - duration; offset += 1) {
      const sum = powerPrefix[offset + duration] - powerPrefix[offset];
      if (sum > bestPowerSum) {
        bestPowerSum = sum;
        bestOffset = offset;
      }
    }

    let heartRateSum = 0;
    let cadenceSum = 0;
    let speedSum = 0;
    for (let index = bestOffset; index < bestOffset + duration; index += 1) {
      heartRateSum += heartRateAt(compact, index);
      cadenceSum += cadenceAt(compact, index);
      speedSum += speedMpsAt(compact, index, useDistance);
    }
    const endOffset = bestOffset + duration - 1;
    results.push({
      start: bestOffset,
      end: endOffset,
      duration,
      avgPower: Math.round(bestPowerSum / duration),
      avgHeartRate: Math.round(heartRateSum / duration),
      avgCadence: Math.round(cadenceSum / duration),
      avgSpeed: Number((speedSum / duration).toFixed(2)),
      altimeters: (altitudeMetersAt(compact, endOffset) - altitudeMetersAt(compact, bestOffset)) * 1000
    });
  }
  return results;
}

export function detectWorkoutLocalSegmentsCompact(compact) {
  const auto = detectAutoSegments(compact);
  const bestEfforts = detectBestEffortSegments(compact);
  return [
    ...auto.map((segment) => ({ ...segment, type: 1 })),
    ...bestEfforts.map((segment) => ({ ...segment, type: 2 }))
  ];
}

function clampInteger(value, min, max, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(min, Math.min(max, Math.round(numeric))) : fallback;
}

export function encodeWorkoutLocalPostprocessTransport(workouts = []) {
  const normalized = Array.isArray(workouts) ? workouts : [];
  const segmentCount = normalized.reduce((sum, workout) => sum + (Array.isArray(workout?.segments) ? workout.segments.length : 0), 0);
  const headerBytes = 24;
  const workoutBytes = normalized.length * 14;
  const segmentBytes = segmentCount * 23;
  const bytes = new Uint8Array(headerBytes + workoutBytes + segmentBytes);
  const view = new DataView(bytes.buffer);
  bytes.set(textEncoder.encode("WPP1"), 0);
  view.setUint16(4, 2, true);
  view.setUint16(6, 0, true);
  view.setUint32(8, normalized.length, true);
  view.setUint32(12, segmentCount, true);
  view.setUint32(16, headerBytes, true);
  view.setUint32(20, headerBytes + workoutBytes, true);

  let workoutOffset = headerBytes;
  let firstSegment = 0;
  for (const workout of normalized) {
    const segments = Array.isArray(workout?.segments) ? workout.segments : [];
    view.setUint32(workoutOffset, clampInteger(workout?.startTimeSec, 0, UINT32_NAN - 1), true);
    view.setUint32(workoutOffset + 4, clampInteger(workout?.recordCount, 0, UINT32_NAN - 1), true);
    view.setUint32(workoutOffset + 8, firstSegment, true);
    view.setUint16(workoutOffset + 12, clampInteger(segments.length, 0, 0xffff), true);
    workoutOffset += 14;
    firstSegment += segments.length;
  }

  const segmentStart = headerBytes + workoutBytes;
  const typeOffset = segmentStart;
  const startOffset = typeOffset + segmentCount;
  const endOffset = startOffset + segmentCount * 4;
  const durationOffset = endOffset + segmentCount * 4;
  const powerOffset = durationOffset + segmentCount * 4;
  const heartRateOffset = powerOffset + segmentCount * 2;
  const cadenceOffset = heartRateOffset + segmentCount;
  const speedOffset = cadenceOffset + segmentCount;
  const altimetersOffset = speedOffset + segmentCount * 2;

  let segmentIndex = 0;
  for (const workout of normalized) {
    for (const segment of workout.segments || []) {
      view.setUint8(typeOffset + segmentIndex, clampInteger(segment.type, 0, 0xff));
      view.setUint32(startOffset + segmentIndex * 4, clampInteger(segment.start, 0, UINT32_NAN - 1), true);
      view.setUint32(endOffset + segmentIndex * 4, clampInteger(segment.end, 0, UINT32_NAN - 1), true);
      view.setUint32(durationOffset + segmentIndex * 4, clampInteger(segment.duration, 0, UINT32_NAN - 1), true);
      view.setUint16(powerOffset + segmentIndex * 2, clampInteger(segment.avgPower, 0, UINT16_NAN - 1), true);
      view.setUint8(heartRateOffset + segmentIndex, clampInteger(segment.avgHeartRate, 0, UINT8_NAN - 1));
      view.setUint8(cadenceOffset + segmentIndex, clampInteger(segment.avgCadence, 0, UINT8_NAN - 1));
      view.setUint16(speedOffset + segmentIndex * 2, clampInteger(Number(segment.avgSpeed || 0) * 100, 0, UINT16_NAN - 1), true);
      view.setInt32(altimetersOffset + segmentIndex * 4, clampInteger(segment.altimeters, -0x80000000, 0x7fffffff), true);
      segmentIndex += 1;
    }
  }
  return bytes;
}

export function inspectWorkoutLocalPostprocessTransport(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < 24 || String.fromCharCode(...bytes.subarray(0, 4)) !== "WPP1") {
    throw new Error("Invalid WPP1 transport");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    version: view.getUint16(4, true),
    workoutCount: view.getUint32(8, true),
    segmentCount: view.getUint32(12, true),
    byteLength: bytes.byteLength
  };
}

export function decodeWorkoutLocalPostprocessTransport(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const header = inspectWorkoutLocalPostprocessTransport(bytes);
  if (header.version !== 2) throw new Error(`Unsupported WPP1 version: ${header.version}`);

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const workoutStart = view.getUint32(16, true);
  const segmentStart = view.getUint32(20, true);
  const expectedSegmentStart = workoutStart + header.workoutCount * 14;
  const expectedBytes = expectedSegmentStart + header.segmentCount * 23;
  if (workoutStart !== 24 || segmentStart !== expectedSegmentStart || expectedBytes !== bytes.byteLength) {
    throw new Error("Corrupt WPP1 layout");
  }

  const typeOffset = segmentStart;
  const startOffset = typeOffset + header.segmentCount;
  const endOffset = startOffset + header.segmentCount * 4;
  const durationOffset = endOffset + header.segmentCount * 4;
  const powerOffset = durationOffset + header.segmentCount * 4;
  const heartRateOffset = powerOffset + header.segmentCount * 2;
  const cadenceOffset = heartRateOffset + header.segmentCount;
  const speedOffset = cadenceOffset + header.segmentCount;
  const altimetersOffset = speedOffset + header.segmentCount * 2;
  const segments = new Array(header.segmentCount);

  for (let index = 0; index < header.segmentCount; index += 1) {
    segments[index] = {
      type: view.getUint8(typeOffset + index),
      start: view.getUint32(startOffset + index * 4, true),
      end: view.getUint32(endOffset + index * 4, true),
      duration: view.getUint32(durationOffset + index * 4, true),
      avgPower: view.getUint16(powerOffset + index * 2, true),
      avgHeartRate: view.getUint8(heartRateOffset + index),
      avgCadence: view.getUint8(cadenceOffset + index),
      avgSpeed: view.getUint16(speedOffset + index * 2, true) / 100,
      altimeters: view.getInt32(altimetersOffset + index * 4, true)
    };
  }

  const workouts = new Array(header.workoutCount);
  for (let index = 0; index < header.workoutCount; index += 1) {
    const offset = workoutStart + index * 14;
    const firstSegment = view.getUint32(offset + 8, true);
    const segmentCount = view.getUint16(offset + 12, true);
    if (firstSegment + segmentCount > segments.length) throw new Error("Corrupt WPP1 workout segment range");
    workouts[index] = {
      startTimeSec: view.getUint32(offset, true),
      recordCount: view.getUint32(offset + 4, true),
      segments: segments.slice(firstSegment, firstSegment + segmentCount)
    };
  }
  return { ...header, workouts };
}
