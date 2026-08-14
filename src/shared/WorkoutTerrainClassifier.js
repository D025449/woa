export const TERRAIN_PROFILES = Object.freeze([
  "flat",
  "rolling",
  "mountainous",
  "altitude_missing",
  "altitude_invalid"
]);

function movingAverage(values, radius) {
  const prefix = new Float64Array(values.length + 1);
  for (let index = 0; index < values.length; index += 1) {
    prefix[index + 1] = prefix[index] + values[index];
  }

  const result = new Float32Array(values.length);
  for (let index = 0; index < values.length; index += 1) {
    const start = Math.max(0, index - radius);
    const end = Math.min(values.length - 1, index + radius);
    result[index] = (prefix[end + 1] - prefix[start]) / (end - start + 1);
  }
  return result;
}

function mergeClimbingGaps(mask, altitude, maxGapSeconds, maxLossMeters) {
  let previous = -1;
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index]) continue;
    if (
      previous >= 0
      && index - previous - 1 <= maxGapSeconds
      && altitude[previous] - altitude[index] <= maxLossMeters
    ) {
      mask.fill(1, previous + 1, index);
    }
    previous = index;
  }
}

function collectClimbs(mask, altitude, distance, halfWindow, minimums) {
  const climbs = [];
  let start = -1;
  for (let index = 0; index <= mask.length; index += 1) {
    const active = index < mask.length && mask[index];
    if (active && start < 0) start = index;
    if (active || start < 0) continue;

    const end = index - 1;
    const from = Math.max(0, start - halfWindow);
    const to = Math.min(mask.length - 1, end + halfWindow);
    const duration = to - from + 1;
    const meters = distance[to] - distance[from];
    const gain = altitude[to] - altitude[from];
    const grade = meters > 0 ? gain / meters : 0;
    if (
      duration >= minimums.duration
      && gain >= minimums.gain
      && meters >= minimums.distance
      && grade >= minimums.grade
    ) {
      climbs.push({ from, to, duration, meters, gain, grade });
    }
    start = -1;
  }
  return climbs;
}

function normalizeSeries({
  altitudes = null,
  distances = null,
  altitudeMissingValue = null,
  distanceMissingValue = null,
  altitudeScale = 1,
  distanceScale = 1
}) {
  const length = Math.min(Number(altitudes?.length || 0), Number(distances?.length || 0));
  if (length < 30) return null;

  const altitude = new Float32Array(length);
  const distance = new Float32Array(length);
  let validAltitudeCount = 0;
  let previousAltitude = null;
  let firstValidAltitude = null;
  let firstValidAltitudeIndex = -1;
  let largestJump = 0;
  let lastDistance = 0;

  for (let index = 0; index < length; index += 1) {
    const rawAltitude = Number(altitudes[index]);
    const altitudeValid = Number.isFinite(rawAltitude) && rawAltitude !== altitudeMissingValue;
    if (altitudeValid) {
      altitude[index] = rawAltitude * altitudeScale;
      validAltitudeCount += 1;
      if (firstValidAltitudeIndex < 0) {
        firstValidAltitude = altitude[index];
        firstValidAltitudeIndex = index;
      }
      if (previousAltitude != null) {
        largestJump = Math.max(largestJump, Math.abs(rawAltitude * altitudeScale - previousAltitude));
      }
      previousAltitude = rawAltitude * altitudeScale;
    } else {
      altitude[index] = index > 0 ? altitude[index - 1] : 0;
      previousAltitude = null;
    }

    const rawDistance = Number(distances[index]);
    if (Number.isFinite(rawDistance) && rawDistance !== distanceMissingValue) {
      lastDistance = Math.max(lastDistance, rawDistance * distanceScale);
    }
    distance[index] = lastDistance;
  }

  if (validAltitudeCount < length * 0.8) return null;
  if (firstValidAltitudeIndex > 0) altitude.fill(firstValidAltitude, 0, firstValidAltitudeIndex);
  return { altitude, distance, largestJump };
}

export function classifyTerrainProfile(input = {}) {
  const normalized = normalizeSeries(input);
  if (!normalized) return "altitude_missing";

  const { altitude, distance, largestJump } = normalized;
  if (largestJump >= 25) return "altitude_invalid";

  const shortScale = movingAverage(altitude, 15);
  const longScale = movingAverage(shortScale, 60);
  const shortMask = new Uint8Array(altitude.length);
  const shortHalfWindow = 15;
  for (let index = shortHalfWindow; index < altitude.length - shortHalfWindow; index += 1) {
    const gain = shortScale[index + shortHalfWindow] - shortScale[index - shortHalfWindow];
    const traveled = distance[index + shortHalfWindow] - distance[index - shortHalfWindow];
    if (gain >= 2.5 && traveled >= 30 && gain / traveled >= 0.0125) shortMask[index] = 1;
  }
  mergeClimbingGaps(shortMask, shortScale, 60, 12);
  const shortClimbs = collectClimbs(shortMask, shortScale, distance, shortHalfWindow, {
    duration: 30,
    gain: 10,
    distance: 50,
    grade: 0.0125
  });

  const broadMask = new Uint8Array(altitude.length);
  const broadHalfWindow = 60;
  for (let index = broadHalfWindow; index < altitude.length - broadHalfWindow; index += 1) {
    const gain = longScale[index + broadHalfWindow] - longScale[index - broadHalfWindow];
    const traveled = distance[index + broadHalfWindow] - distance[index - broadHalfWindow];
    if (gain >= 5 && traveled >= 100 && gain / traveled >= 0.01) broadMask[index] = 1;
  }
  mergeClimbingGaps(broadMask, longScale, 180, 25);
  const broadClimbs = collectClimbs(broadMask, longScale, distance, broadHalfWindow, {
    duration: 180,
    gain: 25,
    distance: 200,
    grade: 0.01
  });

  let concentratedShift = false;
  const usableBroadClimbs = broadClimbs.filter((broad) => {
    const core = shortClimbs.filter((short) => short.to >= broad.from && short.from <= broad.to);
    const coreGain = core.reduce((sum, climb) => sum + climb.gain, 0);
    const coreMeters = core.reduce((sum, climb) => sum + climb.meters, 0);
    const effectiveGrade = coreMeters > 0 ? coreGain / coreMeters : broad.grade;
    const concentrated = shortClimbs.some((short) => (
      short.from >= broad.from
      && short.to <= broad.to
      && short.duration < broad.duration * 0.5
      && short.gain >= broad.gain * 0.8
      && short.gain / short.duration >= 0.6
    ));
    concentratedShift ||= concentrated;
    return !concentrated && effectiveGrade >= 0.02;
  });

  if (concentratedShift) return "altitude_invalid";
  const majorClimbs = usableBroadClimbs.filter((climb) => climb.duration >= 600 && climb.gain >= 50);
  const mediumClimbs = usableBroadClimbs.filter((climb) => climb.duration >= 300 && climb.gain >= 25);
  if (majorClimbs.length >= 1 || mediumClimbs.length >= 2) return "mountainous";

  const shortWaves = shortClimbs.filter((climb) => (
    climb.duration >= 30
    && climb.duration < 300
    && climb.gain >= 10
    && climb.grade >= 0.02
  ));
  return shortWaves.length >= 4 ? "rolling" : "flat";
}
