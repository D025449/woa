import { scanPowerHistogram } from "./PowerHistogramCodec.js";

export const POWER_DISTRIBUTION_ZONES = Object.freeze([
  Object.freeze({ key: "z1", maxPercent: 55, color: "#94a3b8" }),
  Object.freeze({ key: "z2", maxPercent: 75, color: "#38bdf8" }),
  Object.freeze({ key: "z3", maxPercent: 90, color: "#22c55e" }),
  Object.freeze({ key: "z4", maxPercent: 105, color: "#eab308" }),
  Object.freeze({ key: "z5", maxPercent: 120, color: "#f97316" }),
  Object.freeze({ key: "z6", maxPercent: 150, color: "#ef4444" }),
  Object.freeze({ key: "z7", maxPercent: Infinity, color: "#991b1b" })
]);

const GROUPING_COLUMNS = Object.freeze({
  week: "year_week",
  month: "year_month",
  quarter: "year_quarter",
  year: "year"
});

function emptyZoneSeconds() {
  return Object.fromEntries(POWER_DISTRIBUTION_ZONES.map(({ key }) => [key, 0]));
}

function resolveZoneIndex(watts, ftp) {
  const percentFtp = (watts / ftp) * 100;
  const index = POWER_DISTRIBUTION_ZONES.findIndex(({ maxPercent }) => percentFtp <= maxPercent);
  return index < 0 ? POWER_DISTRIBUTION_ZONES.length - 1 : index;
}

function findLatestFtpSnapshot(snapshots, timestamp, startIndex) {
  let index = startIndex;
  while (index + 1 < snapshots.length && snapshots[index + 1].timestamp <= timestamp) index += 1;
  const snapshot = index >= 0 && snapshots[index]?.timestamp <= timestamp ? snapshots[index] : null;
  return { index, snapshot };
}

export function aggregatePowerDistribution(histogramRows, ftpSnapshots, grouping) {
  const groupingColumn = GROUPING_COLUMNS[grouping];
  if (!groupingColumn) throw new TypeError(`Unsupported power distribution grouping: ${grouping}`);

  const snapshots = (Array.isArray(ftpSnapshots) ? ftpSnapshots : [])
    .map((snapshot) => ({ ...snapshot, timestamp: Date.parse(snapshot.startTime) }))
    .filter((snapshot) => snapshot.ftp > 0 && Number.isFinite(snapshot.timestamp))
    .sort((left, right) => left.timestamp - right.timestamp);
  const rows = (Array.isArray(histogramRows) ? histogramRows : [])
    .map((row) => ({ ...row, timestamp: new Date(row.start_time).getTime() }))
    .filter((row) => Number.isFinite(row.timestamp) && row[groupingColumn] != null)
    .sort((left, right) => left.timestamp - right.timestamp);
  const periods = new Map();
  let snapshotIndex = -1;

  for (const row of rows) {
    const periodKey = String(row[groupingColumn]);
    let period = periods.get(periodKey);
    if (!period) {
      period = {
        period: row[groupingColumn],
        workoutCount: 0,
        classifiedWorkoutCount: 0,
        invalidHistogramCount: 0,
        activeSeconds: 0,
        zeroSeconds: 0,
        missingSeconds: 0,
        unclassifiedSeconds: 0,
        zoneSeconds: emptyZoneSeconds()
      };
      periods.set(periodKey, period);
    }
    period.workoutCount += 1;

    const resolved = findLatestFtpSnapshot(snapshots, row.timestamp, snapshotIndex);
    snapshotIndex = resolved.index;
    const ftp = Number(resolved.snapshot?.ftp);
    const localZoneSeconds = new Float64Array(POWER_DISTRIBUTION_ZONES.length);
    let histogram;
    try {
      histogram = scanPowerHistogram(row.power_histogram, (binIndex, binWidthWatts, seconds) => {
        if (!(ftp > 0)) return;
        const midpointWatts = (binIndex * binWidthWatts) + ((binWidthWatts + 1) / 2);
        localZoneSeconds[resolveZoneIndex(midpointWatts, ftp)] += seconds;
      });
    } catch {
      period.invalidHistogramCount += 1;
      continue;
    }
    if (!histogram) {
      period.invalidHistogramCount += 1;
      continue;
    }

    period.zeroSeconds += histogram.zeroSeconds;
    period.missingSeconds += histogram.missingSeconds;
    if (!(ftp > 0)) {
      period.unclassifiedSeconds += histogram.positiveSeconds;
      continue;
    }

    period.classifiedWorkoutCount += 1;
    period.activeSeconds += histogram.positiveSeconds;
    POWER_DISTRIBUTION_ZONES.forEach(({ key }, index) => {
      period.zoneSeconds[key] += localZoneSeconds[index];
    });
  }

  return [...periods.values()]
    .sort((left, right) => Number(left.period) - Number(right.period))
    .map((period) => ({
      ...period,
      zonePercentages: Object.fromEntries(POWER_DISTRIBUTION_ZONES.map(({ key }) => [
        key,
        period.activeSeconds > 0 ? (period.zoneSeconds[key] / period.activeSeconds) * 100 : 0
      ]))
    }));
}
