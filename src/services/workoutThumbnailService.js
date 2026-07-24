import pool from "./database.js";
import Workout from "../shared/Workout.js";
import GpsTrackBlobService from "./gpsTrackBlobService.js";
import SegmentDBService from "./segmentDBService.js";
import {
  matchCompactGpsSegmentBestEfforts,
  prepareCompactGpsSegmentDefinitions
} from "../shared/CompactGpsSegmentMatcher.js";
import {
  WORKOUT_ROUTE_COLOR,
  WORKOUT_ROUTE_THUMBNAIL_STYLE_VERSION,
  getSegmentColor
} from "../shared/SegmentAppearance.js";

const SVG_WIDTH = 256;
const SVG_HEIGHT = 160;
const SVG_PADDING = 14;
const POWER_THUMB_STRONG_SMOOTHING_WINDOW = 35;
const INDOOR_THUMB_SMOOTHING_WINDOW = 15;
const THUMB_MAX_SERIES_POINTS = 180;
const ROUTE_SIMPLIFY_TOLERANCE_PX = 0.5;
const thumbnailGenerationInflight = new Map();
const thumbnailPersistenceInflight = new Map();

function escapeXml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function createPathFromPoints(
  points = [],
  width = SVG_WIDTH,
  height = SVG_HEIGHT,
  padding = SVG_PADDING,
  sharedBounds = null
) {
  if (!Array.isArray(points) || points.length < 2) {
    return "";
  }

  const bounds = sharedBounds || getPointBounds(points);

  return points.map((point, index) => {
    const projected = projectPoint(point, bounds, width, height, padding);
    const px = projected.x;
    const py = projected.y;
    return `${index === 0 ? "M" : "L"} ${px.toFixed(2)} ${py.toFixed(2)}`;
  }).join(" ");
}

function projectPoint(point, bounds, width = SVG_WIDTH, height = SVG_HEIGHT, padding = SVG_PADDING) {
  const rangeX = Math.max(1e-9, bounds.maxX - bounds.minX);
  const rangeY = Math.max(1e-9, bounds.maxY - bounds.minY);
  const drawWidth = width - (padding * 2);
  const drawHeight = height - (padding * 2);
  const scale = Math.min(drawWidth / rangeX, drawHeight / rangeY);
  const scaledWidth = rangeX * scale;
  const scaledHeight = rangeY * scale;
  const offsetX = padding + ((drawWidth - scaledWidth) / 2);
  const offsetY = padding + ((drawHeight - scaledHeight) / 2);

  return {
    x: offsetX + ((Number(point.x) - bounds.minX) * scale),
    y: offsetY + (scaledHeight - ((Number(point.y) - bounds.minY) * scale))
  };
}

function pointToLineDistanceSquared(point, start, end) {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  if (deltaX === 0 && deltaY === 0) {
    const x = point.x - start.x;
    const y = point.y - start.y;
    return (x * x) + (y * y);
  }

  const projection = Math.max(0, Math.min(1, (
    ((point.x - start.x) * deltaX) + ((point.y - start.y) * deltaY)
  ) / ((deltaX * deltaX) + (deltaY * deltaY))));
  const projectedX = start.x + (projection * deltaX);
  const projectedY = start.y + (projection * deltaY);
  const x = point.x - projectedX;
  const y = point.y - projectedY;
  return (x * x) + (y * y);
}

function simplifyPointsForSvg(points, bounds, tolerancePx = ROUTE_SIMPLIFY_TOLERANCE_PX) {
  if (!Array.isArray(points) || points.length <= 2) {
    return Array.isArray(points) ? points : [];
  }

  const projected = points.map((point) =>
    projectPoint(point, bounds, SVG_WIDTH, SVG_HEIGHT, SVG_PADDING)
  );
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  const toleranceSquared = tolerancePx * tolerancePx;

  while (stack.length > 0) {
    const [startIndex, endIndex] = stack.pop();
    let furthestIndex = -1;
    let furthestDistanceSquared = toleranceSquared;
    for (let index = startIndex + 1; index < endIndex; index += 1) {
      const distanceSquared = pointToLineDistanceSquared(
        projected[index],
        projected[startIndex],
        projected[endIndex]
      );
      if (distanceSquared > furthestDistanceSquared) {
        furthestDistanceSquared = distanceSquared;
        furthestIndex = index;
      }
    }
    if (furthestIndex >= 0) {
      keep[furthestIndex] = 1;
      stack.push([startIndex, furthestIndex], [furthestIndex, endIndex]);
    }
  }

  return points.filter((_, index) => keep[index] === 1);
}

