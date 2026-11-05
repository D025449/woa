import { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';
import { statSync, readdirSync } from 'node:fs';
import { mkdir, readFile, writeFile, rename, readdir, stat, unlink, utimes } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import sharp from 'sharp';
import simplify from 'simplify-js';
import { getLocalThumbnailMapConfig } from '../config/storagePaths.js';
import { MapStorageError, withMapStorageBudget } from './localMapStorageService.js';
import { WORKOUT_ROUTE_COLOR, WORKOUT_ROUTE_THUMBNAIL_STYLE_VERSION } from '../shared/SegmentAppearance.js';
import { project, getLocalMapViewport } from '../shared/localThumbnailMapViewport.js';

export { project };

sharp.cache(false);
sharp.concurrency(1);

export const escapeXml = value => String(value).replace(/[&<>"']/g, character =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);

export class LocalMapRenderer {
  constructor({ dataDirectory = getLocalThumbnailMapConfig().dataDirectory,
    cacheRoot = getLocalThumbnailMapConfig().cacheRoot,
    cacheVersion = 'osm-raster-2', maxMemoryBytes = 16 * 1024 ** 2, maxDiskBytes = 128 * 1024 ** 2 } = {}) {
    this.archives = [];
    try {
      const filenames = readdirSync(dataDirectory).filter(name => name.endsWith('.mbtiles')).sort();
      if (!filenames.length || filenames.length > 16) throw new Error('Invalid local map archive count');
      for (const filename of filenames) {
      const archivePath = path.join(dataDirectory, filename);
      const database = new DatabaseSync(archivePath, { readOnly: true });
      try {
      const metadata = Object.fromEntries(database.prepare('SELECT name, value FROM metadata').all()
        .map(row => [row.name, row.value]));
      if (metadata.format !== 'pbf') throw new Error('Local maps require vector MBTiles');
      const sourceStat = statSync(archivePath);
      this.archives.push({ region: filename.replace(/\.mbtiles$/, ''), database, bytes: sourceStat.size, modified: sourceStat.mtimeMs,
        sourceStamp: `${sourceStat.dev}:${sourceStat.ino}:${sourceStat.ctimeMs}`, metadata,
        statement: database.prepare('SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?') });
      } catch (error) { database.close(); throw error; }
      }
    } catch (error) { this.close(); throw error; }
    this.cacheId = createHash('sha256').update(JSON.stringify({ cacheVersion,
      sources: this.archives.map(({ region, bytes, modified, sourceStamp }) => ({ region, bytes, modified, sourceStamp })) })).digest('hex').slice(0, 20);
    this.cacheDirectory = path.join(cacheRoot, this.cacheId);
    this.storageConfig = { dataDirectory, cacheRoot };
    this.maxMemoryBytes = maxMemoryBytes;
    this.maxDiskBytes = maxDiskBytes;
    this.memory = new Map();
    this.memoryBytes = 0;
    this.pending = new Map();
  }

  close() {
    for (const archive of this.archives) archive.database.close();
  }

  clearMemory() {
    this.memory.clear();
    this.memoryBytes = 0;
  }

  remember(key, entry) {
    const bytes = entry.background.length + Buffer.byteLength(JSON.stringify(entry.labels)) * 2 + 1024;
    const previous = this.memory.get(key);
    if (previous) { this.memoryBytes -= previous.bytes; this.memory.delete(key); }
    if (bytes > this.maxMemoryBytes) return;
    while (this.memoryBytes + bytes > this.maxMemoryBytes && this.memory.size) {
      const oldest = this.memory.keys().next().value;
      this.memoryBytes -= this.memory.get(oldest).bytes;
      this.memory.delete(oldest);
    }
    this.memory.set(key, { entry, bytes });
    this.memoryBytes += bytes;
  }

  async trimDisk() {
    const files = await readdir(this.cacheDirectory);
    const entries = await Promise.all(files.filter(name => name.endsWith('.json')).map(async name => {
      const filename = path.join(this.cacheDirectory, name);
      const details = await stat(filename).catch(() => null);
      return details ? { filename, size: details.size, modified: details.mtimeMs } : null;
    }));
    const sorted = entries.filter(Boolean).sort((first, second) => first.modified - second.modified);
    let bytes = sorted.reduce((sum, entry) => sum + entry.size, 0);
    for (const entry of sorted) {
      if (bytes <= this.maxDiskBytes) break;
      await unlink(entry.filename).catch(error => { if (error.code !== 'ENOENT') throw error; });
      bytes -= entry.size;
    }
  }

  async rasterTile(example, zoom, tileX, tileY, refresh = false) {
    const key = `${zoom}-${tileX}-${tileY}`;
    if (!refresh && this.memory.has(key)) {
      const { entry } = this.memory.get(key);
      this.remember(key, entry);
      return { ...entry, cache: 'memory' };
    }
    if (this.pending.has(key)) return { ...await this.pending.get(key), cache: 'shared' };
    const task = (async () => {
      await mkdir(this.cacheDirectory, { recursive: true });
      const filename = path.join(this.cacheDirectory, `${key}.json`);
      if (!refresh) {
        try {
          const stored = JSON.parse(await readFile(filename, 'utf8'));
          const background = Buffer.from(stored.png, 'base64');
          if (stored.cacheId !== this.cacheId || !Array.isArray(stored.labels)
            || createHash('sha256').update(background).digest('hex') !== stored.checksum) throw new Error('Invalid raster cache entry');
          const metadata = await sharp(background).metadata();
          if (metadata.width !== 256 || metadata.height !== 256 || metadata.format !== 'png') throw new Error('Invalid raster dimensions');
          const entry = { background, labels: stored.labels, regions: stored.regions };
          this.remember(key, entry);
          const now = new Date();
          await utimes(filename, now, now);
          return { ...entry, cache: 'disk' };
        } catch (error) {
          if (!['ENOENT', 'SyntaxError', 'Error'].includes(error.code || error.name)) throw error;
        }
      }
      const world = 256 * 2 ** zoom;
      const result = await this.renderVector(example, { paintLabels: false, format: 'png',
        viewport: { width: 256, height: 256, zoom, world, left: tileX * 256, top: tileY * 256 } });
      const entry = { background: result.background, labels: result.mapLabels, regions: result.stats.regions };
      const stored = JSON.stringify({ cacheId: this.cacheId, png: entry.background.toString('base64'),
        checksum: createHash('sha256').update(entry.background).digest('hex'), labels: entry.labels, regions: entry.regions });
      const temporary = `${filename}.${randomUUID()}.part`;
      try {
        await withMapStorageBudget(this.storageConfig, Buffer.byteLength(stored), async () => {
          await writeFile(temporary, stored);
          await rename(temporary, filename);
          await this.trimDisk();
        }, { cacheWrite: true });
      } catch (error) {
        if (!(error instanceof MapStorageError)) throw error;
      } finally {
        await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
      this.remember(key, entry);
      return { ...entry, cache: 'built' };
    })();
    this.pending.set(key, task);
    try { return await task; } finally { this.pending.delete(key); }
  }

  async render(example, { rasterCache = true, refreshTiles = false } = {}) {
    const started = performance.now();
    const viewport = this.viewport(example);
    if (!rasterCache) {
      const result = await this.renderVector(example, { viewport });
      return this.finish(example, result.background, viewport, { started, ...result.stats });
    }
    const { width, height, zoom, world, left, top } = viewport;
    const tilePixels = world / 2 ** zoom;
    const minTileX = Math.floor(left / tilePixels);
    const minTileY = Math.floor(top / tilePixels);
    const maxTileX = Math.floor((left + width - 1e-6) / tilePixels);
    const maxTileY = Math.floor((top + height - 1e-6) / tilePixels);
    const tileColumns = maxTileX - minTileX + 1;
    const tileRows = maxTileY - minTileY + 1;
    const composites = [];
    const labels = [];
    const sourceRegions = new Set();
    const hits = { memory: 0, disk: 0, built: 0, shared: 0 };
    let missingTiles = 0;
    for (let tileY = minTileY; tileY <= maxTileY; tileY++) {
      for (let tileX = minTileX; tileX <= maxTileX; tileX++) {
        let tile;
        try { tile = await this.rasterTile(example, zoom, tileX, tileY, refreshTiles); }
        catch (error) { if (error.message !== 'No local tiles for this route.') throw error; missingTiles++; continue; }
        hits[tile.cache]++;
        composites.push({ input: tile.background, left: (tileX - minTileX) * 256, top: (tileY - minTileY) * 256 });
        labels.push(...tile.labels.map(label => ({ ...label,
          screenX: label.worldX * world - left, screenY: label.worldY * world - top })));
        for (const region of tile.regions) sourceRegions.add(region);
      }
    }
    if (!composites.length || missingTiles) throw new Error('No local tiles for this route.');
    const tileMs = performance.now() - started;
    const mosaicWidth = tileColumns * 256;
    const mosaicHeight = tileRows * 256;
    const mosaic = await sharp({ create: { width: mosaicWidth, height: mosaicHeight,
      channels: 3, background: '#f2f1e9' } }).composite(composites).raw().toBuffer({ resolveWithObject: true });
    const scale = 256 / tilePixels;
    const cropLeft = Math.max(0, Math.round((left - minTileX * tilePixels) * scale));
    const cropTop = Math.max(0, Math.round((top - minTileY * tilePixels) * scale));
    const cropWidth = Math.min(mosaicWidth - cropLeft, Math.round(width * scale));
    const cropHeight = Math.min(mosaicHeight - cropTop, Math.round(height * scale));
    const { svg: labelSvg, count: labelCount } = this.placeLabels(labels, width, height);
    const background = await sharp(mosaic.data, { raw: { width: mosaicWidth, height: mosaicHeight, channels: mosaic.info.channels } })
      .extract({ left: cropLeft, top: cropTop, width: cropWidth, height: cropHeight })
      .resize(width, height).composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${labelSvg}</svg>`) }])
      .webp({ quality: 55 }).toBuffer();
    return this.finish(example, background, viewport, { started, geometryMs: tileMs, tileMs,
      tiles: composites.length, missingTiles, featureCount: 0, labels: labelCount, cache: hits,
      regions: [...sourceRegions], cacheId: this.cacheId, memoryCacheBytes: this.memoryBytes });
  }

  viewport(example) {
    const points = example.segments.flat();
    if (points.length < 2) throw new Error('Expected a GPS route.');
    if (points.some(point => !Number.isFinite(point[0]) || !Number.isFinite(point[1])
      || Math.abs(point[0]) > 180 || Math.abs(point[1]) > 85.05112878)) throw new Error('Unsupported local map route');
    return getLocalMapViewport({ minLng: Math.min(...points.map(point => point[0])),
      maxLng: Math.max(...points.map(point => point[0])), minLat: Math.min(...points.map(point => point[1])),
      maxLat: Math.max(...points.map(point => point[1])) });
  }

  async renderVector(example, { viewport = this.viewport(example),
    paintLabels = true, format = 'webp' } = {}) {
    const started = performance.now();
    const { width, height, zoom, world, left, top } = viewport;
    const count = 2 ** zoom;
    const tilePixels = world / count;
    const tiles = [];
    let missingTiles = 0;
    let tileBytes = 0;
    for (let tileY = Math.floor(top / tilePixels); tileY <= Math.floor((top + height - 1e-6) / tilePixels); tileY++) {
      for (let tileX = Math.floor(left / tilePixels); tileX <= Math.floor((left + width - 1e-6) / tilePixels); tileX++) {
        let found = false;
        for (const archive of this.archives) {
          const row = archive.statement.get(zoom, tileX, count - 1 - tileY);
          if (!row) continue;
          found = true;
          if (!(row.tile_data instanceof Uint8Array)) throw new Error('Invalid vector tile data');
          const raw = Buffer.from(row.tile_data);
          tileBytes += raw.length;
          const tile = new VectorTile(new PbfReader(raw[0] === 31 ? gunzipSync(raw) : raw));
          tiles.push({ tile, tileX, tileY, region: archive.region });
        }
        if (!found) missingTiles++;
      }
    }
    if (!tiles.length) throw new Error('No local tiles for this route.');
    const layers = ['land', 'water_polygons', 'water_lines', 'buildings', 'boundaries', 'streets'];
    const landColors = { forest: '#add19e', residential: '#e0dfdf', industrial: '#e8dce8',
      commercial: '#e8dce8', retail: '#f0d7dc', farmland: '#eef0d5', farmyard: '#e9e3ce',
      meadow: '#cdebb0', grass: '#cdebb0', grassland: '#cdebb0', park: '#c8facc',
      recreation_ground: '#c8facc', golf_course: '#cdebb0', orchard: '#aedfa3',
      vineyard: '#b7d99c', scrub: '#b5d8a4', heath: '#d6d99f', sand: '#f5e9c6', beach: '#f5e9c6' };
    const shapes = [];
    const labels = [];
    const definitions = [];
    let featureCount = 0;
    for (let tileIndex = 0; tileIndex < tiles.length; tileIndex++) {
      const entry = tiles[tileIndex];
      definitions.push(`<clipPath id="tile${tileIndex}"><rect x="${entry.tileX * tilePixels - left}" y="${entry.tileY * tilePixels - top}" width="${tilePixels + 0.1}" height="${tilePixels + 0.1}"/></clipPath>`);
    }
    for (const layerName of layers) {
      for (let tileIndex = 0; tileIndex < tiles.length; tileIndex++) {
        const entry = tiles[tileIndex];
        const layer = entry.tile.layers[layerName];
        if (!layer) continue;
        const paths = [];
        for (let featureIndex = 0; featureIndex < layer.length; featureIndex++) {
          const feature = layer.feature(featureIndex);
          const properties = feature.properties;
          const kind = String(properties.kind || '');
          let attributes;
          if (layerName === 'land') {
            if (!landColors[kind]) continue;
            attributes = `fill="${landColors[kind]}"`;
          } else if (layerName === 'water_polygons') attributes = 'fill="#aad3df"';
          else if (layerName === 'water_lines') attributes = `fill="none" stroke="#8ebdce" stroke-width="${kind === 'river' ? 1.2 : 0.6}"`;
          else if (layerName === 'buildings') attributes = 'fill="#d9d0c9"';
          else if (layerName === 'boundaries') attributes = 'fill="none" stroke="#aa8fac" stroke-width="0.7" stroke-dasharray="3 3"';
          else {
            if (properties.rail) continue;
            const roadColors = { motorway: '#e99aa5', trunk: '#f2b497', primary: '#f4d480', secondary: '#f7efa1', tertiary: '#ffffff' };
            const roadWidths = { motorway: 2.8, trunk: 2.5, primary: 2.2, secondary: 1.8, tertiary: 1.4 };
            const stroke = roadColors[kind] || '#ffffff';
            const roadWidth = roadWidths[kind] || 0.8;
            attributes = `fill="none" stroke="${stroke}" stroke-width="${roadWidth}" stroke-linejoin="round" stroke-linecap="round"`;
          }
          const geometry = feature.loadGeometry();
          const path = geometry.map(ring => ring.map((point, index) => {
            const screenX = (entry.tileX + point.x / layer.extent) * tilePixels - left;
            const screenY = (entry.tileY + point.y / layer.extent) * tilePixels - top;
            return `${index ? 'L' : 'M'}${screenX.toFixed(2)},${screenY.toFixed(2)}`;
          }).join(' ') + (feature.type === 3 ? 'Z' : '')).join(' ');
          if (layerName === 'streets' && ['motorway', 'trunk', 'primary', 'secondary', 'tertiary'].includes(kind)) {
            paths.push(`<path d="${path}" fill="none" stroke="#b6b3ab" stroke-width="${({ motorway: 2.8, trunk: 2.5, primary: 2.2, secondary: 1.8, tertiary: 1.4 })[kind] + 0.65}"/>`);
          }
          paths.push(`<path d="${path}" ${attributes} fill-rule="evenodd"/>`);
          featureCount++;
        }
        shapes.push(`<g clip-path="url(#tile${tileIndex})">${paths.join('')}</g>`);
      }
    }
    for (const entry of tiles) {
      const layer = entry.tile.layers.place_labels;
      if (!layer) continue;
      for (let featureIndex = 0; featureIndex < layer.length; featureIndex++) {
        const feature = layer.feature(featureIndex);
        if (!['city', 'town', 'village', 'state_capital', 'capital'].includes(String(feature.properties.kind))) continue;
        const name = feature.properties.name_de || feature.properties.name;
        if (!name) continue;
        const point = feature.loadGeometry()[0][0];
        labels.push({ name, population: Number(feature.properties.population || 0),
          screenX: (entry.tileX + point.x / layer.extent) * tilePixels - left,
          screenY: (entry.tileY + point.y / layer.extent) * tilePixels - top });
      }
    }
    const mapLabels = labels.map(label => ({ name: label.name, population: label.population,
      worldX: (label.screenX + left) / world, worldY: (label.screenY + top) / world }));
    const placed = paintLabels ? this.placeLabels(labels, width, height) : { svg: '', count: 0 };
    const mapSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs>${definitions.join('')}</defs><rect width="${width}" height="${height}" fill="#f2f1e9"/>${shapes.join('')}${placed.svg}</svg>`;
    const geometryMs = performance.now() - started;
    const image = sharp(Buffer.from(mapSvg));
    const background = await (format === 'png' ? image.png({ compressionLevel: 3 }) : image.webp({ quality: 55 })).toBuffer();
    const stats = { geometryMs, zoom, tiles: tiles.length, tileBytes, missingTiles,
      featureCount, labels: placed.count, regions: [...new Set(tiles.map(tile => tile.region))] };
    return { background, mapLabels, stats };
  }

  placeLabels(labels, width, height) {
    const occupied = [];
    const shapes = [];
    const placedNames = new Set();
    for (const label of labels.sort((first, second) => second.population - first.population)) {
      const textWidth = label.name.length * 4.5;
      const box = [label.screenX - textWidth / 2 - 3, label.screenY - 8, label.screenX + textWidth / 2 + 3, label.screenY + 4];
      if (box[0] < 8 || box[2] > width - 8 || box[1] < 8 || box[3] > height - 28 || placedNames.has(label.name)) continue;
      if (occupied.some(other => box[0] < other[2] && box[2] > other[0] && box[1] < other[3] && box[3] > other[1])) continue;
      occupied.push(box);
      placedNames.add(label.name);
      shapes.push(`<text x="${label.screenX}" y="${label.screenY}" text-anchor="middle" font-family="sans-serif" font-size="8.5" fill="#454545" stroke="#fff" stroke-width="2.5" paint-order="stroke">${escapeXml(label.name)}</text>`);
    }
    return { svg: shapes.join(''), count: occupied.length };
  }

  /** @returns {{svg: string, background: Buffer, stats: Record<string, any>}} */
  finish(example, background, viewport, { started, ...stats }) {
    const { world, left, top, zoom } = viewport;
    const screenSegments = example.segments.map(segment => segment.map(project)
      .map(point => [point[0] * world - left, point[1] * world - top]));
    const reducedSegments = screenSegments.map(segment => simplify(segment.map(point =>
      ({ x: point[0], y: point[1] })), 0.45, true));
    const routePath = reducedSegments.map(segment => segment.map((point, index) =>
      `${index ? 'L' : 'M'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ')).join(' ');
    const overlayMarkup = (example.overlays || []).flatMap(overlay => overlay.segments.map(segment => {
      const points = simplify(segment.map(project).map(point => ({ x: point[0] * world - left, y: point[1] * world - top })), 0.45, true);
      if (points.length < 2) return '';
      const overlayPath = points.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
      return `<path data-segment-type="${escapeXml(overlay.segmenttype)}" d="${overlayPath}" fill="none" stroke="${escapeXml(overlay.color)}" stroke-width="3.5" stroke-linejoin="round" stroke-linecap="round"/>`;
    })).join('');
    const first = screenSegments[0][0];
    const last = screenSegments.at(-1).at(-1);
    const route = `<defs><path id="route" d="${routePath}"/></defs><g fill="none" stroke-linejoin="round" stroke-linecap="round"><use href="#route" stroke="#fff" stroke-width="5"/><use href="#route" stroke="${escapeXml(example.routeColor || WORKOUT_ROUTE_COLOR)}" stroke-width="2.6"/></g>${overlayMarkup}<circle cx="${first[0]}" cy="${first[1]}" r="3" fill="#fff" stroke="#178651" stroke-width="1.5"/><circle cx="${last[0]}" cy="${last[1]}" r="2.7" fill="#d7353c" stroke="#fff" stroke-width="1.3"/>`;
    const attribution = '<rect x="112" y="179" width="200" height="13" fill="#fff" fill-opacity="0.94"/><text x="308" y="188" text-anchor="end" font-family="sans-serif" font-size="8" fill="#34443c">&#169; OpenStreetMap contributors</text>';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200" data-thumbnail-style="${WORKOUT_ROUTE_THUMBNAIL_STYLE_VERSION}"><image data-map-provider="local" width="320" height="200" href="data:image/webp;base64,${background.toString('base64')}"/>${route}${attribution}</svg>`;
    return { svg, background, stats: { ...stats, ms: performance.now() - started, zoom,
      svgBytes: Buffer.byteLength(svg), webpBytes: background.length } };
  }
}