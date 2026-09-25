const EARTH_RADIUS_METERS = 6371000;
const DEGREES_TO_RADIANS = Math.PI / 180;

function distance(left, right) {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

function interpolate(left, right, ratio) {
  return {
    x: left.x + ((right.x - left.x) * ratio),
    y: left.y + ((right.y - left.y) * ratio)
  };
}

function catmullRomPoint(p0, p1, p2, p3, ratio) {
  const alpha = 0.5;
  const nextTime = (time, left, right) => time + Math.max(1e-6, distance(left, right) ** alpha);
  const t0 = 0;
  const t1 = nextTime(t0, p0, p1);
  const t2 = nextTime(t1, p1, p2);
  const t3 = nextTime(t2, p2, p3);
  const t = t1 + ((t2 - t1) * ratio);
  const blend = (left, right, leftTime, rightTime) => interpolate(
    left,
    right,
    (t - leftTime) / Math.max(1e-6, rightTime - leftTime)
  );

  const a1 = blend(p0, p1, t0, t1);
  const a2 = blend(p1, p2, t1, t2);
  const a3 = blend(p2, p3, t2, t3);
  const b1 = interpolate(a1, a2, (t - t0) / Math.max(1e-6, t2 - t0));
  const b2 = interpolate(a2, a3, (t - t1) / Math.max(1e-6, t3 - t1));
  return interpolate(b1, b2, (t - t1) / Math.max(1e-6, t2 - t1));
}

function clampToSegmentDeviation(point, start, end, maxDeviationMeters) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = (dx * dx) + (dy * dy);
  if (!(lengthSquared > 0)) return { ...start };

  const projectionRatio = Math.max(0, Math.min(1,
    (((point.x - start.x) * dx) + ((point.y - start.y) * dy)) / lengthSquared
  ));
  const projection = {
    x: start.x + (dx * projectionRatio),
    y: start.y + (dy * projectionRatio)
  };
  const deviation = distance(projection, point);
  if (!(deviation > maxDeviationMeters)) return point;

  const scale = maxDeviationMeters / deviation;
  return {
    x: projection.x + ((point.x - projection.x) * scale),
    y: projection.y + ((point.y - projection.y) * scale)
  };
}

function extrapolate(anchor, neighbor) {
  return {
    x: (2 * anchor.x) - neighbor.x,
    y: (2 * anchor.y) - neighbor.y
  };
}

export function smoothSegmentTrackForRendering(track, options = {}) {
  const source = Array.isArray(track)
    ? track.filter((point) => Number.isFinite(Number(point?.lat)) && Number.isFinite(Number(point?.lng)))
    : [];
  if (source.length < 3) {
    return source.map((point) => ({ lat: Number(point.lat), lng: Number(point.lng) }));
  }

  const targetSpacingMeters = Math.max(2, Number(options.targetSpacingMeters) || 6);
  const maxDeviationMeters = Math.max(0, Number(options.maxDeviationMeters) || 5);
  const maxPoints = Math.max(source.length, Math.trunc(Number(options.maxPoints) || 2048));
  const originLat = Number(source[0].lat);
  const originLng = Number(source[0].lng);
  const referenceLatitude = source.reduce((sum, point) => sum + Number(point.lat), 0) / source.length;
  const longitudeScale = EARTH_RADIUS_METERS
    * DEGREES_TO_RADIANS
    * Math.max(0.01, Math.cos(referenceLatitude * DEGREES_TO_RADIANS));
  const latitudeScale = EARTH_RADIUS_METERS * DEGREES_TO_RADIANS;
  const projected = source.map((point) => ({
    x: (Number(point.lng) - originLng) * longitudeScale,
    y: (Number(point.lat) - originLat) * latitudeScale
  }));
  const segmentLengths = projected.slice(1).map((point, index) => distance(projected[index], point));
  const requestedPointCount = 1 + segmentLengths.reduce(
    (total, length) => total + Math.max(1, Math.ceil(length / targetSpacingMeters)),
    0
  );
  const spacingScale = requestedPointCount > maxPoints ? requestedPointCount / maxPoints : 1;
  let effectiveSpacing = targetSpacingMeters * spacingScale;
  const countAtSpacing = () => 1 + segmentLengths.reduce(
    (total, length) => total + Math.max(1, Math.ceil(length / effectiveSpacing)),
    0
  );
  while (countAtSpacing() > maxPoints) {
    effectiveSpacing *= 1.15;
  }
  const smoothed = [{ ...projected[0] }];

  for (let index = 0; index < projected.length - 1; index += 1) {
    const p1 = projected[index];
    const p2 = projected[index + 1];
    const p0 = projected[index - 1] || extrapolate(p1, p2);
    const p3 = projected[index + 2] || extrapolate(p2, p1);
    const steps = Math.max(1, Math.ceil(segmentLengths[index] / effectiveSpacing));

    for (let step = 1; step <= steps; step += 1) {
      const ratio = step / steps;
      const curved = ratio === 1
        ? { ...p2 }
        : catmullRomPoint(p0, p1, p2, p3, ratio);
      smoothed.push(clampToSegmentDeviation(curved, p1, p2, maxDeviationMeters));
    }
  }

  return smoothed.map((point) => ({
    lat: originLat + (point.y / latitudeScale),
    lng: originLng + (point.x / longitudeScale)
  }));
}