function getPointBounds(points = []) {
  const xs = points.map((point) => Number(point.x));
  const ys = points.map((point) => Number(point.y));
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys)
  };
}

function createAreaPathFromSeries(values = [], width = SVG_WIDTH, height = SVG_HEIGHT, padding = SVG_PADDING, options = {}) {
  const {
    minValue = null,
    maxValue = null
  } = options;

  if (!Array.isArray(values) || values.length < 2) {
    return "";
  }

  const min = minValue == null ? Math.min(...values) : Number(minValue);
  const max = maxValue == null ? Math.max(...values) : Number(maxValue);
  const range = Math.max(1e-9, max - min);
  const drawWidth = width - (padding * 2);
  const drawHeight = height - (padding * 2);
  const baseY = height - padding;

  const commands = values.map((value, index) => {
    const x = padding + ((index / Math.max(1, values.length - 1)) * drawWidth);
    const y = padding + (drawHeight - (((Number(value) - min) / range) * drawHeight));
    return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
  }).join(" ");

  return `${commands} L ${(width - padding).toFixed(2)} ${baseY.toFixed(2)} L ${padding.toFixed(2)} ${baseY.toFixed(2)} Z`;
}

function createLinePathFromSeries(values = [], options = {}) {
  const {
    width = SVG_WIDTH,
    height = SVG_HEIGHT,
    padding = SVG_PADDING,
    minValue = null,
    maxValue = null
  } = options;

  if (!Array.isArray(values) || values.length < 2) {
    return "";
  }

  const localMin = minValue == null ? Math.min(...values) : Number(minValue);
  const localMax = maxValue == null ? Math.max(...values) : Number(maxValue);
  const range = Math.max(1e-9, localMax - localMin);
  const drawWidth = width - (padding * 2);
  const drawHeight = height - (padding * 2);

  return values.map((value, index) => {
    const x = padding + ((index / Math.max(1, values.length - 1)) * drawWidth);
    const y = padding + (drawHeight - (((Number(value) - localMin) / range) * drawHeight));
    return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
  }).join(" ");
}

function smoothSeriesCentered(values = [], windowSize = 1) {
  if (!Array.isArray(values) || values.length === 0) {
    return [];
  }

  const size = Math.max(1, Math.floor(windowSize));
  if (size <= 1) {
    return [...values];
  }

  const halfLeft = Math.floor((size - 1) / 2);
  const halfRight = size - 1 - halfLeft;
  const out = new Array(values.length);

  for (let i = 0; i < values.length; i++) {
    const start = Math.max(0, i - halfLeft);
    const end = Math.min(values.length - 1, i + halfRight);
    let sum = 0;
    let count = 0;

    for (let index = start; index <= end; index += 1) {
      sum += Number(values[index]) || 0;
      count += 1;
    }

    out[i] = count > 0 ? sum / count : Number(values[i]) || 0;
  }

  return out;
}

function downsampleSeries(values = [], maxPoints = THUMB_MAX_SERIES_POINTS) {
  if (!Array.isArray(values) || values.length <= maxPoints) {
    return [...values];
  }

  return Array.from({ length: maxPoints }, (_, index) => {
    const sourceIndex = Math.round((index / Math.max(1, maxPoints - 1)) * (values.length - 1));
    return values[sourceIndex];
  });
}

function buildSvgShell({
  title,
  bodyMarkup,
  accent = "#2563eb",
  showAccentBar = true,
  styleVersion = null
}) {
  const styleVersionAttribute = styleVersion == null
    ? ""
    : ` data-thumbnail-style="${escapeXml(styleVersion)}"`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_WIDTH}" height="${SVG_HEIGHT}" viewBox="0 0 ${SVG_WIDTH} ${SVG_HEIGHT}" role="img" aria-label="${escapeXml(title)}"${styleVersionAttribute}>
  <defs>
    <linearGradient id="thumb-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#f8fafc"/>
      <stop offset="100%" stop-color="#edf2ff"/>
    </linearGradient>
    <linearGradient id="thumb-accent" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${escapeXml(accent)}"/>
      <stop offset="100%" stop-color="#0f172a"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="${SVG_WIDTH}" height="${SVG_HEIGHT}" rx="20" fill="url(#thumb-bg)"/>
  ${showAccentBar ? `<rect x="0" y="0" width="8" height="${SVG_HEIGHT}" rx="8" fill="url(#thumb-accent)"/>` : ""}
  ${bodyMarkup}
