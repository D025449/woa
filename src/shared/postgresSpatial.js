const BOX_PATTERN = /^\s*\(\s*([^,]+)\s*,\s*([^)]+)\s*\)\s*,\s*\(\s*([^,]+)\s*,\s*([^)]+)\s*\)\s*$/;

export function normalizeBounds(bounds) {
  const minLat = Number(bounds?.minLat);
  const maxLat = Number(bounds?.maxLat);
  const minLng = Number(bounds?.minLng);
  const maxLng = Number(bounds?.maxLng);
  if (![minLat, maxLat, minLng, maxLng].every(Number.isFinite)) {
    return null;
  }

  return {
    minLat: Math.min(minLat, maxLat),
    maxLat: Math.max(minLat, maxLat),
    minLng: Math.min(minLng, maxLng),
    maxLng: Math.max(minLng, maxLng)
  };
}

export function toPostgresBox(bounds) {
  const normalized = normalizeBounds(bounds);
  if (!normalized) return null;
  return `(${normalized.maxLng},${normalized.maxLat}),(${normalized.minLng},${normalized.minLat})`;
}

export function parsePostgresBox(value) {
  if (value && typeof value === "object" && "minLat" in value) {
    return normalizeBounds(value);
  }

  const match = String(value || "").match(BOX_PATTERN);
  if (!match) return null;
  return normalizeBounds({
    maxLng: match[1],
    maxLat: match[2],
    minLng: match[3],
    minLat: match[4]
  });
}

export function endpointSearchBounds(point, radiusMeters) {
  const lat = Number(point?.lat);
  const lng = Number(point?.lng);
  const radius = Number(radiusMeters);
  if (![lat, lng, radius].every(Number.isFinite) || radius < 0) return null;

  const latDelta = radius / 111320;
  const cosLat = Math.max(0.01, Math.abs(Math.cos((lat * Math.PI) / 180)));
  const lngDelta = radius / (111320 * cosLat);
  return {
    minLat: lat - latDelta,
    maxLat: lat + latDelta,
    minLng: lng - lngDelta,
    maxLng: lng + lngDelta
  };
}
