// Reduced GPS tracks are sampled every five seconds and can carry additional
// local GPS drift, so endpoints use the same tolerance as route samples.
export const GPS_SEGMENT_ENDPOINT_MAX_DISTANCE_METERS = 50;
export const GPS_SEGMENT_ROUTE_MAX_DISTANCE_METERS = 50;
export const GPS_SEGMENT_ROUTE_SAMPLE_COUNT = 6;
export const GPS_SEGMENT_ROUTE_REQUIRED_MATCHES = 4;

const EARTH_RADIUS_METERS = 6371000;
const DEG_TO_RAD = Math.PI / 180;

export function gpsDistanceMeters(left, right) {
  const lat1 = Number(left.lat) * DEG_TO_RAD;
  const lat2 = Number(right.lat) * DEG_TO_RAD;
  const deltaLat = (Number(right.lat) - Number(left.lat)) * DEG_TO_RAD;
  const deltaLng = (Number(right.lng) - Number(left.lng)) * DEG_TO_RAD;
  const sinLat = Math.sin(deltaLat / 2);
  const sinLng = Math.sin(deltaLng / 2);
  const a = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(a));
}

export function gpsPointToLineDistance(point, left, right) {
  const deltaLng = right.lng - left.lng;
  const deltaLat = right.lat - left.lat;
  if (deltaLng === 0 && deltaLat === 0) return gpsDistanceMeters(point, left);

  const raw = (
    ((point.lng - left.lng) * deltaLng) + ((point.lat - left.lat) * deltaLat)
  ) / ((deltaLng * deltaLng) + (deltaLat * deltaLat));
  const interpolation = Math.max(0, Math.min(1, raw));
  return gpsDistanceMeters(point, {
    lng: left.lng + interpolation * deltaLng,
    lat: left.lat + interpolation * deltaLat
  });
}

export function getGpsSegmentRouteSamples(segmentTrack, sampleCount = GPS_SEGMENT_ROUTE_SAMPLE_COUNT) {
  if (!Array.isArray(segmentTrack) || segmentTrack.length < 2 || sampleCount <= 0) return [];

  const samples = [];
  let previousIndex = -1;
  for (let sample = 1; sample <= sampleCount; sample += 1) {
    const index = Math.round(((segmentTrack.length - 1) * sample) / (sampleCount + 1));
    if (index <= 0 || index >= segmentTrack.length - 1 || index === previousIndex) continue;
    samples.push(segmentTrack[index]);
    previousIndex = index;
  }
  return samples;
}

export function validatesGpsSegmentRoute(trackSegments, segmentTrack, start, end, options = {}) {
  if (!Array.isArray(trackSegments) || start?.segmentIndex !== end?.segmentIndex || end?.index < start?.index) {
    return false;
  }

  const workoutTrack = trackSegments[start.segmentIndex];
  if (!Array.isArray(workoutTrack) || workoutTrack.length < 2) return false;

  const samples = getGpsSegmentRouteSamples(segmentTrack, options.sampleCount);
  // A two-point segment has no independent interior geometry to validate;
  // its start and end have already passed the strict endpoint checks.
  if (!samples.length) return true;

  const maxDistance = Number(options.maxDistance) || GPS_SEGMENT_ROUTE_MAX_DISTANCE_METERS;
  const requiredMatches = Math.min(
    samples.length,
    Math.max(1, Number(options.requiredMatches) || GPS_SEGMENT_ROUTE_REQUIRED_MATCHES)
  );
  let matched = 0;

  for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex += 1) {
    const point = samples[sampleIndex];
    let found = false;
    for (let index = start.index; index <= end.index; index += 1) {
      const rightIndex = Math.min(index + 1, workoutTrack.length - 1);
      if (gpsPointToLineDistance(point, workoutTrack[index], workoutTrack[rightIndex]) < maxDistance) {
        found = true;
        break;
      }
    }
    if (found) matched += 1;

    const remaining = samples.length - sampleIndex - 1;
    if (matched + remaining < requiredMatches) return false;
  }

  return matched >= requiredMatches;
}