</svg>`;
}

function normalizeRouteSegments(gpsTrackSegments = null, gpsTrack = null) {
  const normalizePoint = (point) => {
    const lat = Array.isArray(point) ? point[0] : point?.lat;
    const lng = Array.isArray(point) ? point[1] : point?.lng;
    return {
      lat: Number(lat),
      lng: Number(lng)
    };
  };

  if (Array.isArray(gpsTrackSegments) && gpsTrackSegments.length) {
    return gpsTrackSegments
      .map((segment) => (Array.isArray(segment) ? segment : [])
        .map(normalizePoint)
        .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng)))
      .filter((segment) => segment.length >= 2);
  }

  const fallback = (Array.isArray(gpsTrack) ? gpsTrack : [])
    .map(normalizePoint)
    .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));

  return fallback.length >= 2 ? [fallback] : [];
}

function buildRouteThumbnail(gpsTrackSegments = null, gpsTrack = null, segmentOverlays = []) {
  const normalizedSegments = normalizeRouteSegments(gpsTrackSegments, gpsTrack);
  const numericTrack = normalizedSegments.flat();

  if (numericTrack.length < 2) {
    return null;
  }

  const averageLatitudeRadians = (
    numericTrack.reduce((sum, point) => sum + point.lat, 0) / numericTrack.length
  ) * Math.PI / 180;
  const longitudeScale = Math.max(1e-9, Math.cos(averageLatitudeRadians));

  const points = numericTrack
    .map((point) => ({
      x: point.lng * longitudeScale,
      y: point.lat
    }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));

  if (points.length < 2) {
    return null;
  }

  const bounds = getPointBounds(points);
  const start = points[0];
  const end = points[points.length - 1];
  const startProjected = projectPoint(start, bounds);
  const endProjected = projectPoint(end, bounds);
  const projectedRouteSegments = normalizedSegments
    .map((segment) => segment
      .map((point) => ({
        x: point.lng * longitudeScale,
        y: point.lat
      }))
      .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y)))
    .filter((segment) => segment.length >= 2)
    .map((segment) => ({
      inputPointCount: segment.length,
      points: simplifyPointsForSvg(segment, bounds)
    }));
  const pathMarkup = projectedRouteSegments
    .map((segment) => `<path d="${createPathFromPoints(
      segment.points,
      SVG_WIDTH,
      SVG_HEIGHT,
      SVG_PADDING,
      bounds
    )}" fill="none" stroke="${WORKOUT_ROUTE_COLOR}" stroke-width="4" stroke-opacity="0.9" stroke-linecap="round" stroke-linejoin="round"/>`)
    .join("");
  const projectedOverlays = (Array.isArray(segmentOverlays) ? segmentOverlays : [])
    .flatMap((overlay) => (Array.isArray(overlay?.segments) ? overlay.segments : [])
      .map((segment) => ({
        segmenttype: overlay.segmenttype,
        points: segment
          .map((point) => ({
            x: Number(point?.lng) * longitudeScale,
            y: Number(point?.lat)
          }))
          .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
      })))
    .filter((overlay) => overlay.points.length >= 2)
    .map((overlay) => ({
      ...overlay,
      inputPointCount: overlay.points.length,
      points: simplifyPointsForSvg(overlay.points, bounds)
    }));
  const overlayMarkup = projectedOverlays
    .map((overlay) => (
      `<path data-segment-type="${escapeXml(overlay.segmenttype || "manual")}" d="${createPathFromPoints(
        overlay.points,
        SVG_WIDTH,
        SVG_HEIGHT,
        SVG_PADDING,
        bounds
      )}" fill="none" stroke="${getSegmentColor(overlay)}" stroke-width="4" stroke-opacity="0.9" stroke-linecap="round" stroke-linejoin="round"/>`
    ))
    .join("");
  const bodyMarkup = `
    <rect x="12" y="12" width="${SVG_WIDTH - 24}" height="${SVG_HEIGHT - 24}" rx="16" fill="#dcfce7"/>
    ${pathMarkup}
    ${overlayMarkup}
    <circle cx="${startProjected.x.toFixed(2)}" cy="${startProjected.y.toFixed(2)}" r="5" fill="#ffffff" stroke="#16a34a" stroke-width="2"/>
    <circle cx="${endProjected.x.toFixed(2)}" cy="${endProjected.y.toFixed(2)}" r="5.5" fill="#dc2626" stroke="#ffffff" stroke-width="2"/>
  `;

  return {
    kind: "route",
    mimeType: "image/svg+xml",
    width: SVG_WIDTH,
    height: SVG_HEIGHT,
    renderStats: {
      routeInputPointCount: projectedRouteSegments.reduce(
        (sum, segment) => sum + segment.inputPointCount,
        0
      ),
      routeRenderedPointCount: projectedRouteSegments.reduce(
        (sum, segment) => sum + segment.points.length,
        0
      ),
      overlayInputPointCount: projectedOverlays.reduce(
        (sum, overlay) => sum + overlay.inputPointCount,
        0
      ),
      overlayRenderedPointCount: projectedOverlays.reduce(
        (sum, overlay) => sum + overlay.points.length,
        0
      )
    },
    content: buildSvgShell({
      title: "Workout route thumbnail",
      bodyMarkup,
      accent: "#16a34a",
      showAccentBar: false,
      styleVersion: WORKOUT_ROUTE_THUMBNAIL_STYLE_VERSION
    })
  };
}

