import path from "node:path";
import { readdir, lstat } from "node:fs/promises";
import { getLocalThumbnailMapConfig } from "../config/storagePaths.js";
import { MapSetupError, fetchMapCatalog, discoverMapArchive, compareMapArchiveMetadata } from "./localMapProvisioningService.js";

export function mapUpdateStateKey(qualifiedName) {
  return `${qualifiedName}:map-update-state-v1`;
}

export async function readMapUpdateState(client, key) {
  const raw = await client.get(key);
  if (!raw) return { entries: {}, report: null };
  if (Buffer.byteLength(raw) > 128 * 1024) throw new MapSetupError("Map update state is too large");
  const state = JSON.parse(raw);
  if (state.version !== 1 || !state.entries || typeof state.entries !== "object" || Array.isArray(state.entries)) {
    throw new MapSetupError("Invalid map update state");
  }
  return state;
}

export async function checkLocalMapUpdates(previous = { entries: {} }, {
  dataDirectory = getLocalThumbnailMapConfig().dataDirectory, fetchFn = fetch,
  signal = AbortSignal.timeout(10 * 60 * 1000), now = new Date(),
  catalogLoader = fetchMapCatalog, resolveArchive = discoverMapArchive, onProgress = async (_progress) => {}
} = {}) {
  const filenames = (await readdir(dataDirectory).catch(error => { if (error.code === "ENOENT") return []; throw error; }))
    .filter(filename => filename.endsWith(".mbtiles")).sort();
  if (filenames.length > 16) throw new MapSetupError("Map archive limit exceeded");
  const catalog = filenames.length ? await catalogLoader({ fetchFn, signal }) : { features: [] };
  const regions = new Map(catalog.features.filter(feature => /^[a-z0-9]+(?:[-/][a-z0-9]+)*$/.test(feature.properties?.id))
    .map(feature => [feature.properties.id, feature]));
  const entries = {};
  const results = [];
  for (const [index, filename] of filenames.entries()) {
    signal.throwIfAborted();
    const id = filename.slice(0, -".mbtiles".length).replaceAll("--", "/");
    const feature = regions.get(id);
    await onProgress({ phase: "check-updates", archive: id, completed: index + 1, total: filenames.length });
    const details = await lstat(path.join(dataDirectory, filename), { bigint: true });
    const fingerprint = [details.dev, details.ino, details.size, details.mtimeNs, details.ctimeNs].join(":");
    const before = previous.entries[id];
    const saved = before?.fingerprint === fingerprint ? before : null;
    if (saved) entries[id] = saved;
    let status = "unknown";
    let bytes = null;
    let lastModified = null;
    if (details.isFile() && feature) {
      try {
        const upstream = await resolveArchive(feature, { fetchFn, signal, includeMetadata: true });
        if (!upstream) status = "unavailable";
        else {
          const after = await lstat(path.join(dataDirectory, filename), { bigint: true });
          const afterFingerprint = [after.dev, after.ino, after.size, after.mtimeNs, after.ctimeNs].join(":");
          if (afterFingerprint !== fingerprint) throw new MapSetupError("Local archive changed during update check");
          bytes = upstream.bytes;
          lastModified = "lastModified" in upstream ? upstream.lastModified : null;
          status = compareMapArchiveMetadata(saved?.baseline, upstream);
          const baseline = saved?.baseline;
          entries[id] = { fingerprint, baseline: baseline && (baseline.etag || baseline.lastModified) ? baseline : upstream };
        }
      } catch {
        signal.throwIfAborted();
        status = "error";
      }
    }
    results.push({ id, name: typeof feature?.properties.name === "string" ? feature.properties.name.slice(0, 200) : id,
      status, bytes, lastModified, installedVersion: "unverified" });
  }
  return { version: 1, entries, report: { checkedAt: now.toISOString(), regions: results } };
}

export async function registerMapUpdateSchedule(queue, { enabled = getLocalThumbnailMapConfig().enabled } = {}) {
  if (!enabled) return queue.removeJobScheduler("local-map-monthly-updates");
  return queue.upsertJobScheduler("local-map-monthly-updates", { pattern: "0 3 1 * *", tz: "UTC" }, {
    name: "maps-updates", data: { scheduled: true }
  });
}