import pool from "./database.js";
import pLimit from "p-limit";
import { load } from "cheerio";
import { buildThumbnailSegmentProfile } from "./workoutThumbnailSegmentProfile.js";
import Workout from "../shared/Workout.js";
import GpsTrackBlobService from "./gpsTrackBlobService.js";
import SegmentDBService from "./segmentDBService.js";
import GeoapifyThumbnailService from "./geoapifyThumbnailService.js";
import { getLocalThumbnailMapConfig } from "../config/storagePaths.js";
import LocalThumbnailMapService from "./localThumbnailMapService.js";
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
const MAP_ROUTE_HEIGHT = 124;
const FALLBACK_RETRY_MS = 5 * 60 * 1000;
const POWER_THUMB_STRONG_SMOOTHING_WINDOW = 35;
const INDOOR_THUMB_SMOOTHING_WINDOW = 15;
const THUMB_MAX_SERIES_POINTS = 180;
const ROUTE_SIMPLIFY_TOLERANCE_PX = 0.5;
const thumbnailGenerationInflight = new Map();
const thumbnailGenerationLimit = pLimit(6);

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
  sharedBounds = null,
  precision = 2
) {
  if (!Array.isArray(points) || points.length < 2) {
    return "";
  }

  const bounds = sharedBounds || getPointBounds(points);

  return points.map((point, index) => {
    const projected = projectPoint(point, bounds, width, height, padding);
    const px = projected.x;
    const py = projected.y;
    return `${index === 0 ? "M" : "L"} ${px.toFixed(precision)} ${py.toFixed(precision)}`;
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

function simplifyPointsForSvg(points, bounds, tolerancePx = ROUTE_SIMPLIFY_TOLERANCE_PX, height = SVG_HEIGHT) {
  if (!Array.isArray(points) || points.length <= 2) {
    return Array.isArray(points) ? points : [];
  }

  const projected = points.map((point) =>
    projectPoint(point, bounds, SVG_WIDTH, height, SVG_PADDING)
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

function projectRouteCoordinate(point, longitudeScale, mercator) {
  return {
    x: Number(point.lng) * longitudeScale,
    y: mercator
      ? Math.log(Math.tan(Math.PI / 4 + Number(point.lat) * Math.PI / 360)) * 180 / Math.PI
      : Number(point.lat)
  };
}

function annotateRouteFallback(fallback, { reason, retryAt }) {
  return {
    ...fallback,
    content: fallback.content.replace("<svg ", `<svg data-map-fallback="${escapeXml(reason)}" data-map-retry-at="${retryAt}" `),
    renderStats: { ...fallback.renderStats, mapFallbackReason: reason, mapRetryAt: retryAt }
  };
}

function localFallbackMetadata(thumbnail) {
  const content = String(thumbnail?.content || "");
  const state = content.match(/\bdata-local-map-state="(missing-coverage|temporary-failure|unsupported-route)"/)?.[1];
  const revision = content.match(/\bdata-local-map-revision="([a-f0-9]{64})"/)?.[1];
  const attempt = Number(content.match(/\bdata-local-map-attempt="([1-3])"/)?.[1]);
  const retryAt = Number(content.match(/\bdata-map-retry-at="(\d+)"/)?.[1]);
  return state && revision && Number.isSafeInteger(attempt) && Number.isSafeInteger(retryAt)
    ? { state, revision, attempt, retryAt } : null;
}

function localRetryDeadline(attempt) {
  return attempt < 3 ? Date.now() + FALLBACK_RETRY_MS * 3 ** (attempt - 1) : 0;
}

function annotateLocalRouteFallback(fallback, error, revision) {
  const state = error?.message === "outside-coverage" ? "missing-coverage"
    : error?.message === "unsupported-route" ? "unsupported-route" : "temporary-failure";
  const tagged = annotateRouteFallback(fallback, { reason: `local-${state}`,
    retryAt: state === "temporary-failure" ? localRetryDeadline(1) : 0 });
  return { ...tagged,
    content: tagged.content.replace("<svg ", `<svg data-local-map-state="${state}" data-local-map-revision="${revision}" data-local-map-attempt="1" `),
    renderStats: { ...tagged.renderStats, localMapState: state, localMapRevision: revision, localMapAttempt: 1 } };
}

async function renderGeoapifyRouteThumbnail(options, fallback = null) {
  const segments = normalizeRouteSegments(options.gpsTrackSegments, options.gpsTrack);
  const track = segments.flat();
  if (track.length < 2 || track.some((point) => Math.abs(point.lat) > 85.05112878 || Math.abs(point.lng) > 180)) {
    return annotateRouteFallback(fallback, { reason: "unsupported-route", retryAt: Date.now() + FALLBACK_RETRY_MS });
  }
  const bounds = getPointBounds(track.map((point) => projectRouteCoordinate(point, 1, true)));
  if (bounds.maxX - bounds.minX > 180) {
    return annotateRouteFallback(fallback, { reason: "unsupported-route", retryAt: Date.now() + FALLBACK_RETRY_MS });
  }
  const scale = Math.min(
    (SVG_WIDTH - 2 * SVG_PADDING) / Math.max(1e-9, bounds.maxX - bounds.minX),
    (MAP_ROUTE_HEIGHT - 2 * SVG_PADDING) / Math.max(1e-9, bounds.maxY - bounds.minY)
  );
  const centerY = (bounds.minY + bounds.maxY) / 2 - (SVG_HEIGHT - MAP_ROUTE_HEIGHT) / (2 * scale);
  let failure = { reason: "unavailable", retryAt: Date.now() + FALLBACK_RETRY_MS };
  const background = await GeoapifyThumbnailService.getBackground({
    longitude: (bounds.minX + bounds.maxX) / 2,
    latitude: Math.atan(Math.sinh(centerY * Math.PI / 180)) * 180 / Math.PI,
    zoom: Math.log2(scale * (320 / SVG_WIDTH) * 360 / 512)
  }, { workoutId: options.workoutId ?? null, onFallback: (details) => { failure = details; } });
  return background
    ? buildRouteThumbnail(segments, null, options.segmentOverlays, background)
    : annotateRouteFallback(fallback, failure);
}

async function renderLocalRouteThumbnail(options, fallback) {
  const segments = normalizeRouteSegments(options.gpsTrackSegments, options.gpsTrack);
  const result = await (options.localMapClient || LocalThumbnailMapService).render({
    segments: segments.map(segment => segment.map(point => [point.lng, point.lat])),
    overlays: (options.segmentOverlays || []).map(overlay => ({
      segmenttype: overlay.segmenttype || "manual",
      color: getSegmentColor(overlay),
      segments: normalizeRouteSegments(overlay.segments).map(segment => segment.map(point => [point.lng, point.lat]))
    }))
  }, options.localMapConfig || getLocalThumbnailMapConfig());
  return { ...fallback, width: 320, height: 200, content: result.svg,
    renderStats: { ...fallback.renderStats, localMap: result.stats } };
}

function buildRouteThumbnail(gpsTrackSegments = null, gpsTrack = null, segmentOverlays = [], mapBackground = null) {
  const normalizedSegments = normalizeRouteSegments(gpsTrackSegments, gpsTrack);
  const numericTrack = normalizedSegments.flat();

  if (numericTrack.length < 2) {
    return null;
  }

  const averageLatitudeRadians = (
    numericTrack.reduce((sum, point) => sum + point.lat, 0) / numericTrack.length
  ) * Math.PI / 180;
  const longitudeScale = mapBackground ? 1 : Math.max(1e-9, Math.cos(averageLatitudeRadians));
  const routeHeight = mapBackground ? MAP_ROUTE_HEIGHT : SVG_HEIGHT;

  const points = numericTrack
    .map((point) => projectRouteCoordinate(point, longitudeScale, !!mapBackground))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));

  if (points.length < 2) {
    return null;
  }

  const bounds = getPointBounds(points);
  const start = points[0];
  const end = points[points.length - 1];
  const startProjected = projectPoint(start, bounds, SVG_WIDTH, routeHeight);
  const endProjected = projectPoint(end, bounds, SVG_WIDTH, routeHeight);
  const projectedRouteSegments = normalizedSegments
    .map((segment) => segment
      .map((point) => projectRouteCoordinate(point, longitudeScale, !!mapBackground))
      .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y)))
    .filter((segment) => segment.length >= 2)
    .map((segment) => ({
      inputPointCount: segment.length,
      points: simplifyPointsForSvg(segment, bounds, mapBackground ? 0.45 : ROUTE_SIMPLIFY_TOLERANCE_PX, routeHeight)
    }));
  const pathMarkup = projectedRouteSegments
    .map((segment, index) => {
      const path = createPathFromPoints(
      segment.points,
      SVG_WIDTH,
      routeHeight,
      SVG_PADDING,
      bounds,
      mapBackground ? 1 : 2
      );
      return mapBackground
        ? `<defs><path id="route-${index}" d="${path}"/></defs><use href="#route-${index}" fill="none" stroke="#ffffff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/><use href="#route-${index}" fill="none" stroke="${WORKOUT_ROUTE_COLOR}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`
        : `<path d="${path}" fill="none" stroke="${WORKOUT_ROUTE_COLOR}" stroke-width="4" stroke-opacity="0.9" stroke-linecap="round" stroke-linejoin="round"/>`;
    })
    .join("");
  const projectedOverlays = (Array.isArray(segmentOverlays) ? segmentOverlays : [])
    .flatMap((overlay) => (Array.isArray(overlay?.segments) ? overlay.segments : [])
      .map((segment) => ({
        segmenttype: overlay.segmenttype,
        points: segment
          .map((point) => projectRouteCoordinate(point, longitudeScale, !!mapBackground))
          .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
      })))
    .filter((overlay) => overlay.points.length >= 2)
    .map((overlay) => ({
      ...overlay,
      inputPointCount: overlay.points.length,
      points: simplifyPointsForSvg(overlay.points, bounds, ROUTE_SIMPLIFY_TOLERANCE_PX, routeHeight)
    }));
  const overlayMarkup = projectedOverlays
    .map((overlay) => (
      `<path data-segment-type="${escapeXml(overlay.segmenttype || "manual")}" d="${createPathFromPoints(
        overlay.points,
        SVG_WIDTH,
        routeHeight,
        SVG_PADDING,
        bounds,
        mapBackground ? 1 : 2
      )}" fill="none" stroke="${getSegmentColor(overlay)}" stroke-width="4" stroke-opacity="0.9" stroke-linecap="round" stroke-linejoin="round"/>`
    ))
    .join("");
  const bodyMarkup = `
    ${mapBackground
      ? `<image data-map-provider="geoapify" href="${mapBackground}" x="0" y="0" width="${SVG_WIDTH}" height="${SVG_HEIGHT}"/>`
      : `<rect x="12" y="12" width="${SVG_WIDTH - 24}" height="${SVG_HEIGHT - 24}" rx="16" fill="#dcfce7"/>`}
    ${pathMarkup}
    ${overlayMarkup}
    <circle cx="${startProjected.x.toFixed(2)}" cy="${startProjected.y.toFixed(2)}" r="5" fill="#ffffff" stroke="#16a34a" stroke-width="2"/>
    <circle cx="${endProjected.x.toFixed(2)}" cy="${endProjected.y.toFixed(2)}" r="5.5" fill="#dc2626" stroke="#ffffff" stroke-width="2"/>
    ${mapBackground ? `<g fill="#26352d" font-family="sans-serif" font-size="12">
      <rect x="7" y="121" width="242" height="33" fill="#ffffff" fill-opacity="0.96"/>
      <a href="https://www.openstreetmap.org/copyright"><text x="12" y="134">&#169; OpenStreetMap contributors</text></a>
      <text x="12" y="148">Powered by <a href="https://www.geoapify.com/">Geoapify</a> | <a href="https://openmaptiles.org/">&#169; OpenMapTiles</a></text>
    </g>` : ""}
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

function buildBandProfileThumbnail({ powers = [], heartRates = [], altitudes = [], speeds = [],
  segments = [], recordCount = null, gps = false, compact = false, kind = "metrics-profile" } = {}) {
  const prepare = (values, window) => {
    const numeric = Array.from(values || [], value => value == null ? Number.NaN : Number(value));
    const smoothed = smoothSeriesCentered(numeric, window);
    return downsampleSeries(numeric.map((value, index) => Number.isFinite(value) ? smoothed[index] : Number.NaN));
  };
  const series = {
    power: { values: prepare(powers, POWER_THUMB_STRONG_SMOOTHING_WINDOW), color: "#2563eb", label: "Power" },
    heartRate: { values: prepare(heartRates, INDOOR_THUMB_SMOOTHING_WINDOW), color: "#16a34a", label: "HR" },
    altitude: { values: prepare(altitudes, 1), color: "#38bdf8", label: "Altitude" },
    speed: { values: prepare(speeds, INDOOR_THUMB_SMOOTHING_WINDOW), color: "#ef4444", label: "Speed" }
  };
  const available = key => {
    const finite = series[key].values.filter(Number.isFinite);
    return finite.length >= 2 && (key === "altitude" || finite.some(value => value > 0));
  };
  const secondary = available("altitude") ? "altitude" : gps ? "heartRate" : "speed";
  const keys = (gps ? ["power", secondary] : ["power", "heartRate", secondary]).filter(available);
  if (!keys.length) return null;
  const bandHeight = (SVG_HEIGHT - 8) / keys.length;
  const bodyMarkup = keys.map((key, bandIndex) => {
    const { values, color, label } = series[key];
    const finite = values.filter(Number.isFinite);
    const minimum = Math.min(...finite);
    const maximum = Math.max(...finite);
    const padding = Math.max(10, (maximum - minimum) * 0.05);
    const minValue = key === "altitude" ? Math.floor((minimum - padding) / 10) * 10
      : key === "heartRate" ? Math.max(0, minimum - 10) : 0;
    const maxValue = key === "altitude" ? Math.ceil((maximum + padding) / 10) * 10
      : Math.max(minValue + 1, maximum * 1.05);
    const top = 4 + bandIndex * bandHeight;
    const plotTop = top + (compact ? 2 : 14);
    const plotHeight = bandHeight - (compact ? 6 : 18);
    const paths = [];
    let start = 0;
    while (start < values.length) {
      while (start < values.length && !Number.isFinite(values[start])) start++;
      let end = start;
      while (end < values.length && Number.isFinite(values[end])) end++;
      if (end - start >= 2) {
        const left = 18 + start / (values.length - 1) * (SVG_WIDTH - 36);
        const width = (end - start - 1) / (values.length - 1) * (SVG_WIDTH - 36);
        const area = createAreaPathFromSeries(values.slice(start, end), width, plotHeight, 0, { minValue, maxValue });
        paths.push(`<path transform="translate(${left} ${plotTop})" d="${area}" fill="${color}" fill-opacity="${key === "altitude" ? "0.3" : "0.26"}" stroke="none"/>`);
      }
      start = end + 1;
    }
    return `<g data-band="${key}">${compact ? "" : `<text x="18" y="${top + 9}" font-family="sans-serif" font-size="8" fill="${color}">${label}</text>`}${paths.join("")}</g>`;
  }).join("");
  return { kind, mimeType: "image/svg+xml", width: SVG_WIDTH, height: SVG_HEIGHT,
    content: buildThumbnailSegmentProfile(
      `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="160" viewBox="0 0 256 160" data-thumbnail-bands="1">${compact ? "" : '<rect width="256" height="160" fill="#f8fafc"/>'}${bodyMarkup}</svg>`,
      segments, recordCount ?? Math.max(powers.length, heartRates.length, altitudes.length, speeds.length), { compact }
    ) };
}

function addRouteProfileBands(thumbnail, series) {
  if (!thumbnail?.content || thumbnail.kind !== "route") return thumbnail;
  const profile = buildBandProfileThumbnail({ ...series, gps: true, compact: true });
  if (!profile) return thumbnail;
  const document = load(thumbnail.content, { xml: true });
  if (document("[data-route-profile-bands]").length) return thumbnail;
  const root = document("svg").first();
  const width = Number(root.attr("width")) || thumbnail.width;
  const height = Number(root.attr("height")) || thumbnail.height;
  const profileDocument = load(profile.content, { xml: true });
  const markup = `<g data-route-profile-bands="1"><rect x="${width * 0.0125}" y="${height * 0.64}" width="${width * 0.975}" height="${height * 0.24}" rx="4" fill="#ffffff" fill-opacity="0.6"/><svg x="${width * 0.0125}" y="${height * 0.64}" width="${width * 0.975}" height="${height * 0.24}" viewBox="0 0 256 160" preserveAspectRatio="none">${profileDocument("svg").first().html()}</svg></g>`;
  const mapImage = root.children('image[data-map-provider]').first();
  const background = mapImage.length ? mapImage : root.children('rect').first();
  if (background.length) background.after(markup);
  else root.prepend(markup);
  return { ...thumbnail, content: document.xml() };
}

function resolveProfileSeries(options) {
  const extracted = WorkoutThumbnailService.extractThumbnailSeries(options.workoutObject);
  const series = Object.fromEntries(["powers", "heartRates", "altitudes", "speeds"].map(key =>
    [key, options[key] == null ? extracted[key] : Array.from(options[key])]));
  return { ...series, segments: options.segments || [],
    recordCount: options.recordCount ?? options.workoutObject?.length ?? Math.max(...Object.values(series).map(values => values.length)) };
}

export default class WorkoutThumbnailService {
  static createBandProfileThumbnail(options = {}) {
    return buildBandProfileThumbnail(options);
  }

  static async loadWorkoutSegmentsForThumbnail(workoutId, uid, queryable = pool) {
    const result = await queryable.query(`
      SELECT ws.id, ws.segmenttype, ws.structure_kind, ws.segmentname,
        ws.start_offset, ws.end_offset, ws.pattern_work_duration_seconds,
        ws.pattern_recovery_duration_seconds,
        CASE WHEN ws.structure_kind IN ('intervals', 'microintervals') THEN
          coalesce((SELECT jsonb_agg(jsonb_build_object(
            'position', phase.position, 'phase_kind', phase.phase_kind,
            'repetition_index', phase.repetition_index, 'duration', phase.duration,
            'start_offset', phase.start_offset, 'end_offset', phase.end_offset)
            ORDER BY phase.position)
            FROM workout_segment_phases phase WHERE phase.segment_id = ws.id), '[]'::jsonb)
          ELSE '[]'::jsonb END AS phases
      FROM workout_segments ws WHERE ws.wid = $1 AND ws.uid = $2
      ORDER BY ws.start_offset, ws.end_offset`, [workoutId, uid]);
    return result.rows;
  }

  static extractThumbnailSeries(workoutObject = null) {
    if (!workoutObject?.length || workoutObject.length < 2) {
      return {
        altitudes: [],
        powers: [],
        heartRates: [],
        cadences: [],
        speeds: []
      };
    }

    const altitudes = [];
    const powers = [];
    const heartRates = [];
    const cadences = [];
    const speeds = [];
    const readMetric = (method, index) => {
      const value = typeof workoutObject[method] === "function" ? workoutObject[method](index) : null;
      return value == null ? Number.NaN : Number(value);
    };
    for (let i = 0; i < workoutObject.length; i++) {
      altitudes.push(readMetric("getAltitudeAt", i));
      powers.push(readMetric("getPowerAt", i));
      heartRates.push(readMetric("getHrAt", i));
      cadences.push(readMetric("getCadenceAt", i));
      speeds.push(readMetric("getSpeedAt", i));
    }

    return {
      altitudes,
      powers,
      heartRates,
      cadences,
      speeds
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
    cadences = null,
    speeds = null,
    segments = null,
    recordCount = null,
    profileStyle = "bands"
  } = {}) {
    if (profileStyle !== "lines") {
      const series = resolveProfileSeries({ workoutObject, altitudes, powers, heartRates, speeds, segments, recordCount });
      if (String(workoutType || "").toLowerCase() !== "indoor") {
        const route = buildRouteThumbnail(gpsTrackSegments, gpsTrack, segmentOverlays);
        if (route) return addRouteProfileBands(route, series);
      }
      return buildBandProfileThumbnail({ ...series,
        kind: String(workoutType || "").toLowerCase() === "indoor" ? "indoor-profile" : "metrics-profile" });
    }
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

  static async createThumbnailPayloadAsync(options = {}, { renderRoute = getLocalThumbnailMapConfig().enabled
    ? renderLocalRouteThumbnail : renderGeoapifyRouteThumbnail } = {}) {
    const fallback = WorkoutThumbnailService.createThumbnailPayload(options);
    if (fallback?.kind !== "route") {
      return fallback;
    }
    const revision = getLocalThumbnailMapConfig().enabled ? LocalThumbnailMapService.getRevision() : null;
    try {
      const rendered = await renderRoute(options, fallback) || fallback;
      return options.profileStyle === "lines" ? rendered : addRouteProfileBands(rendered, resolveProfileSeries(options));
    } catch (error) {
      console.warn("[thumbnail] map.render.failed", { reason: "render-error" });
      return revision ? annotateLocalRouteFallback(fallback, error, revision) : fallback;
    }
  }

  static async getOrCreateThumbnail(workoutId, createPayload, { replaceExisting = false, connectionFactory = () => pool.connect() } = {}) {
    const id = Number(workoutId);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    if (!replaceExisting && thumbnailGenerationInflight.has(id)) {
      return thumbnailGenerationInflight.get(id);
    }
    const queuedAt = performance.now();
    const generation = thumbnailGenerationLimit(async () => {
      const startedAt = performance.now();
      const connection = await connectionFactory();
      const acquiredAt = performance.now();
      const timing = { generationQueueMs: startedAt - queuedAt, dbConnectionWaitMs: acquiredAt - startedAt,
        transactionBeginMs: 0, advisoryLockMs: 0, lockedLookupMs: 0, payloadCreateMs: 0 };
      const query = connection.query.bind(connection);
      try {
        await query("BEGIN");
        await query("SET LOCAL lock_timeout = '30s'");
        timing.transactionBeginMs = performance.now() - acquiredAt;
        let stepStartedAt = performance.now();
        await query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`woa:thumbnail:${id}`]);
        timing.advisoryLockMs = performance.now() - stepStartedAt;
        stepStartedAt = performance.now();
        const existing = await WorkoutThumbnailService.getThumbnail(id, query);
        timing.lockedLookupMs = performance.now() - stepStartedAt;
        if (!replaceExisting && existing?.content && WorkoutThumbnailService.isCurrentRouteThumbnail(existing)) {
          await query("COMMIT");
          return existing;
        }
        stepStartedAt = performance.now();
        let payload = await createPayload();
        timing.payloadCreateMs = performance.now() - stepStartedAt;
        const failure = getLocalThumbnailMapConfig().enabled ? localFallbackMetadata(payload) : null;
        const previousFailure = failure ? localFallbackMetadata(existing) : null;
        if (!replaceExisting && failure?.state === "temporary-failure" && previousFailure?.state === "temporary-failure"
          && failure.revision === previousFailure.revision) {
          const attempt = Math.min(3, previousFailure.attempt + 1);
          const retryAt = localRetryDeadline(attempt);
          payload = { ...payload,
            content: payload.content.replace(/\bdata-local-map-attempt="[1-3]"/, `data-local-map-attempt="${attempt}"`)
              .replace(/\bdata-map-retry-at="\d+"/, `data-map-retry-at="${retryAt}"`),
            renderStats: { ...payload.renderStats, localMapAttempt: attempt, mapRetryAt: retryAt } };
        }
        if (!payload?.content) {
          await query("COMMIT");
          return null;
        }
        const persistStartedAt = performance.now();
        const persisted = await WorkoutThumbnailService.upsertThumbnail(id, payload, query);
        await query("COMMIT");
        const completedAt = performance.now();
        const generationProfile = payload.kind === "route" ? { ...payload.generationProfile, ...timing,
          persistThumbnailMs: completedAt - persistStartedAt, dbConnectionHeldMs: completedAt - acquiredAt,
          generationEndToEndMs: completedAt - queuedAt } : payload.generationProfile;
        console.info("[thumbnail] persist.profile", {
          workoutId: id,
          kind: payload.kind,
          persistThumbnailMs: completedAt - persistStartedAt,
          ...(payload.kind === "route" ? generationProfile : {}),
          persisted: true,
          fallbackReason: payload.renderStats?.mapFallbackReason || null,
          retryAt: payload.renderStats?.mapRetryAt || null
        });
        return { ...payload, ...persisted, workoutId: id, ...(generationProfile ? { generationProfile } : {}) };
      } catch (error) {
        await query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        connection.release();
      }
    });
    if (!replaceExisting) thumbnailGenerationInflight.set(id, generation);
    try {
      return await generation;
    } finally {
      if (thumbnailGenerationInflight.get(id) === generation) thumbnailGenerationInflight.delete(id);
    }
  }

  static async upsertThumbnail(workoutId, payload, query = pool.query.bind(pool)) {
    if (!Number.isInteger(Number(workoutId)) || !payload?.content) {
      return null;
    }

    const result = await query(
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

  static async getThumbnail(workoutId, query = pool.query.bind(pool)) {
    const result = await query(
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

  static hasMapBackground(thumbnail) {
    return thumbnail?.kind === "route"
      && /data-map-provider="(?:geoapify|local)"/.test(String(thumbnail.content || ""));
  }

  static getThumbnailCacheControl(thumbnail) {
    return thumbnail?.kind === "route" && !WorkoutThumbnailService.hasMapBackground(thumbnail)
      ? "private, max-age=60"
      : "private, max-age=31536000, immutable";
  }

  static isCurrentRouteThumbnail(thumbnail, now = Date.now()) {
    if (getLocalThumbnailMapConfig().enabled && thumbnail?.content) {
      if (thumbnail.kind !== "route" || WorkoutThumbnailService.hasMapBackground(thumbnail)) return true;
      const failure = localFallbackMetadata(thumbnail);
      if (!failure || failure.state === "unsupported-route") return true;
      if (failure.revision !== LocalThumbnailMapService.getRevision()) return false;
      return failure.state === "missing-coverage" || failure.attempt >= 3 || now < failure.retryAt;
    }
    if (thumbnail?.kind !== "route") {
      return true;
    }

    if (!String(thumbnail.content || "").includes(
      `data-thumbnail-style="${WORKOUT_ROUTE_THUMBNAIL_STYLE_VERSION}"`
    )) return false;
    if (WorkoutThumbnailService.hasMapBackground(thumbnail)) return true;
    const retryAt = Number(String(thumbnail.content || "").match(/\bdata-map-retry-at="(\d+)"/)?.[1]);
    if (Number.isSafeInteger(retryAt) && retryAt > 0) return now < retryAt;
    const updatedAt = new Date(thumbnail.updatedAt ?? thumbnail.updated_at ?? NaN).getTime();
    return Number.isFinite(updatedAt) && now < updatedAt + FALLBACK_RETRY_MS;
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

  static async generateThumbnailForWorkout(workoutId, { skipExistingCheck = false, connectionFactory = () => pool.connect(),
    localMapClient = LocalThumbnailMapService, localMapConfig = getLocalThumbnailMapConfig() } = {}) {
    const normalizedWorkoutId = Number(workoutId);
    if (!Number.isInteger(normalizedWorkoutId) || normalizedWorkoutId <= 0) {
      return null;
    }

    if (!skipExistingCheck) {
      const existing = await WorkoutThumbnailService.getThumbnail(normalizedWorkoutId);
      if (existing?.content && WorkoutThumbnailService.isCurrentRouteThumbnail(existing)) {
        return existing;
      }
    }

    return WorkoutThumbnailService.getOrCreateThumbnail(normalizedWorkoutId, async () => {
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
        persistThumbnailMode: "transaction",
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
          stream,
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
      let workoutSegments = [];
      const timed = async (profileKey, callback) => {
        const startedAt = performance.now();
        const value = await callback();
        profile[profileKey] = performance.now() - startedAt;
        return value;
      };
      const storedSegmentsPromise = timed("loadWorkoutSegmentsMs", () =>
        WorkoutThumbnailService.loadWorkoutSegmentsForThumbnail(normalizedWorkoutId, row.uid));

      if (row.validgps && row.gps_track_blob) {
        const [compactTrack, loadedSegments, candidateResult] = await Promise.all([
          timed("decodeGpsTrackMs", () => GpsTrackBlobService.decodeCompressedCompact(
            row.gps_track_blob,
            {
              codec: row.gps_track_blob_codec || "identity",
              includeSlotIndices: true
            }
          )),
          storedSegmentsPromise,
          timed("loadGpsCandidatesMs", () =>
            SegmentDBService.getMatchingSegmentCandidateIdsForWorkoutsBulk(
              row.uid,
              [normalizedWorkoutId],
              { includeExistingBestEfforts: true }
            ))
        ]);
        workoutSegments = loadedSegments;

        const candidateIds = candidateResult.candidatesByWorkoutId.get(normalizedWorkoutId) || [];
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
          ...workoutSegments,
          ...gpsMatches.map((match) => ({
            segmenttype: "gps",
            start_offset: match.startOffset,
            end_offset: match.endOffset
          }))
        ];
        gpsTrackSegments = buildCompactRouteSegments(compactTrack);
        segmentOverlays = buildCompactSegmentOverlays(compactTrack, ranges);
      } else {
        workoutSegments = await storedSegmentsPromise;
      }
      profile.workoutSegmentCount = workoutSegments.length;
      if (row?.stream) {
        try {
          stepStartedAt = performance.now();
          const rawWorkoutStream = await Workout.decompress(
            row.stream,
            row?.stream_codec || "brotli"
          );
          profile.decompressWorkoutStreamMs = performance.now() - stepStartedAt;
          stepStartedAt = performance.now();
          const series = Workout.getWst9ThumbnailSeries(rawWorkoutStream, { includeProfiles: true });
          profile.decodeWorkoutStreamMs = performance.now() - stepStartedAt;
          profile.thumbnailSeriesMode = "direct-wst9";
          workoutObject = {
            length: series.recordCount,
            getPowerAt: (index) => series.powers[index],
            getHrAt: (index) => series.heartRates[index],
            getCadenceAt: (index) => series.cadences[index],
            getAltitudeAt: (index) => series.altitudes[index],
            getSpeedAt: (index) => series.speeds[index]
          };
        } catch (error) {
          if (!gpsTrackSegments.length) throw error;
          profile.thumbnailSeriesMode = "unavailable";
          console.warn("[thumbnail] profile.stream.failed", { workoutId: normalizedWorkoutId, reason: "invalid-stream" });
        }
      }

      stepStartedAt = performance.now();
      const payload = await WorkoutThumbnailService.createThumbnailPayloadAsync({
        workoutId: normalizedWorkoutId,
        workoutType: row.workout_type,
        gpsTrackSegments,
        segmentOverlays,
        workoutObject,
        segments: workoutSegments,
        localMapClient,
        localMapConfig
      });
      profile.renderSvgMs = performance.now() - stepStartedAt;
      if (payload?.renderStats) {
        Object.assign(profile, payload.renderStats);
      }

      if (!payload) {
        return null;
      }

      profile.totalMs = performance.now() - totalStartedAt;
      return {
        ...payload,
        generationProfile: profile
      };
    }, { connectionFactory });
  }
}