function buildCompactRouteSegments(compactTrack) {
  const latitudes = compactTrack?.latitudesE5;
  const longitudes = compactTrack?.longitudesE5;
  const slotIndices = compactTrack?.slotIndices;
  if (!(latitudes instanceof Int32Array)
    || !(longitudes instanceof Int32Array)
    || !(slotIndices instanceof Uint32Array)) {
    return [];
  }

  const segments = [];
  let current = null;
  let previousSlot = -2;
  for (let index = 0; index < latitudes.length; index += 1) {
    const slotIndex = Number(slotIndices[index]);
    if (!current || slotIndex !== previousSlot + 1) {
      current = [];
      segments.push(current);
    }
    current.push({
      lat: latitudes[index] / 100000,
      lng: longitudes[index] / 100000,
      slotIndex
    });
    previousSlot = slotIndex;
  }
  return segments.filter((segment) => segment.length >= 2);
}

function buildCompactSegmentOverlays(compactTrack, ranges = []) {
  const routeSegments = buildCompactRouteSegments(compactTrack);
  const sampleRate = Math.max(1, Number(compactTrack?.sampleRateGps) || 1);

  return (Array.isArray(ranges) ? ranges : [])
    .map((range) => {
      const startSlot = Math.floor(Number(range.start_offset) / sampleRate);
      const endSlot = Math.ceil(Number(range.end_offset) / sampleRate);
      return {
        segmenttype: range.segmenttype || "manual",
        segments: routeSegments
          .map((segment) => segment.filter((point) =>
            point.slotIndex >= startSlot && point.slotIndex <= endSlot
          ))
          .filter((segment) => segment.length >= 2)
      };
    })
    .filter((overlay) => overlay.segments.length > 0);
}

