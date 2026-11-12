export function project([longitude, latitude]) {
  const sine = Math.sin(Math.max(-85.05112878, Math.min(85.05112878, latitude)) * Math.PI / 180);
  return [(longitude + 180) / 360, 0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI)];
}

export function getLocalMapViewport({ minLat, maxLat, minLng, maxLng }, { scale = 1 } = {}) {
  if (![minLat, maxLat, minLng, maxLng].every(Number.isFinite)
    || minLat > maxLat || minLng > maxLng || Math.abs(minLat) > 85.05112878
    || Math.abs(maxLat) > 85.05112878 || Math.abs(minLng) > 180 || Math.abs(maxLng) > 180
    || maxLng - minLng > 180) throw new Error("Unsupported local map bounds");
  const width = Math.round(320 * scale);
  const height = Math.round(200 * scale);
  const [minX, maxY] = project([minLng, minLat]);
  const [maxX, minY] = project([maxLng, maxLat]);
  const world = Math.min(256 * 2 ** 18, 272 * scale / Math.max(1e-8, maxX - minX), 142 * scale / Math.max(1e-8, maxY - minY));
  const zoom = Math.max(0, Math.min(14, Math.floor(Math.log2(world / 256)) + 1));
  const left = (minX + maxX) / 2 * world - width / 2;
  const top = (minY + maxY) / 2 * world - (height - 12 * scale) / 2;
  return { width, height, zoom, world, left, top };
}

export function getLocalMapCoverageBounds(bounds) {
  const { zoom, world, left, top, width, height } = getLocalMapViewport(bounds);
  const count = 2 ** zoom;
  const tilePixels = world / count;
  const minX = Math.max(0, Math.floor(left / tilePixels));
  const maxX = Math.min(count - 1, Math.floor((left + width - 1e-6) / tilePixels));
  const minY = Math.max(0, Math.floor(top / tilePixels));
  const maxY = Math.min(count - 1, Math.floor((top + height - 1e-6) / tilePixels));
  const latitude = value => Math.atan(Math.sinh(Math.PI * (1 - 2 * value))) * 180 / Math.PI;
  return { minLng: minX / count * 360 - 180, maxLng: (maxX + 1) / count * 360 - 180,
    minLat: latitude((maxY + 1) / count), maxLat: latitude(minY / count), zoom,
    tiles: (maxX - minX + 1) * (maxY - minY + 1) };
}