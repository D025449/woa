import {
  GPS_SEGMENT_ENDPOINT_MAX_DISTANCE_METERS,
  gpsDistanceMeters,
  validatesGpsSegmentRoute
} from "./GpsSegmentRouteValidator.js";

function pointProgress(point, fallbackIndex) {
  if (Number.isFinite(Number(point?.sampleOffset))) return Number(point.sampleOffset);
  if (Number.isFinite(Number(point?.slotIndex))) return Number(point.slotIndex);
  return fallbackIndex;
}

function normalizeTrackSegments(gpsTrack) {
  return (Array.isArray(gpsTrack?.segments) ? gpsTrack.segments : [])
    .map((segment) => segment
      .map((point, index) => ({
        lat: Number(point?.lat),
        lng: Number(point?.lng),
        slotIndex: Number.isFinite(Number(point?.slotIndex)) ? Number(point.slotIndex) : index
      }))
      .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng)))
    .filter((segment) => segment.length >= 2);
}

function findProjectionCandidates(point, trackSegments, maxDistance, startProgress, maxHitCount) {
  const results = [];
  for (let segmentIndex = 0; segmentIndex < trackSegments.length; segmentIndex += 1) {
    const polyline = trackSegments[segmentIndex];
    for (let index = 0; index < polyline.length - 1; index += 1) {
      const left = polyline[index];
      const right = polyline[index + 1];
      const leftProgress = pointProgress(left, index);
      const rightProgress = pointProgress(right, index + 1);
      if (rightProgress < startProgress) continue;
      const deltaLng = right.lng - left.lng;
      const deltaLat = right.lat - left.lat;
      if (deltaLng === 0 && deltaLat === 0) continue;
      const rawInterpolation = (
        ((point.lng - left.lng) * deltaLng) + ((point.lat - left.lat) * deltaLat)
      ) / ((deltaLng * deltaLng) + (deltaLat * deltaLat));
      // Clamp to the finite track edge so turns and track boundaries remain
      // valid proximity candidates.
      const interpolation = Math.max(0, Math.min(1, rawInterpolation));
      const projected = {
        lng: left.lng + interpolation * deltaLng,
        lat: left.lat + interpolation * deltaLat
      };
      const distance = gpsDistanceMeters(point, projected);
      if (distance >= maxDistance) continue;
      results.push({
        segmentIndex,
        index,
        progress: leftProgress + ((rightProgress - leftProgress) * interpolation)
      });
      if (results.length >= maxHitCount) return results;
    }
  }
  return results;
}

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
  const end = Math.min(Number(compactRecords?.recordCount || 0), match.endOffset);
  const count = Math.max(1, end - start);
  for (let index = start; index < end; index += 1) {
    const powerValue = Number(compactRecords?.powersW?.[index]);
    const heartRateValue = Number(compactRecords?.heartRatesBpm?.[index]);
    const cadenceValue = Number(compactRecords?.cadencesRpm?.[index]);
    power += powerValue === 0xffff ? 0 : powerValue;
    heartRate += heartRateValue === 0xff ? 0 : heartRateValue;
    cadence += cadenceValue === 0xff ? 0 : cadenceValue;
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
  const trackSegments = normalizeTrackSegments(gpsTrack);
  const candidates = segmentDefinitions.filter((segment) => boundsOverlap(gpsTrack?.bbox, segment?.bounds));
  if (!trackSegments.length || !candidates.length) return { candidateCount: candidates.length, matches: [] };

  const sampleRate = Math.max(1, Number(gpsTrack?.sampleRateSeconds) || 1);
  const matches = [];
  for (const segment of candidates) {
    const segmentTrack = Array.isArray(segment?.track) ? segment.track : [];
    if (segmentTrack.length < 2) continue;
    const starts = findProjectionCandidates(
      segmentTrack[0],
      trackSegments,
      GPS_SEGMENT_ENDPOINT_MAX_DISTANCE_METERS,
      0,
      100
    );
    let lastEndProgress = -1;
    for (const start of starts) {
      if (start.progress <= lastEndProgress) continue;
      const ends = findProjectionCandidates(
        segmentTrack[segmentTrack.length - 1],
        trackSegments,
        GPS_SEGMENT_ENDPOINT_MAX_DISTANCE_METERS,
        start.progress,
        1
      );
      if (!ends.length || !validatesGpsSegmentRoute(trackSegments, segmentTrack, start, ends[0])) continue;
      const startOffset = Math.floor(start.progress * sampleRate);
      const endOffset = Math.ceil(ends[0].progress * sampleRate);
      if (endOffset <= startOffset) continue;
      matches.push(addAverages(
        { segmentId: Number(segment.id), startOffset, endOffset },
        compactRecords,
        segment.distance
      ));
      lastEndProgress = ends[0].progress;
    }
  }
  return { candidateCount: candidates.length, matches };
}