function buildCompositeProfileThumbnail({ altitudes = [], powers = [] } = {}) {
  const numericAltitudes = altitudes.map((value) => Number(value)).filter((value) => Number.isFinite(value));
  const numericPowers = powers.map((value) => Number(value)).filter((value) => Number.isFinite(value));
  const smoothedPowers = smoothSeriesCentered(numericPowers, POWER_THUMB_STRONG_SMOOTHING_WINDOW);

  if (numericAltitudes.length < 2 && smoothedPowers.length < 2) {
    return null;
  }

  const altitudeMin = numericAltitudes.length ? Math.min(0, Math.min(...numericAltitudes)) : 0;
  const altitudeMaxRaw = numericAltitudes.length ? Math.max(...numericAltitudes) : 0;
  const altitudeMax = altitudeMaxRaw > altitudeMin
    ? altitudeMaxRaw + ((altitudeMaxRaw - altitudeMin) * 0.1)
    : altitudeMin + 1;

  const powerMaxRaw = smoothedPowers.length ? Math.max(...smoothedPowers) : 1;
  const powerMax = powerMaxRaw > 0 ? powerMaxRaw * 1.05 : 1;

  const areaPath = numericAltitudes.length >= 2
    ? createAreaPathFromSeries(numericAltitudes, SVG_WIDTH, SVG_HEIGHT, SVG_PADDING)
    : "";
  const powerPath = smoothedPowers.length >= 2
    ? createLinePathFromSeries(smoothedPowers, {
        minValue: 0,
        maxValue: powerMax
      })
    : "";
  const bodyMarkup = `
    <rect x="12" y="12" width="${SVG_WIDTH - 24}" height="${SVG_HEIGHT - 24}" rx="16" fill="#f8fafc"/>
    ${areaPath ? `<path d="${createAreaPathFromSeries(numericAltitudes, SVG_WIDTH, SVG_HEIGHT, SVG_PADDING, {
      minValue: altitudeMin,
      maxValue: altitudeMax
    })}" fill="rgba(15, 118, 110, 0.18)" stroke="none"/>` : ""}
    ${numericAltitudes.length >= 2 ? `<path d="${createLinePathFromSeries(numericAltitudes, {
      minValue: altitudeMin,
      maxValue: altitudeMax
    })}" fill="none" stroke="#0f766e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>` : ""}
    ${powerPath ? `<path d="${powerPath}" fill="none" stroke="#2563eb" stroke-width="3.25" stroke-linecap="round" stroke-linejoin="round"/>` : ""}
  `;

  return {
    kind: "profile",
    mimeType: "image/svg+xml",
    width: SVG_WIDTH,
    height: SVG_HEIGHT,
    content: buildSvgShell({
      title: "Workout profile thumbnail",
      bodyMarkup,
      accent: "#2563eb",
      showAccentBar: false
    })
  };
}

function buildMetricProfileThumbnail({
  powers = [],
  heartRates = [],
  cadences = [],
  kind = "metrics-profile",
  title = "Workout metrics thumbnail"
} = {}) {
  const prepare = (values, smoothingWindow) => downsampleSeries(
    smoothSeriesCentered(
      Array.from(values || [], (value) => Number(value)).filter((value) => Number.isFinite(value)),
      smoothingWindow
    )
  );
  const numericPowers = prepare(powers, POWER_THUMB_STRONG_SMOOTHING_WINDOW);
  const numericHeartRates = prepare(heartRates, INDOOR_THUMB_SMOOTHING_WINDOW);
  const numericCadences = prepare(cadences, INDOOR_THUMB_SMOOTHING_WINDOW);
  const usefulPowers = numericPowers.length >= 2 && numericPowers.some((value) => value > 0);
  const usefulHeartRates = numericHeartRates.length >= 2 && numericHeartRates.some((value) => value > 0);
  const usefulCadences = numericCadences.length >= 2 && numericCadences.some((value) => value > 0);

  if (!usefulPowers && !usefulHeartRates && !usefulCadences) {
    return null;
  }

  const linePath = (values, minValue, maxValue) => createLinePathFromSeries(values, {
    width: SVG_WIDTH,
    height: SVG_HEIGHT - 8,
    padding: 18,
    minValue,
    maxValue
  });
  const powerMax = usefulPowers ? Math.max(1, Math.max(...numericPowers) * 1.05) : 1;
  const heartRateMin = usefulHeartRates ? Math.max(0, Math.min(...numericHeartRates) - 10) : 0;
  const heartRateMax = usefulHeartRates ? Math.max(heartRateMin + 1, Math.max(...numericHeartRates) + 5) : 1;
  const cadenceMax = usefulCadences ? Math.max(1, Math.max(...numericCadences) * 1.05) : 1;
  const bodyMarkup = `
    <rect x="12" y="12" width="${SVG_WIDTH - 24}" height="${SVG_HEIGHT - 24}" rx="16" fill="#f8fafc"/>
    <path d="M 18 52 L 238 52 M 18 96 L 238 96" fill="none" stroke="#cbd5e1" stroke-width="1" opacity="0.55"/>
    ${usefulCadences ? `<path d="${linePath(numericCadences, 0, cadenceMax)}" fill="none" stroke="#f59e0b" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/>` : ""}
    ${usefulHeartRates ? `<path d="${linePath(numericHeartRates, heartRateMin, heartRateMax)}" fill="none" stroke="#16a34a" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>` : ""}
    ${usefulPowers ? `<path d="${linePath(numericPowers, 0, powerMax)}" fill="none" stroke="#2563eb" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>` : ""}
    <g font-family="sans-serif" font-size="9" font-weight="600">
      ${usefulPowers ? '<circle cx="20" cy="20" r="3" fill="#2563eb"/><text x="27" y="23" fill="#2563eb">PWR</text>' : ""}
      ${usefulHeartRates ? '<circle cx="67" cy="20" r="3" fill="#16a34a"/><text x="74" y="23" fill="#16a34a">HR</text>' : ""}
      ${usefulCadences ? '<circle cx="105" cy="20" r="3" fill="#f59e0b"/><text x="112" y="23" fill="#b45309">CAD</text>' : ""}
    </g>
  `;

  return {
    kind,
    mimeType: "image/svg+xml",
    width: SVG_WIDTH,
    height: SVG_HEIGHT,
    content: buildSvgShell({
      title,
      bodyMarkup,
      accent: "#2563eb",
      showAccentBar: false
    })
  };
}

export default class WorkoutThumbnailService {
  static extractThumbnailSeries(workoutObject = null) {
    if (!workoutObject?.length || workoutObject.length < 2) {
      return {
        altitudes: [],
        powers: [],
        heartRates: [],
        cadences: []
      };
    }

    const altitudes = [];
    const powers = [];
    const heartRates = [];
    const cadences = [];
    for (let i = 0; i < workoutObject.length; i++) {
      const altitudeValue = typeof workoutObject.getAltitudeAt === "function"
        ? Number(workoutObject.getAltitudeAt(i))
        : null;
      const powerValue = typeof workoutObject.getPowerAt === "function"
        ? Number(workoutObject.getPowerAt(i))
        : null;
      const heartRateValue = typeof workoutObject.getHrAt === "function"
        ? Number(workoutObject.getHrAt(i))
        : null;
      const cadenceValue = typeof workoutObject.getCadenceAt === "function"
        ? Number(workoutObject.getCadenceAt(i))
        : null;

      if (Number.isFinite(altitudeValue)) {
        altitudes.push(altitudeValue);
      }
      if (Number.isFinite(powerValue)) {
        powers.push(powerValue);
      }
      if (Number.isFinite(heartRateValue)) {
        heartRates.push(heartRateValue);
      }
      if (Number.isFinite(cadenceValue)) {
        cadences.push(cadenceValue);
      }
    }

    return {
      altitudes,
      powers,
      heartRates,
      cadences
    };
  }

  static createThumbnailPayload({
    workoutType = null,
    gpsTrack = null,
    gpsTrackSegments = null,
    segmentOverlays = null,
    workoutObject = null,
    altitudes = null,
    powers = null,
    heartRates = null,
    cadences = null
  } = {}) {
    if (String(workoutType || "").toLowerCase() === "indoor") {
      const extracted = workoutObject?.length >= 2
        ? WorkoutThumbnailService.extractThumbnailSeries(workoutObject)
        : {};
      return buildMetricProfileThumbnail({
        powers: Array.isArray(powers) ? powers : extracted.powers,
        heartRates: Array.isArray(heartRates) ? heartRates : extracted.heartRates,
        cadences: Array.isArray(cadences) ? cadences : extracted.cadences,
        kind: "indoor-profile",
        title: "Indoor workout profile thumbnail"
      });
    }

    if ((Array.isArray(gpsTrackSegments) && gpsTrackSegments.length) || (Array.isArray(gpsTrack) && gpsTrack.length >= 2)) {
      const routeThumb = buildRouteThumbnail(gpsTrackSegments, gpsTrack, segmentOverlays);
      if (routeThumb) {
        return routeThumb;
      }
    }

    const metricSeries = workoutObject?.length >= 2
      ? WorkoutThumbnailService.extractThumbnailSeries(workoutObject)
      : {};
    const metricThumb = buildMetricProfileThumbnail({
      powers: Array.isArray(powers) ? powers : metricSeries.powers,
      heartRates: Array.isArray(heartRates) ? heartRates : metricSeries.heartRates,
      cadences: Array.isArray(cadences) ? cadences : metricSeries.cadences
    });
    if (metricThumb) {
      return metricThumb;
    }

    let resolvedAltitudes = Array.isArray(altitudes) ? altitudes : null;
    let resolvedPowers = Array.isArray(powers) ? powers : null;

    if ((!resolvedAltitudes || !resolvedPowers) && workoutObject?.length >= 2) {
      const extracted = WorkoutThumbnailService.extractThumbnailSeries(workoutObject);
      resolvedAltitudes = resolvedAltitudes ?? extracted.altitudes;
      resolvedPowers = resolvedPowers ?? extracted.powers;
    }

    if (Array.isArray(resolvedAltitudes) || Array.isArray(resolvedPowers)) {
      const safeAltitudes = Array.isArray(resolvedAltitudes) ? resolvedAltitudes : [];
      const safePowers = Array.isArray(resolvedPowers) ? resolvedPowers : [];
      const usefulAltitude = safeAltitudes.length >= 2 && safeAltitudes.some((value) => value !== safeAltitudes[0]);
      const usefulPower = safePowers.length >= 2 && safePowers.some((value) => value > 0);
      if (usefulAltitude || usefulPower) {
        const thumb = buildCompositeProfileThumbnail({
          altitudes: usefulAltitude ? safeAltitudes : [],
          powers: usefulPower ? safePowers : []
        });
        if (thumb) {
          return thumb;
        }
      }
    }

    return null;
  }

  static async upsertThumbnail(workoutId, payload) {
    if (!Number.isInteger(Number(workoutId)) || !payload?.content) {
      return null;
    }

    const result = await pool.query(
      `
      INSERT INTO workout_thumbnails (
        workout_id,
        kind,
        mime_type,
        width,
        height,
        content
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (workout_id)
      DO UPDATE SET
        kind = EXCLUDED.kind,
        mime_type = EXCLUDED.mime_type,
        width = EXCLUDED.width,
        height = EXCLUDED.height,
        content = EXCLUDED.content,
        updated_at = NOW()
      RETURNING workout_id AS "workoutId", kind, mime_type AS "mimeType", width, height, updated_at AS "updatedAt"
      `,
      [
        Number(workoutId),
        payload.kind,
        payload.mimeType,
        payload.width,
        payload.height,
        payload.content
      ]
    );

    return result.rows[0] || null;
  }

  static async getThumbnail(workoutId) {
    const result = await pool.query(
      `
      SELECT
        workout_id AS "workoutId",
        kind,
        mime_type AS "mimeType",
        width,
        height,
        content,
        updated_at AS "updatedAt"
      FROM workout_thumbnails
      WHERE workout_id = $1
      `,
      [Number(workoutId)]
    );

    return result.rows[0] || null;
  }

  static isCurrentRouteThumbnail(thumbnail) {
    if (thumbnail?.kind !== "route") {
      return true;
    }

    return String(thumbnail.content || "").includes(
      `data-thumbnail-style="${WORKOUT_ROUTE_THUMBNAIL_STYLE_VERSION}"`
    );
  }

  static parseGeoJsonTrack(trackGeoJson = null) {
    const coordinates = Array.isArray(trackGeoJson?.coordinates)
      ? trackGeoJson.coordinates
      : [];

    return coordinates
      .map((entry) => {
        const lng = Number(entry?.[0]);
        const lat = Number(entry?.[1]);
        return Number.isFinite(lat) && Number.isFinite(lng) ? [lat, lng] : null;
      })
      .filter(Boolean);
  }

  static async generateThumbnailForWorkout(workoutId, { skipExistingCheck = false } = {}) {
    const normalizedWorkoutId = Number(workoutId);
    if (!Number.isInteger(normalizedWorkoutId) || normalizedWorkoutId <= 0) {
      return null;
    }

    const pendingPersistence = thumbnailPersistenceInflight.get(normalizedWorkoutId);
    if (pendingPersistence?.thumbnail?.content) {
      return pendingPersistence.thumbnail;
    }

    if (!skipExistingCheck) {
      const existing = await WorkoutThumbnailService.getThumbnail(normalizedWorkoutId);
      if (existing?.content) {
        return existing;
      }
    }

    if (thumbnailGenerationInflight.has(normalizedWorkoutId)) {
      return thumbnailGenerationInflight.get(normalizedWorkoutId);
    }

    const generationPromise = (async () => {
      const profile = {
        loadWorkoutMs: 0,
        loadWorkoutSegmentsMs: 0,
        loadGpsCandidatesMs: 0,
        loadGpsDefinitionsMs: 0,
        decodeGpsTrackMs: 0,
        matchGpsSegmentsMs: 0,
        decompressWorkoutStreamMs: 0,
        decodeWorkoutStreamMs: 0,
        renderSvgMs: 0,
        persistThumbnailMs: 0,
        persistThumbnailMode: "write-behind",
        workoutSegmentCount: 0,
        gpsCandidateCount: 0,
        gpsMatchCount: 0,
        thumbnailSeriesMode: null
      };
      const totalStartedAt = performance.now();
      let stepStartedAt = performance.now();
      const result = await pool.query(
        `SELECT
          id,
          uid,
          validgps,
          CASE WHEN validgps THEN NULL ELSE stream END AS stream,
          stream_codec,
          gps_track_blob,
          gps_track_blob_codec,
          workout_type
         FROM workouts
         WHERE id = $1`,
        [normalizedWorkoutId]
      );
      profile.loadWorkoutMs = performance.now() - stepStartedAt;

      if (result.rowCount === 0) {
        return null;
      }

      const row = result.rows[0];
      let workoutObject = null;
      let gpsTrackSegments = [];
      let segmentOverlays = [];

      if (row.validgps && row.gps_track_blob) {
        const timed = async (profileKey, callback) => {
          const startedAt = performance.now();
          const value = await callback();
          profile[profileKey] = performance.now() - startedAt;
          return value;
        };
        const [compactTrack, workoutSegments, candidateResult] = await Promise.all([
          timed("decodeGpsTrackMs", () => GpsTrackBlobService.decodeCompressedCompact(
            row.gps_track_blob,
            {
              codec: row.gps_track_blob_codec || "identity",
              includeSlotIndices: true
            }
          )),
          timed("loadWorkoutSegmentsMs", () => pool.query(`
            SELECT segmenttype, start_offset, end_offset
            FROM workout_segments
            WHERE wid = $1
              AND uid = $2
            ORDER BY start_offset, end_offset
          `, [normalizedWorkoutId, row.uid])),
          timed("loadGpsCandidatesMs", () =>
            SegmentDBService.getMatchingSegmentCandidateIdsForWorkoutsBulk(
              row.uid,
              [normalizedWorkoutId],
              { includeExistingBestEfforts: true }
            ))
        ]);

        const candidateIds = candidateResult.candidatesByWorkoutId.get(normalizedWorkoutId) || [];
        profile.workoutSegmentCount = workoutSegments.rows.length;
        profile.gpsCandidateCount = candidateIds.length;

        const definitionsById = await timed(
          "loadGpsDefinitionsMs",
          () => SegmentDBService.loadSegmentMatchDefinitionsBulk(candidateIds)
        );
        const preparedSegments = prepareCompactGpsSegmentDefinitions([...definitionsById.values()]);
        stepStartedAt = performance.now();
        const gpsMatches = matchCompactGpsSegmentBestEfforts(compactTrack, preparedSegments).matches;
        profile.matchGpsSegmentsMs = performance.now() - stepStartedAt;
        profile.gpsMatchCount = gpsMatches.length;

        const ranges = [
          ...workoutSegments.rows,
          ...gpsMatches.map((match) => ({
            segmenttype: "gps",
            start_offset: match.startOffset,
            end_offset: match.endOffset
          }))
        ];
        gpsTrackSegments = buildCompactRouteSegments(compactTrack);
        segmentOverlays = buildCompactSegmentOverlays(compactTrack, ranges);
      } else if (row?.stream) {
        stepStartedAt = performance.now();
        const rawWorkoutStream = await Workout.decompress(
          row.stream,
          row?.stream_codec || "brotli"
        );
        profile.decompressWorkoutStreamMs = performance.now() - stepStartedAt;
        stepStartedAt = performance.now();
        const series = Workout.getWst9ThumbnailSeries(rawWorkoutStream);
        profile.decodeWorkoutStreamMs = performance.now() - stepStartedAt;
        profile.thumbnailSeriesMode = "direct-wst9";
        workoutObject = {
          length: series.recordCount,
          getPowerAt: (index) => series.powers[index],
          getHrAt: (index) => series.heartRates[index],
          getCadenceAt: (index) => series.cadences[index]
        };
      }

      stepStartedAt = performance.now();
      const payload = WorkoutThumbnailService.createThumbnailPayload({
        workoutType: row.workout_type,
        gpsTrackSegments,
        segmentOverlays,
        workoutObject
      });
      profile.renderSvgMs = performance.now() - stepStartedAt;
      if (payload?.renderStats) {
        Object.assign(profile, payload.renderStats);
      }

      if (!payload) {
        return null;
      }

      profile.totalMs = performance.now() - totalStartedAt;
      const thumbnail = {
        workoutId: normalizedWorkoutId,
        kind: payload.kind,
        mimeType: payload.mimeType,
        width: payload.width,
        height: payload.height,
        content: payload.content,
        generationProfile: profile
      };
      const persistStartedAt = performance.now();
      const persistencePromise = WorkoutThumbnailService.upsertThumbnail(normalizedWorkoutId, payload)
        .then((persisted) => {
          console.info("[thumbnail] persist.profile", {
            workoutId: normalizedWorkoutId,
            kind: payload.kind,
            persistThumbnailMs: performance.now() - persistStartedAt,
            persisted: !!persisted
          });
          return persisted;
        })
        .catch((error) => {
          console.error("[thumbnail] persist.failed", {
            workoutId: normalizedWorkoutId,
            kind: payload.kind,
            persistThumbnailMs: performance.now() - persistStartedAt,
            error: error?.message || String(error)
          });
          return null;
        });
      const pending = {
        thumbnail,
        promise: persistencePromise
      };
      thumbnailPersistenceInflight.set(normalizedWorkoutId, pending);
      void persistencePromise.finally(() => {
        if (thumbnailPersistenceInflight.get(normalizedWorkoutId) === pending) {
          thumbnailPersistenceInflight.delete(normalizedWorkoutId);
        }
      });
      return thumbnail;
    })();

    thumbnailGenerationInflight.set(normalizedWorkoutId, generationPromise);

    try {
      return await generationPromise;
    } finally {
      thumbnailGenerationInflight.delete(normalizedWorkoutId);
    }
  }
}
