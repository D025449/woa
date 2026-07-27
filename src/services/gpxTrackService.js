const MAX_GPX_POINTS = 100000;
const ROUTED_GPX_TARGET_ANCHORS = 200;

export class GpxValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "GpxValidationError";
    this.statusCode = 400;
  }
}

function haversineMeters(a, b) {
  const toRadians = (value) => (value * Math.PI) / 180;
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const value = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
  return 6371000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function parseAttributes(source = "") {
  return Object.fromEntries(
    [...source.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g)]
      .map((match) => [match[1].toLowerCase(), match[3]])
  );
}

function extractPointElements(xml, elementName) {
  const expression = new RegExp(
    `<(?:[\\w.-]+:)?${elementName}\\b([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${elementName}\\s*>)`,
    "gi"
  );
  const points = [];

  for (const match of xml.matchAll(expression)) {
    if (points.length >= MAX_GPX_POINTS) {
      throw new GpxValidationError(`GPX contains more than ${MAX_GPX_POINTS} points.`);
    }

    const attributes = parseAttributes(match[1]);
    const lat = Number(attributes.lat);
    const lng = Number(attributes.lon);
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      lat < -90 ||
      lat > 90 ||
      lng < -180 ||
      lng > 180
    ) {
      continue;
    }

    const elevationMatch = String(match[2] || "").match(
      /<(?:[\w.-]+:)?ele\b[^>]*>\s*([^<]+?)\s*<\/(?:[\w.-]+:)?ele\s*>/i
    );
    const elevation = Number(elevationMatch?.[1]);
    points.push({
      lat,
      lng,
      ele: Number.isFinite(elevation) && elevation >= -500 && elevation <= 9000
        ? elevation
        : null
    });
  }

  return points;
}

function removeConsecutiveDuplicates(points) {
  const normalized = [];
  for (const point of points) {
    const previous = normalized.at(-1);
    if (previous && haversineMeters(previous, point) < 0.5) {
      if (!Number.isFinite(previous.ele) && Number.isFinite(point.ele)) {
        previous.ele = point.ele;
      }
      continue;
    }
    normalized.push({ ...point });
  }
  return normalized;
}

function perpendicularDistanceMeters(point, start, end) {
  const referenceLat = ((start.lat + end.lat + point.lat) / 3) * Math.PI / 180;
  const metersPerDegreeLat = 111320;
  const metersPerDegreeLng = metersPerDegreeLat * Math.cos(referenceLat);
  const startX = start.lng * metersPerDegreeLng;
  const startY = start.lat * metersPerDegreeLat;
  const endX = end.lng * metersPerDegreeLng;
  const endY = end.lat * metersPerDegreeLat;
  const pointX = point.lng * metersPerDegreeLng;
  const pointY = point.lat * metersPerDegreeLat;
  const deltaX = endX - startX;
  const deltaY = endY - startY;
  const squaredLength = deltaX * deltaX + deltaY * deltaY;

  if (squaredLength === 0) {
    return Math.hypot(pointX - startX, pointY - startY);
  }

  const ratio = Math.max(0, Math.min(
    1,
    ((pointX - startX) * deltaX + (pointY - startY) * deltaY) / squaredLength
  ));
  return Math.hypot(
    pointX - (startX + ratio * deltaX),
    pointY - (startY + ratio * deltaY)
  );
}

function simplifyDouglasPeucker(points, toleranceMeters) {
  if (points.length <= 2) {
    return [...points];
  }

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];

  while (stack.length > 0) {
    const [startIndex, endIndex] = stack.pop();
    let farthestIndex = -1;
    let farthestDistance = toleranceMeters;

    for (let index = startIndex + 1; index < endIndex; index += 1) {
      const distance = perpendicularDistanceMeters(
        points[index],
        points[startIndex],
        points[endIndex]
      );
      if (distance > farthestDistance) {
        farthestDistance = distance;
        farthestIndex = index;
      }
    }

    if (farthestIndex > startIndex) {
      keep[farthestIndex] = 1;
      stack.push([startIndex, farthestIndex], [farthestIndex, endIndex]);
    }
  }

  return points.filter((_, index) => keep[index] === 1);
}

export function computeGpxTrackDistanceMeters(points = []) {
  let distance = 0;
  for (let index = 1; index < points.length; index += 1) {
    distance += haversineMeters(points[index - 1], points[index]);
  }
  return distance;
}

export function parseGpxTrack(input) {
  const xml = Buffer.isBuffer(input) ? input.toString("utf8") : String(input || "");
  if (!/<(?:[\w.-]+:)?gpx\b/i.test(xml)) {
    throw new GpxValidationError("File is not a GPX document.");
  }

  let points = extractPointElements(xml, "trkpt");
  if (points.length < 2) {
    points = extractPointElements(xml, "rtept");
  }
  points = removeConsecutiveDuplicates(points);

  if (points.length < 2) {
    throw new GpxValidationError("GPX contains fewer than two valid track points.");
  }

  const distanceMeters = computeGpxTrackDistanceMeters(points);
  if (!Number.isFinite(distanceMeters) || distanceMeters <= 0) {
    throw new GpxValidationError("GPX track has no usable distance.");
  }

  const elevationPointCount = points.reduce(
    (count, point) => count + (Number.isFinite(point.ele) ? 1 : 0),
    0
  );

  return {
    points,
    distanceMeters,
    elevationPointCount,
    hasUsableElevation: elevationPointCount >= Math.max(2, Math.ceil(points.length * 0.8))
  };
}

export function buildGpxRoutingAnchors(points, targetCount = ROUTED_GPX_TARGET_ANCHORS) {
  const normalizedTarget = Math.max(2, Math.floor(Number(targetCount) || ROUTED_GPX_TARGET_ANCHORS));
  if (!Array.isArray(points) || points.length <= normalizedTarget) {
    return Array.isArray(points) ? points.map(({ lat, lng }) => ({ lat, lng })) : [];
  }

  let toleranceMeters = 5;
  let simplified = points;
  while (simplified.length > normalizedTarget && toleranceMeters <= 1280) {
    simplified = simplifyDouglasPeucker(points, toleranceMeters);
    toleranceMeters *= 2;
  }

  if (simplified.length > normalizedTarget) {
    const sampled = [];
    for (let index = 0; index < normalizedTarget; index += 1) {
      const sourceIndex = Math.round(index * (simplified.length - 1) / (normalizedTarget - 1));
      sampled.push(simplified[sourceIndex]);
    }
    simplified = sampled;
  }

  return simplified.map(({ lat, lng }) => ({ lat, lng }));
}
