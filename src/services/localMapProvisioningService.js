import path from "node:path";
import { mkdir, readdir, stat, statfs, open, unlink, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { load } from "cheerio";
import bbox from "@turf/bbox";
import bboxPolygon from "@turf/bbox-polygon";
import booleanIntersects from "@turf/boolean-intersects";
import intersect from "@turf/intersect";
import difference from "@turf/difference";
import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import { getLocalMapCoverageBounds, project } from "../shared/localThumbnailMapViewport.js";
import { getLocalThumbnailMapConfig } from "../config/storagePaths.js";
import { MapStorageError, readMapStorageUsage, mapStorageCapacity, withMapStorageBudget } from "./localMapStorageService.js";

/** @typedef {{phase: string, archive?: string, completed?: number, total?: number, bytes?: number, totalBytes?: number, attempt?: number}} MapProgress */
/** @typedef {{fetchFn?: typeof fetch, signal?: AbortSignal, onProgress?: (progress: MapProgress) => void}} MapFetchOptions */

const CATALOG_URL = "https://download.geofabrik.de/index-v1.json";
const ARCHIVE_LIMIT = 16;
const planArchiveInspections = new WeakMap();

export class MapSetupError extends Error {}

function archiveResponseFailure(archive, response) {
  const id = typeof archive.id === "string" && archive.id.length <= 160
    && /^[a-z0-9]+(?:[-/][a-z0-9]+)*$/.test(archive.id) ? archive.id : "unknown";
  const expected = Number.isSafeInteger(archive.downloadBytes) && archive.downloadBytes >= 0 ? archive.downloadBytes : "invalid";
  const length = response.headers.get("content-length");
  const reported = length === null ? "missing" : /^\d+$/.test(length) && Number.isSafeInteger(Number(length))
    ? Number(length) : "invalid";
  const rawEncoding = response.headers.get("content-encoding");
  const encoding = !rawEncoding ? "none" : ["gzip", "br", "deflate", "identity", "zstd"].includes(rawEncoding.toLowerCase())
    ? rawEncoding.toLowerCase() : "other";
  const reasons = [];
  if (!response.ok) reasons.push("http-status");
  if (!response.body) reasons.push("missing-body");
  if (rawEncoding) reasons.push("content-encoding");
  if (Number(length) !== archive.downloadBytes) reasons.push(length === null ? "missing-length" : "size-mismatch");
  const status = Number.isInteger(response.status) && response.status >= 0 && response.status <= 599 ? response.status : "invalid";
  return new MapSetupError(`Archive response changed or invalid; rerun maps:plan [archive=${id}, http=${status}, expectedBytes=${expected}, reportedBytes=${reported}, body=${response.body ? "present" : "missing"}, encoding=${encoding}, reason=${reasons.join("+")}]`);
}

function officialUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "download.geofabrik.de"
    || url.username || url.password || url.port || url.search || url.hash) throw new MapSetupError("Invalid Geofabrik URL");
  return url.href;
}

async function archiveDownloadResponse(archive, { fetchFn, signal, directory, remainingBytes, onProgress, checkStorage }) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    signal.throwIfAborted();
    onProgress({ phase: "download-request", archive: archive.id, attempt });
    const response = await fetchFn(officialUrl(archive.url), { redirect: "error", signal, cache: "no-store" });
    if (response.ok && response.body && !response.headers.get("content-encoding")
      && Number(response.headers.get("content-length")) === archive.downloadBytes) return response;
    const failure = archiveResponseFailure(archive, response);
    const length = response.headers.get("content-length");
    const changed = response.ok && response.body && !response.headers.get("content-encoding")
      && /^\d+$/.test(length || "") && Number.isSafeInteger(Number(length)) && Number(length) > 0
      && Number(length) !== archive.downloadBytes;
    await response.body?.cancel();
    if (!changed || attempt === 3) throw failure;
    onProgress({ phase: "refresh-size", archive: archive.id, attempt: attempt + 1 });
    const metadata = await fetchFn(officialUrl(archive.url), { method: "HEAD", redirect: "error", cache: "no-store",
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) });
    const updatedLength = metadata.headers.get("content-length");
    const bytes = Number(updatedLength);
    await metadata.body?.cancel();
    if (!metadata.ok || metadata.headers.get("content-encoding") || !/^\d+$/.test(updatedLength || "")
      || !Number.isSafeInteger(bytes) || bytes <= 0) throw failure;
    await checkStorage(bytes + remainingBytes);
    if (await freeDiskBytes(directory) < (bytes + remainingBytes) * 1.05 + 256 * 1024 ** 2) {
      throw new MapSetupError("Insufficient map disk space including safety margin");
    }
    archive.downloadBytes = bytes;
  }
  throw new MapSetupError("Archive response retry limit reached");
}

