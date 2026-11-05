import path from "node:path";
import { lstat, stat, statfs, realpath, readdir, mkdir, open, unlink } from "node:fs/promises";

export const MAP_STORAGE_MAX_BYTES = 100 * 1024 ** 3;
export const MAP_STORAGE_VOLUME_FRACTION = 0.50;
const STORAGE_RESERVE_BYTES = 256 * 1024 ** 2;
const pendingWrites = new Map();

export class MapStorageError extends Error {}

export function mapStorageLimit(totalBytes) {
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
    throw new MapStorageError("Map filesystem capacity is unavailable");
  }
  return Math.min(Math.floor(totalBytes * MAP_STORAGE_VOLUME_FRACTION), MAP_STORAGE_MAX_BYTES);
}

async function existingAncestor(directory) {
  let current = path.resolve(directory);
  while (!await stat(current).catch(error => { if (error.code === "ENOENT") return null; throw error; })) {
    const parent = path.dirname(current);
    if (parent === current) throw new MapStorageError("Map filesystem is unavailable");
    current = parent;
  }
  return current;
}

async function canonicalDirectory(directory) {
  const resolved = path.resolve(directory);
  const ancestor = await existingAncestor(resolved);
  return path.join(await realpath(ancestor), path.relative(ancestor, resolved));
}

export async function readMapStorageUsage({ dataDirectory, cacheRoot }, { statfsFn = statfs } = {}) {
  const roots = await Promise.all([dataDirectory, cacheRoot].map(canonicalDirectory));
  const volumes = new Map();
  const rootDevices = new Map();
  async function volumeFor(directory) {
    const ancestor = await existingAncestor(directory);
    const device = String((await stat(ancestor)).dev);
    if (!volumes.has(device)) {
      const filesystem = await statfsFn(ancestor);
      const totalBytes = Number(filesystem.blocks) * Number(filesystem.bsize);
      const freeBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
      if (!Number.isSafeInteger(freeBytes) || freeBytes < 0) throw new MapStorageError("Map free space is unavailable");
      volumes.set(device, { device, totalBytes, freeBytes, limitBytes: mapStorageLimit(totalBytes), usedBytes: 0 });
    }
    return device;
  }
  for (const root of roots) rootDevices.set(root, await volumeFor(root));
  const visited = new Set();
  const cacheEntries = [];
  let usedBytes = 0;
  async function visit(filename) {
    if (visited.has(filename)) return;
    visited.add(filename);
    const details = await lstat(filename).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (!details) return;
    if (details.isSymbolicLink()) throw new MapStorageError("Symbolic links inside map storage are unsupported");
    if (details.isDirectory()) {
      for (const name of await readdir(filename)) await visit(path.join(filename, name));
      return;
    }
    if (!details.isFile()) throw new MapStorageError("Unsupported map storage entry");
    const device = String(details.dev);
    if (!volumes.has(device)) await volumeFor(path.dirname(filename));
    usedBytes += details.size;
    volumes.get(device).usedBytes += details.size;
    if (/^[a-f0-9]{20}\/\d+-\d+-\d+\.json$/.test(path.relative(roots[1], filename))) {
      cacheEntries.push({ filename, device, bytes: details.size, modified: details.mtimeMs });
    }
  }
  for (const root of roots) await visit(root);
  return { usedBytes, limitBytes: Math.min(MAP_STORAGE_MAX_BYTES,
    [...volumes.values()].reduce((sum, volume) => sum + volume.limitBytes, 0)),
  cacheBytes: cacheEntries.reduce((sum, entry) => sum + entry.bytes, 0), volumes: [...volumes.values()],
  dataDevice: rootDevices.get(roots[0]), cacheDevice: rootDevices.get(roots[1]), cacheEntries };
}

