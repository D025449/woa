import pool from "./database.js";
import Workout from "../shared/Workout.js";
import GpsTrackBlobService from "./gpsTrackBlobService.js";

const SVG_WIDTH = 256;
const SVG_HEIGHT = 160;
const SVG_PADDING = 14;
const POWER_THUMB_STRONG_SMOOTHING_WINDOW = 35;
const thumbnailGenerationInflight = new Map();

function escapeXml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function createPathFromPoints(points = [], width = SVG_WIDTH, height = SVG_HEIGHT, padding = SVG_PADDING) {
  if (!Array.isArray(points) || points.length < 2) {
    return "";
  }

  const bounds = getPointBounds(points);

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

function buildSvgShell({ title, bodyMarkup, accent = "#2563eb", showAccentBar = true }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_WIDTH}" height="${SVG_HEIGHT}" viewBox="0 0 ${SVG_WIDTH} ${SVG_HEIGHT}" role="img" aria-label="${escapeXml(title)}">
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
  if (Array.isArray(gpsTrackSegments) && gpsTrackSegments.length) {
    return gpsTrackSegments
      .map((segment) => (Array.isArray(segment) ? segment : [])
        .map(([lat, lng]) => ({
          lat: Number(lat),
          lng: Number(lng)
        }))
        .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng)))
      .filter((segment) => segment.length >= 2);
  }

  const fallback = (Array.isArray(gpsTrack) ? gpsTrack : [])
    .map(([lat, lng]) => ({
      lat: Number(lat),
      lng: Number(lng)
    }))
    .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));

  return fallback.length >= 2 ? [fallback] : [];
}

function buildRouteThumbnail(gpsTrackSegments = null, gpsTrack = null) {
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
  const pathMarkup = normalizedSegments
    .map((segment) => segment
      .map((point) => ({
        x: point.lng * longitudeScale,
        y: point.lat
      }))
      .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y)))
    .filter((segment) => segment.length >= 2)
    .map((segment) => `<path d="${createPathFromPoints(segment)}" fill="none" stroke="#dc2626" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>`)
    .join("");
  const bodyMarkup = `
    <rect x="12" y="12" width="${SVG_WIDTH - 24}" height="${SVG_HEIGHT - 24}" rx="16" fill="#dcfce7"/>
    ${pathMarkup}
    <circle cx="${startProjected.x.toFixed(2)}" cy="${startProjected.y.toFixed(2)}" r="5" fill="#ffffff" stroke="#16a34a" stroke-width="2"/>
    <circle cx="${endProjected.x.toFixed(2)}" cy="${endProjected.y.toFixed(2)}" r="5.5" fill="#dc2626" stroke="#ffffff" stroke-width="2"/>
  `;

  return {
    kind: "route",
    mimeType: "image/svg+xml",
    width: SVG_WIDTH,
    height: SVG_HEIGHT,
    content: buildSvgShell({
      title: "Workout route thumbnail",
      bodyMarkup,
      accent: "#16a34a",
      showAccentBar: false
    })
  };
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

export default class WorkoutThumbnailService {
  static extractThumbnailSeries(workoutObject = null) {
    if (!workoutObject?.length || workoutObject.length < 2) {
      return {
        altitudes: [],
        powers: []
      };
    }

    const altitudes = [];
    const powers = [];
    for (let i = 0; i < workoutObject.length; i++) {
      const altitudeValue = typeof workoutObject.getAltitudeAt === "function"
        ? Number(workoutObject.getAltitudeAt(i))
        : null;
      const powerValue = typeof workoutObject.getPowerAt === "function"
        ? Number(workoutObject.getPowerAt(i))
        : null;

      if (Number.isFinite(altitudeValue)) {
        altitudes.push(altitudeValue);
      }
      if (Number.isFinite(powerValue)) {
        powers.push(powerValue);
      }
    }

    return {
      altitudes,
      powers
    };
  }

  static createThumbnailPayload({ gpsTrack = null, gpsTrackSegments = null, workoutObject = null, altitudes = null, powers = null } = {}) {
    if ((Array.isArray(gpsTrackSegments) && gpsTrackSegments.length) || (Array.isArray(gpsTrack) && gpsTrack.length >= 2)) {
      const routeThumb = buildRouteThumbnail(gpsTrackSegments, gpsTrack);
      if (routeThumb) {
        return routeThumb;
      }
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

  static async generateThumbnailForWorkout(workoutId) {
    const normalizedWorkoutId = Number(workoutId);
    if (!Number.isInteger(normalizedWorkoutId) || normalizedWorkoutId <= 0) {
      return null;
    }

    const existing = await WorkoutThumbnailService.getThumbnail(normalizedWorkoutId);
    if (existing?.content) {
      return existing;
    }

    if (thumbnailGenerationInflight.has(normalizedWorkoutId)) {
      return thumbnailGenerationInflight.get(normalizedWorkoutId);
    }

    const generationPromise = (async () => {
      const result = await pool.query(
        `SELECT
          id,
          stream,
          stream_codec,
          gps_track_blob,
          gps_track_blob_codec
         FROM workouts
         WHERE id = $1`,
        [normalizedWorkoutId]
      );

      if (result.rowCount === 0) {
        return null;
      }

      const row = result.rows[0];
      const workoutObject = row?.stream ? await Workout.fromCompressedWithCodec(row.stream, row?.stream_codec || "brotli") : null;
      const decodedTrack = await GpsTrackBlobService.decodeRowTrack(row);
      const gpsTrack = decodedTrack.points.map((point) => [point.lat, point.lng]);
      const gpsTrackSegments = Array.isArray(decodedTrack.segments)
        ? decodedTrack.segments.map((segment) => segment.map((point) => [point.lat, point.lng]))
        : [];
      const payload = WorkoutThumbnailService.createThumbnailPayload({
        gpsTrack,
        gpsTrackSegments,
        workoutObject
      });

      if (!payload) {
        return null;
      }

      const persisted = await WorkoutThumbnailService.upsertThumbnail(normalizedWorkoutId, payload);
      return persisted
        ? {
            ...persisted,
            content: payload.content
          }
        : null;
    })();

    thumbnailGenerationInflight.set(normalizedWorkoutId, generationPromise);

    try {
      return await generationPromise;
    } finally {
      thumbnailGenerationInflight.delete(normalizedWorkoutId);
    }
  }
}
