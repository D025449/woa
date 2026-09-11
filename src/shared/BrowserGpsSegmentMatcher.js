import {
  toCompactGpsTrack,
  matchCompactGpsSegmentBestEfforts,
  prepareCompactGpsSegmentDefinitions
} from "./CompactGpsSegmentMatcher.js";

function boundsOverlap(left, right) {
  return !!left && !!right
    && left.minLng <= right.maxLng
    && left.maxLng >= right.minLng
    && left.minLat <= right.maxLat
    && left.maxLat >= right.minLat;
}

function addAverages(match, compactRecords, distanceMetersValue) {
  let power = 0;
  let heartRate = 0;
  let cadence = 0;
  const start = Math.max(0, match.startOffset);
  const end = Math.min(Number(compactRecords?.recordCount || 0) - 1, match.endOffset);
  const count = Math.max(1, end - start);
  // Match Workout.getWst9RangeAverages: cumulative difference over (start, end].
  for (let index = start + 1; index <= end; index += 1) {
    const powerValue = Number(compactRecords?.powersW?.[index]);
    const heartRateValue = Number(compactRecords?.heartRatesBpm?.[index]);
    const cadenceValue = Number(compactRecords?.cadencesRpm?.[index]);
    power += !Number.isFinite(powerValue) || powerValue === 0xffff ? 0 : powerValue;
    heartRate += !Number.isFinite(heartRateValue) || heartRateValue === 0xff ? 0 : heartRateValue;
    cadence += !Number.isFinite(cadenceValue) || cadenceValue === 0xff ? 0 : cadenceValue;
  }
  return {
    ...match,
    avgPower: Math.round(power / count),
    avgHeartRate: Math.round(heartRate / count),
    avgCadence: Math.round(cadence / count),
    avgSpeed: Number.isFinite(Number(distanceMetersValue)) && match.endOffset > match.startOffset
      ? Math.round((((Number(distanceMetersValue) * 3.6) / (match.endOffset - match.startOffset)) * 10)) / 10
      : 0
  };
}

export function benchmarkGpsSegmentBestEfforts(gpsTrack, segmentDefinitions = [], compactRecords = null) {
  const candidates = segmentDefinitions.filter((segment) => boundsOverlap(gpsTrack?.bbox, segment?.bounds));
  const result = matchCompactGpsSegmentBestEfforts(
    toCompactGpsTrack(gpsTrack),
    prepareCompactGpsSegmentDefinitions(candidates)
  );
  const distances = new Map(candidates.map((segment) => [Number(segment.id), segment.distance]));
  return {
    candidateCount: candidates.length,
    matches: result.matches.map((match) => addAverages(match, compactRecords, distances.get(match.segmentId)))
  };
}

export const matchGpsSegmentBestEfforts = benchmarkGpsSegmentBestEfforts;