/** @param {string} url @param {MapFetchOptions} options */
async function metadataText(url, { fetchFn = fetch, signal } = {}) {
  const response = await fetchFn(officialUrl(url), { redirect: "error",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) });
  if (response.status === 404) return null;
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new MapSetupError(`Geofabrik metadata HTTP ${response.status}`);
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 32 * 1024 ** 2) throw new MapSetupError("Geofabrik metadata too large");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** @param {MapFetchOptions} options */
export async function fetchMapCatalog(options = {}) {
  const text = await metadataText(CATALOG_URL, options);
  if (!text) throw new MapSetupError("Geofabrik catalog unavailable");
  const catalog = JSON.parse(text);
  if (catalog.type !== "FeatureCollection" || !Array.isArray(catalog.features)) throw new MapSetupError("Invalid Geofabrik catalog");
  return catalog;
}

/** @param {any} region @param {MapFetchOptions} options */
export async function discoverMapArchive(region, { fetchFn = fetch, signal } = {}) {
  const pbfUrl = officialUrl(region.properties.urls?.pbf);
  if (!pbfUrl.endsWith("-latest.osm.pbf")) throw new MapSetupError("Invalid catalog PBF URL");
  const pageUrl = pbfUrl.slice(0, -"-latest.osm.pbf".length) + ".html";
  const html = await metadataText(pageUrl, { fetchFn, signal });
  if (!html) return null;
  const page = load(html);
  const href = page("a[href]").toArray().map(element => page(element).attr("href"))
    .find(value => value && /-shortbread-1\.0\.mbtiles$/.test(value));
  if (!href) return null;
  const url = officialUrl(new URL(href, pageUrl).href);
  const response = await fetchFn(url, { method: "HEAD", redirect: "error",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new MapSetupError(`Geofabrik archive HEAD HTTP ${response.status}`);
  const bytes = Number(response.headers.get("content-length"));
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || response.headers.get("content-encoding")) throw new MapSetupError("Unknown archive download size");
  return { url, bytes };
}

async function archiveFileState(filename) {
  const details = await stat(filename, { bigint: true }).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (!details) return null;
  return { bytes: Number(details.size), fingerprint: [details.dev, details.ino, details.size, details.mtimeNs, details.ctimeNs].join(":") };
}

export async function inspectMapArchive(filename, { fullIntegrityCheck = true } = {}) {
  const details = await archiveFileState(filename);
  if (!details) return { valid: false, bytes: 0 };
  let database;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    database = new DatabaseSync(filename, { readOnly: true });
    if (fullIntegrityCheck) {
      const check = database.prepare("PRAGMA quick_check").get();
      if (Object.values(check)[0] !== "ok") throw new Error("Invalid SQLite archive");
    }
    const format = database.prepare("SELECT value FROM metadata WHERE name='format'").get();
    if (format?.value !== "pbf") throw new Error("Expected vector MBTiles");
    const row = database.prepare("SELECT tile_data FROM tiles LIMIT 1").get();
    if (!(row?.tile_data instanceof Uint8Array)) throw new Error("Missing vector tiles");
    const raw = Buffer.from(row.tile_data);
    const tile = new VectorTile(new PbfReader(raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw));
    if (!Object.keys(tile.layers).some(name => ["land", "streets", "water_polygons"].includes(name))) throw new Error("Expected Shortbread layers");
    const after = await archiveFileState(filename);
    if (after?.fingerprint !== details.fingerprint) throw new Error("Archive changed during validation");
    return { valid: true, bytes: details.bytes, fingerprint: details.fingerprint };
  } catch { return { valid: false, bytes: details.bytes }; }
  finally { database?.close(); }
}

