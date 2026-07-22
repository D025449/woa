import {
  GPS_SEGMENT_ENDPOINT_MAX_DISTANCE_METERS,
  GPS_SEGMENT_ROUTE_MAX_DISTANCE_METERS,
  GPS_SEGMENT_ROUTE_REQUIRED_MATCHES,
  GPS_SEGMENT_ROUTE_SAMPLE_COUNT
} from "./GpsSegmentRouteValidator.js";

const E5_SCALE = 100000;
const DEG_TO_RAD = Math.PI / 180;
const METERS_PER_E5_LAT = 111195 / E5_SCALE;

function toE5(value) {
  return Math.round(Number(value) * E5_SCALE);
}

function getRouteSampleIndices(pointCount, sampleCount = GPS_SEGMENT_ROUTE_SAMPLE_COUNT) {
  const indices = [];
  let previousIndex = -1;
  for (let sample = 1; sample <= sampleCount; sample += 1) {
    const index = Math.round(((pointCount - 1) * sample) / (sampleCount + 1));
    if (index <= 0 || index >= pointCount - 1 || index === previousIndex) continue;
    indices.push(index);
    previousIndex = index;
  }
  return indices;
}

export function prepareCompactGpsSegmentDefinitions(segmentDefinitions = []) {
  return (Array.isArray(segmentDefinitions) ? segmentDefinitions : [])
    .map((segment) => {
      const track = Array.isArray(segment?.track) ? segment.track : [];
      if (track.length < 2) return null;
      const latitudesE5 = new Int32Array(track.length);
      const longitudesE5 = new Int32Array(track.length);
      let latitudeSumE5 = 0;
      for (let index = 0; index < track.length; index += 1) {
        latitudesE5[index] = toE5(track[index]?.lat);
        longitudesE5[index] = toE5(track[index]?.lng);
        latitudeSumE5 += latitudesE5[index];
      }
      const referenceLatitude = (latitudeSumE5 / track.length / E5_SCALE) * DEG_TO_RAD;
      return {
        id: Number(segment.id),
        latitudesE5,
        longitudesE5,
        metersPerE5Lng: Math.max(0.01, Math.cos(referenceLatitude) * METERS_PER_E5_LAT),
        routeSampleIndices: getRouteSampleIndices(track.length)
      };
    })
    .filter(Boolean);
}

function pointToEdgeDistanceSquared(
  pointLatE5,
  pointLngE5,
  leftLatE5,
  leftLngE5,
  rightLatE5,
  rightLngE5,
  metersPerE5Lng
) {
  const deltaLng = rightLngE5 - leftLngE5;
  const deltaLat = rightLatE5 - leftLatE5;
  if (deltaLng === 0 && deltaLat === 0) {
    const x = (pointLngE5 - leftLngE5) * metersPerE5Lng;
    const y = (pointLatE5 - leftLatE5) * METERS_PER_E5_LAT;
    return (x * x) + (y * y);
  }

  const rawInterpolation = (
    ((pointLngE5 - leftLngE5) * deltaLng)
    + ((pointLatE5 - leftLatE5) * deltaLat)
  ) / ((deltaLng * deltaLng) + (deltaLat * deltaLat));
  const interpolation = Math.max(0, Math.min(1, rawInterpolation));
  const projectedLngE5 = leftLngE5 + (interpolation * deltaLng);
  const projectedLatE5 = leftLatE5 + (interpolation * deltaLat);
  const x = (pointLngE5 - projectedLngE5) * metersPerE5Lng;
  const y = (pointLatE5 - projectedLatE5) * METERS_PER_E5_LAT;
  return (x * x) + (y * y);
}

function findProjectionCandidates(
  pointLatE5,
  pointLngE5,
  track,
  maxDistanceMeters,
  startProgress,
  maxHitCount,
  metersPerE5Lng
) {
  const results = [];
  const maxDistanceSquared = maxDistanceMeters * maxDistanceMeters;
  const latitudeRadiusE5 = maxDistanceMeters / METERS_PER_E5_LAT;
  const longitudeRadiusE5 = maxDistanceMeters / metersPerE5Lng;
  let segmentIndex = 0;

  for (let index = 0; index < track.latitudesE5.length - 1; index += 1) {
    const leftProgress = Number(track.slotIndices[index]);
    const rightProgress = Number(track.slotIndices[index + 1]);
    if (rightProgress !== leftProgress + 1) {
      segmentIndex += 1;
      continue;
    }
    if (rightProgress < startProgress) continue;

    const leftLatE5 = track.latitudesE5[index];
    const leftLngE5 = track.longitudesE5[index];
    const rightLatE5 = track.latitudesE5[index + 1];
    const rightLngE5 = track.longitudesE5[index + 1];
    if (pointLatE5 < Math.min(leftLatE5, rightLatE5) - latitudeRadiusE5
      || pointLatE5 > Math.max(leftLatE5, rightLatE5) + latitudeRadiusE5
      || pointLngE5 < Math.min(leftLngE5, rightLngE5) - longitudeRadiusE5
      || pointLngE5 > Math.max(leftLngE5, rightLngE5) + longitudeRadiusE5) {
      continue;
    }

    const deltaLng = rightLngE5 - leftLngE5;
    const deltaLat = rightLatE5 - leftLatE5;
    if (deltaLng === 0 && deltaLat === 0) continue;
    const rawInterpolation = (
      ((pointLngE5 - leftLngE5) * deltaLng)
      + ((pointLatE5 - leftLatE5) * deltaLat)
    ) / ((deltaLng * deltaLng) + (deltaLat * deltaLat));
    const interpolation = Math.max(0, Math.min(1, rawInterpolation));
    const distanceSquared = pointToEdgeDistanceSquared(
      pointLatE5,
      pointLngE5,
      leftLatE5,
      leftLngE5,
      rightLatE5,
      rightLngE5,
      metersPerE5Lng
    );
    if (distanceSquared >= maxDistanceSquared) continue;

    results.push({
      segmentIndex,
      index,
      progress: leftProgress + ((rightProgress - leftProgress) * interpolation)
    });
    if (results.length >= maxHitCount) return results;
  }
  return results;
}

