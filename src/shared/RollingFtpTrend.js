const FTP_EFFORT_DURATIONS = Object.freeze([360, 480, 720, 900, 960]);
const FTP_DURATION_WEIGHTS = Object.freeze({
  360: 0.5,
  480: 0.75,
  720: 1,
  900: 1.2,
  960: 1.25
});
const DEFAULT_WINDOW_DAYS = 84;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

function percentile(values, quantile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const position = Math.max(0, Math.min(1, quantile)) * (sorted.length - 1);
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  if (lowerIndex === upperIndex) return sorted[lowerIndex];
  const ratio = position - lowerIndex;
  return sorted[lowerIndex] + ((sorted[upperIndex] - sorted[lowerIndex]) * ratio);
}

function estimateLegacyFtp(cp8, cp15) {
  if (!(cp8 > 0) || !(cp15 > 0)) return null;
  const extrapolation = (Math.log(1200) - Math.log(480)) / (Math.log(900) - Math.log(480));
  return (cp8 + (extrapolation * (cp15 - cp8))) * 0.95;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function fitWeightedLogCurve(points, robustWeights = null) {
  let weightSum = 0;
  let weightedX = 0;
  let weightedY = 0;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const weight = point.weight * (robustWeights?.[index] ?? 1);
    weightSum += weight;
    weightedX += weight * point.x;
    weightedY += weight * point.power;
  }
  if (!(weightSum > 0)) return null;

  const meanX = weightedX / weightSum;
  const meanY = weightedY / weightSum;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const weight = point.weight * (robustWeights?.[index] ?? 1);
    numerator += weight * (point.x - meanX) * (point.power - meanY);
    denominator += weight * (point.x - meanX) ** 2;
  }
  if (!(denominator > 0)) return null;

  const slope = Math.min(0, numerator / denominator);
  return {
    slope,
    intercept: meanY - (slope * meanX)
  };
}

function fitTheilSenLogCurve(points) {
  const slopes = [];
  for (let leftIndex = 0; leftIndex < points.length - 1; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < points.length; rightIndex += 1) {
      const deltaX = points[rightIndex].x - points[leftIndex].x;
      if (deltaX !== 0) {
        slopes.push((points[rightIndex].power - points[leftIndex].power) / deltaX);
      }
    }
  }
  if (slopes.length === 0) return null;
  const slope = Math.min(0, median(slopes));
  const intercept = median(points.map((point) => point.power - (slope * point.x)));
  return Number.isFinite(intercept) ? { slope, intercept } : null;
}

function estimateFtp(durationPowers) {
  const points = FTP_EFFORT_DURATIONS
    .map((duration) => ({
      duration,
      x: Math.log(duration),
      power: Number(durationPowers.get(duration)),
      weight: FTP_DURATION_WEIGHTS[duration]
    }))
    .filter((point) => point.power > 0);
  const hasShortAnchor = points.some((point) => point.duration <= 480);
  const hasLongAnchor = points.some((point) => point.duration >= 900);

  if (points.length >= 3 && hasShortAnchor && hasLongAnchor) {
    let curve = fitTheilSenLogCurve(points);
    for (let iteration = 0; curve && iteration < 2; iteration += 1) {
      const residuals = points.map((point) => point.power - (curve.intercept + (curve.slope * point.x)));
      const residualMedian = median(residuals) || 0;
      const medianAbsoluteDeviation = median(residuals.map((value) => Math.abs(value - residualMedian))) || 0;
      const threshold = Math.max(2, 1.5 * 1.4826 * medianAbsoluteDeviation);
      const robustWeights = residuals.map((value) => {
        const absoluteResidual = Math.abs(value - residualMedian);
        return absoluteResidual <= threshold ? 1 : threshold / absoluteResidual;
      });
      curve = fitWeightedLogCurve(points, robustWeights);
    }
    if (curve) {
      const cp20 = curve.intercept + (curve.slope * Math.log(1200));
      if (cp20 > 0) return { ftp: cp20 * 0.95, pointCount: points.length };
    }
  }

  const legacyFtp = estimateLegacyFtp(durationPowers.get(480), durationPowers.get(900));
  return legacyFtp > 0 ? { ftp: legacyFtp, pointCount: 2 } : null;
}