export async function readMapWorkoutBounds(client) {
  await client.query("BEGIN READ ONLY");
  try {
    await client.query("SET LOCAL statement_timeout = '120s'");
    const result = await client.query(`SELECT w.id,
      CASE WHEN w.gps_bounds IS NULL THEN NULL ELSE json_build_object(
        'minLng', (center(w.gps_bounds))[0] - width(w.gps_bounds)/2,
        'maxLng', (center(w.gps_bounds))[0] + width(w.gps_bounds)/2,
        'minLat', (center(w.gps_bounds))[1] - height(w.gps_bounds)/2,
        'maxLat', (center(w.gps_bounds))[1] + height(w.gps_bounds)/2) END AS bounds,
      EXISTS(SELECT 1 FROM workout_thumbnails t WHERE t.workout_id=w.id) AS has_thumbnail
      FROM workouts w WHERE w.validgps=true ORDER BY w.id`);
    await client.query("COMMIT");
    return result.rows;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
}

async function freeDiskBytes(directory) {
  let existing = directory;
  while (!await stat(existing).catch(error => { if (error.code === "ENOENT") return null; throw error; })) {
    const parent = path.dirname(existing);
    if (parent === existing) throw new MapSetupError("Cannot inspect map filesystem");
    existing = parent;
  }
  const filesystem = await statfs(existing);
  return Number(filesystem.bavail) * Number(filesystem.bsize);
}

/**
 * @param {any[]} workouts
 * @param {any} catalog
 * @param {MapFetchOptions & {dataDirectory?: string, cacheRoot?: string, resolveArchive?: typeof discoverMapArchive, inspectArchive?: typeof inspectMapArchive, inspectionMode?: "full" | "sample"}} options
 */
export async function buildMapPlan(workouts, catalog, { dataDirectory = getLocalThumbnailMapConfig().dataDirectory,
  cacheRoot = getLocalThumbnailMapConfig().cacheRoot,
  resolveArchive = discoverMapArchive, inspectArchive = inspectMapArchive, inspectionMode = "full", signal, fetchFn = fetch, onProgress = () => {} } = {}) {
  if (!["full", "sample"].includes(inspectionMode)) throw new MapSetupError("Invalid archive inspection mode");
  const regions = catalog.features.filter(feature => ["Polygon", "MultiPolygon"].includes(feature.geometry?.type)
    && /^[a-z0-9]+(?:[-/][a-z0-9]+)*$/.test(feature.properties?.id) && feature.properties.urls?.pbf)
    .map(feature => ({ feature, bounds: bbox(feature), id: feature.properties.id, parent: feature.properties.parent }));
  if (!regions.length || new Set(regions.map(region => region.id)).size !== regions.length) throw new MapSetupError("Invalid region catalog");
  const byId = new Map(regions.map(region => [region.id, region]));
  const discoveries = new Map();
  async function resolve(region, visited = new Set()) {
    if (visited.has(region.id)) throw new MapSetupError("Cyclic region hierarchy");
    visited.add(region.id);
    if (!discoveries.has(region.id)) {
      onProgress({ phase: "discover-archive", archive: region.id });
      discoveries.set(region.id, await resolveArchive(region.feature, { signal, fetchFn }));
    }
    const archive = discoveries.get(region.id);
    if (archive) return { region, archive };
    const parent = byId.get(region.parent);
    return parent ? resolve(parent, visited) : null;
  }
  const coverage = [];
  const selections = new Map();
  const required = new Map();
  const missingBounds = [];
  const unsupportedBounds = [];
  const unmapped = [];
  for (const [index, workout] of workouts.entries()) {
    if (index % 100 === 0) onProgress({ phase: "plan-bounds", completed: index, total: workouts.length });
    signal?.throwIfAborted();
    if (!workout.bounds) { missingBounds.push(workout.id); continue; }
    let bounds;
    try { bounds = getLocalMapCoverageBounds(workout.bounds); }
    catch { unsupportedBounds.push(workout.id); continue; }
    coverage.push({ id: workout.id, bounds });
    /** @type {[number, number, number, number]} */
    const coordinates = [bounds.minLng, bounds.minLat, bounds.maxLng, bounds.maxLat];
    const key = coordinates.join(",");
    if (!selections.has(key)) {
      const polygon = bboxPolygon(coordinates);
      const hits = regions.filter(region => region.bounds[0] <= bounds.maxLng && region.bounds[2] >= bounds.minLng
        && region.bounds[1] <= bounds.maxLat && region.bounds[3] >= bounds.minLat
        && booleanIntersects(polygon, region.feature));
      const parents = new Set(hits.map(region => region.parent));
      const matches = [];
      const unavailableRegions = [];
      for (const region of hits.filter(entry => !parents.has(entry.id))) {
        const resolved = await resolve(region);
        if (resolved) matches.push(resolved);
        else unavailableRegions.push(region);
      }
      const unavailable = unavailableRegions.some(region => {
        let remaining = intersect({ type: "FeatureCollection", features: [polygon, region.feature] });
        for (const match of matches) {
          if (!remaining) break;
          remaining = difference({ type: "FeatureCollection", features: [remaining, match.region.feature] });
        }
        return Boolean(remaining);
      });
      selections.set(key, { matches, unavailable: unavailable || !matches.length });
    }
    const { matches, unavailable } = selections.get(key);
    if (unavailable) unmapped.push(workout.id);
    for (const { region, archive } of matches) {
      if (!required.has(region.id)) required.set(region.id, { id: region.id, name: region.feature.properties.name,
        url: officialUrl(archive.url), bytes: archive.bytes, workouts: new Set(), missingThumbnails: new Set() });
      const entry = required.get(region.id);
      entry.workouts.add(workout.id);
      if (!workout.has_thumbnail) entry.missingThumbnails.add(workout.id);
    }
  }
  for (const id of [...required.keys()]) {
    let parent = byId.get(id)?.parent;
    const visited = new Set();
    while (parent && byId.has(parent)) {
      if (visited.has(parent)) throw new MapSetupError("Cyclic region hierarchy");
      visited.add(parent);
      if (required.has(parent)) {
        for (const workout of required.get(id).workouts) required.get(parent).workouts.add(workout);
        for (const workout of required.get(id).missingThumbnails) required.get(parent).missingThumbnails.add(workout);
        required.delete(id);
        break;
      }
      parent = byId.get(parent).parent;
    }
  }
  const filenames = (await readdir(dataDirectory).catch(error => { if (error.code === "ENOENT") return []; throw error; }))
    .filter(name => name.endsWith(".mbtiles"));
  const existing = new Map();
  for (const [index, filename] of filenames.entries()) {
    signal?.throwIfAborted();
    onProgress({ phase: "inspect-existing", archive: filename.slice(0, -".mbtiles".length).replaceAll("--", "/"),
      completed: index + 1, total: filenames.length });
    existing.set(filename, await inspectArchive(path.join(dataDirectory, filename), { fullIntegrityCheck: inspectionMode === "full" }));
  }
  const archives = [...required.values()].sort((first, second) => first.id.localeCompare(second.id)).map(entry => {
    const filename = `${entry.id.replaceAll("/", "--")}.mbtiles`;
    return { id: entry.id, name: entry.name, filename, url: entry.url, downloadBytes: entry.bytes,
      existingValid: existing.get(filename)?.valid === true, existingBytes: existing.get(filename)?.bytes || 0,
      integrityChecked: existing.get(filename)?.valid === true && inspectionMode === "full",
      workouts: entry.workouts.size, missingThumbnails: entry.missingThumbnails.size };
  });
  const finalFiles = new Set([...filenames, ...archives.map(entry => entry.filename)]);
  const invalidUnneededArchives = filenames.filter(filename => !existing.get(filename).valid
    && !archives.some(entry => entry.filename === filename));
  const downloadBytes = archives.filter(entry => !entry.existingValid).reduce((sum, entry) => sum + entry.downloadBytes, 0);
  const storage = mapStorageCapacity(await readMapStorageUsage({ dataDirectory, cacheRoot }), downloadBytes);
  const report = { dataDirectory, cacheRoot, storage, inspectionMode, gpsWorkouts: workouts.length,
    missingThumbnails: workouts.filter(workout => !workout.has_thumbnail).length,
    missingBounds, unsupportedBounds, unmappedWorkouts: unmapped, invalidUnneededArchives,
    archives, archiveCountAfterPrepare: finalFiles.size, archiveLimit: ARCHIVE_LIMIT,
    downloadBytes,
    freeDiskBytes: await freeDiskBytes(dataDirectory), readyToPrepare: !missingBounds.length && !unsupportedBounds.length
      && !unmapped.length && !invalidUnneededArchives.length && finalFiles.size <= ARCHIVE_LIMIT };
  const plan = { report, coverage };
  if (inspectionMode === "full") planArchiveInspections.set(plan, existing);
  return plan;
}

/** @param {any} plan @param {MapFetchOptions & {inspectArchive?: typeof inspectMapArchive}} options */
export async function prepareMapArchives(plan, { fetchFn = fetch, signal, onProgress = () => {}, inspectArchive = inspectMapArchive } = {}) {
  const { report, coverage } = plan;
  if (!report.readyToPrepare) throw new MapSetupError("Incomplete map plan; resolve reported bounds/coverage/archive limits first");
  const directory = report.dataDirectory;
  await mkdir(directory, { recursive: true });
  const lockPath = path.join(directory, ".maps-prepare.lock");
  const lock = await open(lockPath, "wx").catch(error => {
    if (error.code === "EEXIST") throw new MapSetupError("Map preparation already locked; check other process before manual cleanup");
    throw error;
  });
  const created = [];
  try {
    const currentFiles = (await readdir(directory)).filter(name => name.endsWith(".mbtiles"));
    if (new Set([...currentFiles, ...report.archives.map(entry => entry.filename)]).size > ARCHIVE_LIMIT) {
      throw new MapSetupError("Map archive count changed beyond renderer limit; rerun maps:plan");
    }
    const missing = [];
    for (const [index, archive] of report.archives.entries()) {
      signal?.throwIfAborted();
      onProgress({ phase: "check-file-state", archive: archive.id, completed: index + 1, total: report.archives.length });
      const filename = path.join(directory, archive.filename);
      const inspected = planArchiveInspections.get(plan)?.get(archive.filename);
      const current = await archiveFileState(filename);
      let valid = inspected?.valid === true && typeof inspected.fingerprint === "string"
        && inspected.fingerprint === current?.fingerprint;
      if (!valid) {
        onProgress({ phase: "inspect-required", archive: archive.id, completed: index + 1, total: report.archives.length });
        valid = (await inspectArchive(filename)).valid;
      }
      if (!valid) missing.push(archive);
      else onProgress({ phase: "reuse", archive: archive.id });
    }
    const needed = missing.reduce((sum, entry) => sum + entry.downloadBytes, 0);
    onProgress({ phase: "storage-budget" });
    await withMapStorageBudget({ dataDirectory: directory, cacheRoot: report.cacheRoot || getLocalThumbnailMapConfig().cacheRoot },
      needed, async ({ checkCapacity }) => {
    for (const [index, original] of missing.entries()) {
      const archive = { ...original };
      signal?.throwIfAborted();
      const destination = path.join(directory, archive.filename);
      const temporary = `${destination}.${randomUUID()}.part`;
      const timeout = AbortSignal.timeout(2 * 60 * 60 * 1000);
      const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      try {
        const response = await archiveDownloadResponse(archive, { fetchFn, signal: requestSignal, directory,
          remainingBytes: missing.slice(index + 1).reduce((sum, entry) => sum + entry.downloadBytes, 0), onProgress,
          checkStorage: checkCapacity });
        const output = await open(temporary, "wx", 0o644);
        let bytes = 0;
        let lastProgress = Date.now();
        onProgress({ phase: "download", archive: archive.id, bytes, totalBytes: archive.downloadBytes });
        try {
          for await (const chunk of response.body) {
            requestSignal.throwIfAborted();
            bytes += chunk.length;
            if (bytes > archive.downloadBytes) throw new MapSetupError("Archive exceeded planned size");
            const buffer = Buffer.from(chunk);
            let offset = 0;
            while (offset < buffer.length) offset += (await output.write(buffer, offset, buffer.length - offset)).bytesWritten;
            if (Date.now() - lastProgress >= 1000) {
              onProgress({ phase: "download", archive: archive.id, bytes, totalBytes: archive.downloadBytes });
              lastProgress = Date.now();
            }
          }
          await output.sync();
        } finally { await output.close(); }
        onProgress({ phase: "download", archive: archive.id, bytes, totalBytes: archive.downloadBytes });
        onProgress({ phase: "verify-download", archive: archive.id });
        if (bytes !== archive.downloadBytes || !(await inspectArchive(temporary)).valid) throw new MapSetupError("Downloaded archive failed size/SQLite/Shortbread validation");
        await rename(temporary, destination);
        created.push(archive.id);
        onProgress({ phase: "installed", archive: archive.id, completed: created.length, total: missing.length });
      } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
    }
    }, { onProgress }).catch(error => {
      if (error instanceof MapStorageError) throw new MapSetupError(error.message);
      throw error;
    });
    const { DatabaseSync } = await import("node:sqlite");
    const databases = [];
    const uncoveredWorkouts = [];
    try {
      for (const filename of (await readdir(directory)).filter(name => name.endsWith(".mbtiles"))) {
        const database = new DatabaseSync(path.join(directory, filename), { readOnly: true });
        databases.push({ database, tile: database.prepare("SELECT 1 FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?") });
      }
      onProgress({ phase: "coverage", completed: 0, total: coverage.length });
      for (const [index, entry] of coverage.entries()) {
        signal?.throwIfAborted();
        const bounds = entry.bounds;
        const count = 2 ** bounds.zoom;
        const minX = Math.round((bounds.minLng + 180) / 360 * count);
        const maxX = Math.round((bounds.maxLng + 180) / 360 * count) - 1;
        const minY = Math.round(project([0, bounds.maxLat])[1] * count);
        const maxY = Math.round(project([0, bounds.minLat])[1] * count) - 1;
        let covered = true;
        for (let tileX = minX; tileX <= maxX; tileX++) for (let tileY = minY; tileY <= maxY; tileY++) {
          if (!databases.some(source => source.tile.get(bounds.zoom, tileX, count - 1 - tileY))) covered = false;
        }
        if (!covered) uncoveredWorkouts.push(entry.id);
        if ((index + 1) % 100 === 0 || index + 1 === coverage.length) {
          onProgress({ phase: "coverage", completed: index + 1, total: coverage.length });
        }
      }
    } finally { for (const source of databases) source.database.close(); }
    const storage = mapStorageCapacity(await readMapStorageUsage({ dataDirectory: directory,
      cacheRoot: report.cacheRoot || getLocalThumbnailMapConfig().cacheRoot }), 0);
    return { storage, created, reused: report.archives.filter(archive => !created.includes(archive.id)).map(archive => archive.id),
      uncoveredWorkouts, readyToActivate: databases.length > 0 && !uncoveredWorkouts.length };
  } finally { await lock.close(); await unlink(lockPath); }
}