export function mapStorageCapacity(usage, additionalBytes, device = usage.dataDevice) {
  if (!Number.isSafeInteger(additionalBytes) || additionalBytes < 0) throw new MapStorageError("Invalid map storage reservation");
  const volume = usage.volumes.find(entry => entry.device === device);
  if (!volume) throw new MapStorageError("Map filesystem is unavailable");
  const cacheBytes = usage.cacheEntries.filter(entry => entry.device === device).reduce((sum, entry) => sum + entry.bytes, 0);
  const requiredFreeBytes = additionalBytes * 1.05 + STORAGE_RESERVE_BYTES;
  const volumesFit = usage.volumes.every(entry => entry.usedBytes + (entry.device === device ? additionalBytes : 0) <= entry.limitBytes);
  const cleanedVolumesFit = usage.volumes.every(entry => entry.usedBytes
    - usage.cacheEntries.filter(cache => cache.device === entry.device).reduce((sum, cache) => sum + cache.bytes, 0)
    + (entry.device === device ? additionalBytes : 0) <= entry.limitBytes);
  return { usedBytes: usage.usedBytes, limitBytes: usage.limitBytes, cacheBytes: usage.cacheBytes,
    availableBytes: Math.max(0, Math.min(MAP_STORAGE_MAX_BYTES - usage.usedBytes, volume.limitBytes - volume.usedBytes)),
    fits: usage.usedBytes + additionalBytes <= MAP_STORAGE_MAX_BYTES
      && volumesFit && volume.freeBytes >= requiredFreeBytes,
    fitsAfterCleanup: usage.usedBytes - usage.cacheBytes + additionalBytes <= MAP_STORAGE_MAX_BYTES
      && cleanedVolumesFit && volume.freeBytes + cacheBytes >= requiredFreeBytes };
}

export async function withMapStorageBudget(config, additionalBytes, operation,
  { cacheWrite = false, statfsFn = statfs, onProgress = (_progress) => {} } = {}) {
  const directory = await canonicalDirectory(config.dataDirectory);
  const previous = pendingWrites.get(directory) || Promise.resolve();
  const task = previous.catch(() => {}).then(async () => {
    await mkdir(directory, { recursive: true });
    const lockPath = path.join(directory, ".maps-storage.lock");
    const lock = await open(lockPath, "wx").catch(error => {
      if (error.code === "EEXIST") throw new MapStorageError("Map storage is busy; check active operations before retrying");
      throw error;
    });
    try {
      const checkCapacity = async bytes => {
        let usage = await readMapStorageUsage(config, { statfsFn });
        const device = cacheWrite ? usage.cacheDevice : usage.dataDevice;
        const entries = usage.cacheEntries.sort((first, second) => first.modified - second.modified);
        let removed = 0;
        while (!mapStorageCapacity(usage, bytes, device).fits && entries.length) {
          const pressure = usage.volumes.find(volume => volume.usedBytes + (volume.device === device ? bytes : 0) > volume.limitBytes
            || volume.device === device && volume.freeBytes < bytes * 1.05 + STORAGE_RESERVE_BYTES);
          const index = pressure ? entries.findIndex(entry => entry.device === pressure.device) : 0;
          if (index < 0) break;
          const [entry] = entries.splice(index, 1);
          await unlink(entry.filename).catch(error => { if (error.code !== "ENOENT") throw error; });
          usage.usedBytes -= entry.bytes;
          usage.cacheBytes -= entry.bytes;
          const volume = usage.volumes.find(candidate => candidate.device === entry.device);
          volume.usedBytes -= entry.bytes;
          volume.freeBytes += entry.bytes;
          removed++;
          onProgress({ phase: "cleanup-cache", completed: removed });
        }
        usage = await readMapStorageUsage(config, { statfsFn });
        const capacity = mapStorageCapacity(usage, bytes, device);
        if (!capacity.fits) throw new MapStorageError("Insufficient map disk space including safety margin or map storage budget exceeded");
        return capacity;
      };
      const capacity = await checkCapacity(additionalBytes);
      return await operation({ capacity, checkCapacity });
    } finally { await lock.close(); await unlink(lockPath); }
  });
  pendingWrites.set(directory, task);
  try { return await task; }
  finally { if (pendingWrites.get(directory) === task) pendingWrites.delete(directory); }
}