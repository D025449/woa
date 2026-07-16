const EARTH_RADIUS_METERS = 6371000;
const DEG_TO_RAD = Math.PI / 180;

function pointProgress(point, fallbackIndex) {
  if (Number.isFinite(Number(point?.sampleOffset))) return Number(point.sampleOffset);
  if (Number.isFinite(Number(point?.slotIndex))) return Number(point.slotIndex);
  return fallbackIndex;
}

function distanceMeters(left, right) {
  const lat1 = Number(left.lat) * DEG_TO_RAD;
  const lat2 = Number(right.lat) * DEG_TO_RAD;
  const deltaLat = (Number(right.lat) - Number(left.lat)) * DEG_TO_RAD;
  const deltaLng = (Number(right.lng) - Number(left.lng)) * DEG_TO_RAD;
  const sinLat = Math.sin(deltaLat / 2);
  const sinLng = Math.sin(deltaLng / 2);
  const a = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(a));
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
      const interpolation = (
        ((point.lng - left.lng) * deltaLng) + ((point.lat - left.lat) * deltaLat)
      ) / ((deltaLng * deltaLng) + (deltaLat * deltaLat));
      if (interpolation < 0 || interpolation > 1) continue;
      const projected = {
        lng: left.lng + interpolation * deltaLng,
        lat: left.lat + interpolation * deltaLat
      };
      const distance = distanceMeters(point, projected);
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

function pointToLineDistance(point, left, right) {
  const deltaLng = right.lng - left.lng;
  const deltaLat = right.lat - left.lat;
  if (deltaLng === 0 && deltaLat === 0) return distanceMeters(point, left);
  const raw = (
    ((point.lng - left.lng) * deltaLng) + ((point.lat - left.lat) * deltaLat)
  ) / ((deltaLng * deltaLng) + (deltaLat * deltaLat));
  const interpolation = Math.max(0, Math.min(1, raw));
  return distanceMeters(point, {
    lng: left.lng + interpolation * deltaLng,
    lat: left.lat + interpolation * deltaLat
  });
}

function validatesRoute(trackSegments, segmentTrack, start, end, maxDistance) {
  if (start.segmentIndex !== end.segmentIndex || end.index < start.index) return false;
  const workoutTrack = trackSegments[start.segmentIndex];
  const checks = [0.25, 0.5, 0.75].map((ratio) => segmentTrack[Math.floor(segmentTrack.length * ratio)]);
  return checks.every((point) => {
    for (let index = start.index; index <= end.index; index += 1) {
      if (pointToLineDistance(point, workoutTrack[index], workoutTrack[Math.min(index + 1, workoutTrack.length - 1)]) < maxDistance) {
        return true;
      }
    }
    return false;
  });
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
    const starts = findProjectionCandidates(segmentTrack[0], trackSegments, 20, 0, 100);
    let lastEndProgress = -1;
    for (const start of starts) {
      if (start.progress <= lastEndProgress) continue;
      const ends = findProjectionCandidates(segmentTrack[segmentTrack.length - 1], trackSegments, 20, start.progress, 1);
      if (!ends.length || !validatesRoute(trackSegments, segmentTrack, start, ends[0], 20)) continue;
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