function normalizeEfforts(rows) {
  const workouts = new Map();

  for (const row of Array.isArray(rows) ? rows : []) {
    const workoutId = Number(row.workout_id);
    const duration = Number(row.duration);
    const power = Number(row.avg_power);
    const timestamp = new Date(row.start_time).getTime();
    if (!Number.isInteger(workoutId)
      || !FTP_EFFORT_DURATIONS.includes(duration)
      || !Number.isFinite(power)
      || power <= 0
      || !Number.isFinite(timestamp)) {
      continue;
    }

    let workout = workouts.get(workoutId);
    if (!workout) {
      workout = {
        workoutId,
        timestamp,
        startTime: new Date(timestamp).toISOString(),
        periods: {
          week: row.year_week,
          month: row.year_month,
          quarter: row.year_quarter,
          year: row.year
        },
        powers: new Map()
      };
      workouts.set(workoutId, workout);
    }

    workout.powers.set(duration, Math.max(power, workout.powers.get(duration) || 0));
  }

  return [...workouts.values()].sort((left, right) => {
    const timeDifference = left.timestamp - right.timestamp;
    return timeDifference !== 0 ? timeDifference : left.workoutId - right.workoutId;
  });
}

export function buildRollingFtpSnapshots(rows, options = {}) {
  const workouts = normalizeEfforts(rows);
  const windowDays = Math.max(1, Number(options.windowDays) || DEFAULT_WINDOW_DAYS);
  const windowMilliseconds = windowDays * MILLISECONDS_PER_DAY;
  const quantile = Number.isFinite(Number(options.quantile)) ? Number(options.quantile) : 0.95;
  const activeEfforts = new Map(FTP_EFFORT_DURATIONS.map((duration) => [duration, []]));
  const firstActiveIndexes = new Map(FTP_EFFORT_DURATIONS.map((duration) => [duration, 0]));
  const snapshots = [];

  for (const workout of workouts) {
    for (const duration of FTP_EFFORT_DURATIONS) {
      const power = workout.powers.get(duration);
      if (power > 0) activeEfforts.get(duration).push({ timestamp: workout.timestamp, power });

      const efforts = activeEfforts.get(duration);
      let firstActiveIndex = firstActiveIndexes.get(duration);
      const minimumTimestamp = workout.timestamp - windowMilliseconds;
      while (firstActiveIndex < efforts.length && efforts[firstActiveIndex].timestamp < minimumTimestamp) {
        firstActiveIndex += 1;
      }
      firstActiveIndexes.set(duration, firstActiveIndex);
    }

    const valuesFor = (duration) => activeEfforts
      .get(duration)
      .slice(firstActiveIndexes.get(duration))
      .map((effort) => effort.power);
    const activeValues = new Map(FTP_EFFORT_DURATIONS.map((duration) => [duration, valuesFor(duration)]));
    const durationPowers = new Map(FTP_EFFORT_DURATIONS.map((duration) => [
      duration,
      percentile(activeValues.get(duration), quantile)
    ]));
    const estimate = estimateFtp(durationPowers);
    if (!(estimate?.ftp > 0)) continue;
    const usedDurations = estimate.pointCount > 2
      ? FTP_EFFORT_DURATIONS.filter((duration) => durationPowers.get(duration) > 0)
      : [480, 900];

    snapshots.push({
      workoutId: workout.workoutId,
      startTime: workout.startTime,
      periods: workout.periods,
      cp8: durationPowers.get(480),
      cp15: durationPowers.get(900),
      ftp: estimate.ftp,
      modelPointCount: estimate.pointCount,
      confidence: Math.min(...usedDurations.map((duration) => activeValues.get(duration).length))
    });
  }

  return snapshots;
}

export function groupRollingFtpSnapshots(snapshots, grouping) {
  if (!["week", "month", "quarter", "year"].includes(grouping)) {
    throw new TypeError(`Unsupported FTP grouping: ${grouping}`);
  }

  const grouped = new Map();
  for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
    const period = snapshot.periods?.[grouping];
    if (period == null || !(snapshot.ftp > 0)) continue;
    const current = grouped.get(String(period));
    if (!current || snapshot.ftp > current.ftp) {
      grouped.set(String(period), { ...snapshot, period });
    }
  }

  return [...grouped.values()].sort((left, right) => Number(left.period) - Number(right.period));
}

export function buildRollingFtpTrend(rows, grouping, options = {}) {
  return groupRollingFtpSnapshots(buildRollingFtpSnapshots(rows, options), grouping);
}