function validatesRoute(track, segment, start, end) {
  if (start.segmentIndex !== end.segmentIndex || end.index < start.index) return false;
  if (segment.routeSampleIndices.length === 0) return true;

  const maxDistanceSquared = GPS_SEGMENT_ROUTE_MAX_DISTANCE_METERS
    * GPS_SEGMENT_ROUTE_MAX_DISTANCE_METERS;
  const requiredMatches = Math.min(
    segment.routeSampleIndices.length,
    GPS_SEGMENT_ROUTE_REQUIRED_MATCHES
  );
  let matched = 0;

  for (let sampleIndex = 0; sampleIndex < segment.routeSampleIndices.length; sampleIndex += 1) {
    const routeIndex = segment.routeSampleIndices[sampleIndex];
    const pointLatE5 = segment.latitudesE5[routeIndex];
    const pointLngE5 = segment.longitudesE5[routeIndex];
    let found = false;
    for (let index = start.index; index <= end.index && index < track.latitudesE5.length - 1; index += 1) {
      if (track.slotIndices[index + 1] !== track.slotIndices[index] + 1) break;
      if (pointToEdgeDistanceSquared(
        pointLatE5,
        pointLngE5,
        track.latitudesE5[index],
        track.longitudesE5[index],
        track.latitudesE5[index + 1],
        track.longitudesE5[index + 1],
        segment.metersPerE5Lng
      ) < maxDistanceSquared) {
        found = true;
        break;
      }
    }
    if (found) matched += 1;
    const remaining = segment.routeSampleIndices.length - sampleIndex - 1;
    if (matched + remaining < requiredMatches) return false;
  }
  return matched >= requiredMatches;
}

export function matchCompactGpsSegmentBestEfforts(compactTrack, preparedSegments = []) {
  const latitudesE5 = compactTrack?.latitudesE5;
  const longitudesE5 = compactTrack?.longitudesE5;
  const slotIndices = compactTrack?.slotIndices;
  if (!(latitudesE5 instanceof Int32Array)
    || !(longitudesE5 instanceof Int32Array)
    || !(slotIndices instanceof Uint32Array)
    || latitudesE5.length < 2
    || latitudesE5.length !== longitudesE5.length
    || latitudesE5.length !== slotIndices.length) {
    return { candidateCount: 0, matches: [] };
  }

  const sampleRate = Math.max(1, Number(compactTrack.sampleRateGps) || 1);
  const track = { latitudesE5, longitudesE5, slotIndices };
  const matches = [];
  for (const segment of preparedSegments) {
    const starts = findProjectionCandidates(
      segment.latitudesE5[0],
      segment.longitudesE5[0],
      track,
      GPS_SEGMENT_ENDPOINT_MAX_DISTANCE_METERS,
      0,
      100,
      segment.metersPerE5Lng
    );
    let lastEndProgress = -1;
    for (const start of starts) {
      if (start.progress <= lastEndProgress) continue;
      const lastIndex = segment.latitudesE5.length - 1;
      const ends = findProjectionCandidates(
        segment.latitudesE5[lastIndex],
        segment.longitudesE5[lastIndex],
        track,
        GPS_SEGMENT_ENDPOINT_MAX_DISTANCE_METERS,
        start.progress,
        1,
        segment.metersPerE5Lng
      );
      if (!ends.length || !validatesRoute(track, segment, start, ends[0])) continue;
      const startOffset = Math.floor(start.progress * sampleRate);
      const endOffset = Math.ceil(ends[0].progress * sampleRate);
      if (endOffset <= startOffset) continue;
      matches.push({ segmentId: segment.id, startOffset, endOffset });
      lastEndProgress = ends[0].progress;
    }
  }
  return { candidateCount: preparedSegments.length, matches };
}
