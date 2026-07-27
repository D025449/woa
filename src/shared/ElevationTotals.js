const EARTH_RADIUS_METERS = 6_371_000;
const DEFAULT_RESAMPLE_STEP_METERS = 25;
const DEFAULT_SMOOTHING_RADIUS_METERS = 300;

function haversineMeters(a, b) {
  const toRadians = (value) => (value * Math.PI) / 180;
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const value = sinLat * sinLat
    + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;

  return 2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function buildElevationDistanceAxis(track) {
  const points = [];
  let distanceMeters = 0;
  let previousPoint = null;

  for (const point of track || []) {
    const lat = Number(point?.lat);
    const lng = Number(point?.lng);
    const elevation = Number(point?.ele);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(elevation)) {
      continue;
    }

    const normalizedPoint = { lat, lng };
    if (previousPoint) {
      distanceMeters += haversineMeters(previousPoint, normalizedPoint);
    }

    if (points.length > 0 && distanceMeters <= points[points.length - 1].distanceMeters) {
      points[points.length - 1].elevation = elevation;
    } else {
      points.push({ distanceMeters, elevation });
    }
    previousPoint = normalizedPoint;
  }

  return points;
}

function resampleElevations(points, stepMeters) {
  if (points.length < 2) {
    return points.map((point) => point.elevation);
  }

  const totalDistanceMeters = points[points.length - 1].distanceMeters;
  const elevations = [];
  let upperIndex = 1;

  const appendAtDistance = (distanceMeters) => {
    while (
      upperIndex < points.length - 1
      && points[upperIndex].distanceMeters < distanceMeters
    ) {
      upperIndex += 1;
    }

    const lower = points[Math.max(0, upperIndex - 1)];
    const upper = points[upperIndex];
    const spanMeters = upper.distanceMeters - lower.distanceMeters;
    const ratio = spanMeters > 0
      ? (distanceMeters - lower.distanceMeters) / spanMeters
      : 0;
    elevations.push(lower.elevation + (upper.elevation - lower.elevation) * ratio);
  };

  for (let distanceMeters = 0; distanceMeters < totalDistanceMeters; distanceMeters += stepMeters) {
    appendAtDistance(distanceMeters);
  }
  appendAtDistance(totalDistanceMeters);

  return elevations;
}

function smoothCentered(values, radiusSamples) {
  const prefix = new Float64Array(values.length + 1);
  for (let index = 0; index < values.length; index += 1) {
    prefix[index + 1] = prefix[index] + values[index];
  }

  const smoothed = new Float64Array(values.length);
  for (let index = 0; index < values.length; index += 1) {
    const start = Math.max(0, index - radiusSamples);
    const end = Math.min(values.length - 1, index + radiusSamples);
    smoothed[index] = (prefix[end + 1] - prefix[start]) / (end - start + 1);
  }

  // Keep the real net elevation change while retaining the low-pass shape.
  const startCorrection = values[0] - smoothed[0];
  const endCorrection = values[values.length - 1] - smoothed[smoothed.length - 1];
  const denominator = Math.max(1, smoothed.length - 1);
  for (let index = 0; index < smoothed.length; index += 1) {
    const progress = index / denominator;
    smoothed[index] += startCorrection + (endCorrection - startCorrection) * progress;
  }

  return smoothed;
}

export function computeElevationTotalsFromTrack(track, options = {}) {
  const stepMeters = Math.max(
    1,
    Number(options.resampleStepMeters) || DEFAULT_RESAMPLE_STEP_METERS
  );
  const smoothingRadiusMeters = Math.max(
    stepMeters,
    Number(options.smoothingRadiusMeters) || DEFAULT_SMOOTHING_RADIUS_METERS
  );
  const points = buildElevationDistanceAxis(track);
  if (points.length < 2) {
    return { totalAscent: 0, totalDescent: 0 };
  }

  const elevations = resampleElevations(points, stepMeters);
  const radiusSamples = Math.max(1, Math.round(smoothingRadiusMeters / stepMeters));
  const smoothed = smoothCentered(elevations, radiusSamples);
  let totalAscent = 0;
  let totalDescent = 0;

  for (let index = 1; index < smoothed.length; index += 1) {
    const delta = smoothed[index] - smoothed[index - 1];
    if (delta > 0) {
      totalAscent += delta;
    } else {
      totalDescent -= delta;
    }
  }

  return {
    totalAscent: Math.round(totalAscent),
    totalDescent: Math.round(totalDescent)
  };
}
