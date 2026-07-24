export function resolveCyclingCalories({
  totalCalories,
  avgPower,
  totalTimerTime
} = {}) {
  const recordedCalories = Number(totalCalories);
  if (Number.isFinite(recordedCalories) && recordedCalories > 0) {
    return Math.round(recordedCalories);
  }

  const powerWatts = Number(avgPower);
  const durationSeconds = Number(totalTimerTime);
  if (
    !Number.isFinite(powerWatts)
    || powerWatts <= 0
    || !Number.isFinite(durationSeconds)
    || durationSeconds <= 0
  ) {
    return 0;
  }

  // At typical cycling efficiency, mechanical kJ are approximately metabolic kcal.
  return Math.round((powerWatts * durationSeconds) / 1000);
}

export function calculatePowerLoad({
  normalizedPower,
  totalTimerTime
} = {}) {
  const powerWatts = Number(normalizedPower);
  const durationSeconds = Number(totalTimerTime);
  if (
    !Number.isFinite(powerWatts)
    || powerWatts <= 0
    || !Number.isFinite(durationSeconds)
    || durationSeconds <= 0
  ) {
    return 0;
  }

  const intensity = powerWatts / 200;
  return Math.round(100 * (durationSeconds / 3600) * intensity * intensity);
}

export function calculateNormalizedPowerFromSamples(
  powerSamples,
  { missingValue = null } = {}
) {
  const sampleCount = Number(powerSamples?.length || 0);
  if (sampleCount === 0) {
    return 0;
  }

  const readPower = (index) => {
    const value = Number(powerSamples[index]);
    return Number.isFinite(value) && value >= 0 && value !== missingValue
      ? value
      : 0;
  };
  const fourthPower = (value) => value * value * value * value;

  if (sampleCount < 30) {
    let sumFourth = 0;
    for (let index = 0; index < sampleCount; index += 1) {
      sumFourth += fourthPower(readPower(index));
    }
    return Math.round((sumFourth / sampleCount) ** 0.25);
  }

  let windowSum = 0;
  let rollingCount = 0;
  let sumFourth = 0;

  for (let index = 0; index < sampleCount; index += 1) {
    windowSum += readPower(index);
    if (index >= 30) {
      windowSum -= readPower(index - 30);
    }
    if (index >= 29) {
      sumFourth += fourthPower(windowSum / 30);
      rollingCount += 1;
    }
  }

  return rollingCount > 0
    ? Math.round((sumFourth / rollingCount) ** 0.25)
    : 0;
}
