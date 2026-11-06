import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { readdir, lstat, open, unlink } from "node:fs/promises";
import { unlinkSync, openSync, closeSync, fsyncSync } from "node:fs";
import { getLocalThumbnailMapConfig } from "../config/storagePaths.js";
import { readMapArchiveSet, mapArchivePath, mapArchiveFingerprint, mapArchiveSetIdentity,
  describeMapArchive, activateMapArchiveSet } from "./localMapArchiveSetService.js";
import { withMapStorageLock } from "./localMapStorageService.js";
import { readReservedMapFiles, withMapReaderGate } from "./localMapReaderService.js";
import { inspectMapArchive, checkMapArchiveCoverage, MapSetupError, fetchMapCatalog,
  mapCatalogRegions, findMapRegionHits } from "./localMapProvisioningService.js";
import { getLocalMapCoverageBounds } from "../shared/localThumbnailMapViewport.js";

function digest(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

function workoutIdentity(workouts) { return digest(workouts.map(workout => [workout.id, workout.bounds])); }

export function mapCleanupIdentity(directory) {
  const manifest = readMapArchiveSet(directory);
  return digest([manifest, mapArchiveSetIdentity(directory)]);
}

async function withPreparationLock(directory, operation) {
  const filename = path.join(directory, ".maps-prepare.lock");
  const descriptor = await open(filename, "wx", 0o600);
  try { return await operation(); }
  finally { await descriptor.close(); await unlink(filename); }
}

export function validateMapCleanupApproval(snapshot, request, now = Date.now()) {
  const timestamp = Date.parse(snapshot?.checkedAt);
  if (!Number.isFinite(timestamp) || now - timestamp > 3600000 || timestamp > now + 60000
    || request?.identity !== snapshot.identity || !/^[a-f0-9]{64}$/.test(snapshot?.identity || "")) {
    throw new MapSetupError("Cleanup approval changed or expired; scan again");
  }
}

export async function scanMapCleanup({ config = getLocalThumbnailMapConfig(), now = new Date() } = {}) {
  const directory = config.dataDirectory;
  const manifest = readMapArchiveSet(directory);
  const protectedFiles = new Set([...manifest.active.archives, ...(manifest.previous?.archives || [])].map(entry => entry.filename));
  const readers = withMapReaderGate(directory, () => readReservedMapFiles(directory));
  const files = [];
  async function visit(relativeDirectory = "") {
    for (const name of await readdir(path.join(directory, relativeDirectory))) {
      const relative = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const details = await lstat(path.join(directory, relative));
      if (!details.isFile() && !details.isDirectory()) continue;
      if (details.isDirectory()) {
        if (relative === "versions" || /^versions\/[a-f0-9-]{36}$/.test(relative)) await visit(relative);
        continue;
      }
      if (!name.endsWith(".mbtiles")) continue;
      const id = name.slice(0, -8).replaceAll("--", "/");
      try { mapArchivePath(directory, { id, filename: relative }); } catch { continue; }
      if (!manifest.managed || protectedFiles.has(relative)) continue;
      files.push({ id, filename: relative, bytes: details.size,
        fingerprint: mapArchiveFingerprint(path.join(directory, relative)), protectedByReader: readers.has(relative) });
    }
  }
  await visit();
  files.sort((first, second) => first.filename.localeCompare(second.filename));
  return { checkedAt: now.toISOString(), identity: mapCleanupIdentity(directory), files,
    reclaimableBytes: files.filter(file => !file.protectedByReader).reduce((sum, file) => sum + file.bytes, 0) };
}

export async function deleteUnusedMapFiles(snapshot, request, {
  config = getLocalThumbnailMapConfig(), signal = undefined, onProgress = (_progress) => {}
} = {}) {
  validateMapCleanupApproval(snapshot, request);
  const approved = snapshot.files.filter(file => !file.protectedByReader);
  if (!approved.length) throw new MapSetupError("No approved unused map files");
  return withPreparationLock(config.dataDirectory, () => withMapStorageLock(config, async () => {
    if (mapCleanupIdentity(config.dataDirectory) !== snapshot.identity) throw new MapSetupError("Archive references changed; scan again");
    return withMapReaderGate(config.dataDirectory, () => {
      const reserved = readReservedMapFiles(config.dataDirectory);
      const manifest = readMapArchiveSet(config.dataDirectory);
      const referenced = new Set([...manifest.active.archives, ...(manifest.previous?.archives || [])].map(entry => entry.filename));
      for (const file of approved) {
        signal?.throwIfAborted();
        if (!manifest.managed || referenced.has(file.filename) || reserved.has(file.filename)
          || mapArchiveFingerprint(mapArchivePath(config.dataDirectory, file)) !== file.fingerprint) {
          throw new MapSetupError("Cleanup files changed or in use; scan again");
        }
      }
      let removedBytes = 0;
      const directories = new Set();
      for (const [index, file] of approved.entries()) {
        signal?.throwIfAborted();
        const filename = mapArchivePath(config.dataDirectory, file);
        unlinkSync(filename);
        directories.add(path.dirname(filename));
        removedBytes += file.bytes;
        onProgress({ phase: "delete-archive", archive: file.id, completed: index + 1, total: approved.length });
      }
      for (const directory of directories) {
        const descriptor = openSync(directory, "r");
        try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
      }
      return { activeSet: manifest.active.id, removedFiles: approved.length, removedBytes };
    });
  }));
}

export async function scanMapRetirement(workouts, {
  config = getLocalThumbnailMapConfig(), now = new Date(), signal = undefined, onProgress = (_progress) => {},
  catalogLoader = fetchMapCatalog, fetchFn = fetch
} = {}) {
  const directory = config.dataDirectory;
  const identity = mapCleanupIdentity(directory);
  const manifest = readMapArchiveSet(directory);
  const coverage = workouts.map(workout => {
    if (!workout.bounds) throw new MapSetupError("Workout bounds missing; retirement blocked");
    return { id: workout.id, bounds: getLocalMapCoverageBounds(workout.bounds) };
  });
  const protectedRegions = new Set();
  let catalogIdentity = null;
  if (coverage.length) {
    onProgress({ phase: "catalog" });
    const catalog = await catalogLoader({ signal, fetchFn });
    const regions = mapCatalogRegions(catalog);
    const byId = new Map(regions.map(region => [region.id, region]));
    catalogIdentity = digest(regions.map(region => [region.id, region.parent, region.feature.geometry]));
    for (const entry of coverage) {
      signal?.throwIfAborted();
      const hits = findMapRegionHits(regions, entry.bounds);
      if (!hits.length) throw new MapSetupError("Workout geography unknown; retirement blocked");
      for (const hit of hits) {
        const visited = new Set();
        let id = hit.id;
        while (id) {
          if (visited.has(id)) throw new MapSetupError("Cyclic region hierarchy");
          visited.add(id);
          protectedRegions.add(id);
          id = byId.get(id)?.parent;
        }
      }
    }
    for (const entry of manifest.active.archives) if (!byId.has(entry.id)) protectedRegions.add(entry.id);
  }
  for (const entry of manifest.active.archives) {
    signal?.throwIfAborted();
    onProgress({ phase: "inspect-required", archive: entry.id });
    if (!(await inspectMapArchive(mapArchivePath(directory, entry))).valid) throw new MapSetupError("Invalid active archive; retirement blocked");
  }
  let remaining = [...manifest.active.archives];
  if ((await checkMapArchiveCoverage(directory, remaining, coverage, { signal, onProgress })).length) {
    throw new MapSetupError("Current map coverage incomplete; retirement blocked");
  }
  const regions = [];
  for (const entry of manifest.active.archives) {
    if (protectedRegions.has(entry.id)) continue;
    const next = remaining.filter(candidate => candidate.id !== entry.id);
    if (!(await checkMapArchiveCoverage(directory, next, coverage, { signal, onProgress })).length) {
      regions.push({ id: entry.id, bytes: Number((await lstat(mapArchivePath(directory, entry))).size) });
      remaining = next;
    }
  }
  if (identity !== mapCleanupIdentity(directory)) throw new MapSetupError("Archive set changed; scan again");
  return { policyVersion: 2, checkedAt: now.toISOString(), identity, workoutIdentity: workoutIdentity(workouts), catalogIdentity,
    protectedRegions: [...protectedRegions].sort(),
    regions, retainedRegions: remaining.map(entry => entry.id), bytes: regions.reduce((sum, region) => sum + region.bytes, 0) };
}

export async function retireMapRegions(snapshot, request, loadWorkouts, {
  config = getLocalThumbnailMapConfig(), signal = undefined, onProgress = (_progress) => {},
  catalogLoader = fetchMapCatalog, fetchFn = fetch
} = {}) {
  validateMapCleanupApproval(snapshot, request);
  if (snapshot.policyVersion !== 2) throw new MapSetupError("Retirement policy changed; scan again");
  if (!snapshot.regions.length) throw new MapSetupError("No approved retirement regions");
  return withPreparationLock(config.dataDirectory, async () => {
    const fresh = await scanMapRetirement(await loadWorkouts(), { config, signal, onProgress, catalogLoader, fetchFn });
    if (fresh.identity !== snapshot.identity || fresh.workoutIdentity !== snapshot.workoutIdentity
      || fresh.catalogIdentity !== snapshot.catalogIdentity
      || JSON.stringify(fresh.regions) !== JSON.stringify(snapshot.regions)) throw new MapSetupError("Map demand changed; scan again");
    const manifest = readMapArchiveSet(config.dataDirectory);
    const previous = { ...manifest.active, archives: await Promise.all(manifest.active.archives.map(entry => describeMapArchive(config.dataDirectory, entry))) };
    if (workoutIdentity(await loadWorkouts()) !== snapshot.workoutIdentity) throw new MapSetupError("Map demand changed during validation; scan again");
    const removed = new Set(snapshot.regions.map(region => region.id));
    const active = { id: randomUUID(), archives: previous.archives.filter(entry => !removed.has(entry.id)) };
    onProgress({ phase: "activate-set" });
    await activateMapArchiveSet(config, active, mapArchiveSetIdentity(config.dataDirectory), previous);
    return { activeSet: active.id, retired: [...removed], removedBytes: 0 };
  });
}