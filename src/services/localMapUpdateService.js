import { lstat } from "node:fs/promises";
import { getLocalThumbnailMapConfig } from "../config/storagePaths.js";
import { MapSetupError, fetchMapCatalog, discoverMapArchive, compareMapArchiveMetadata } from "./localMapProvisioningService.js";
import { readMapArchiveSet, mapArchivePath, mapArchiveSetIdentity } from "./localMapArchiveSetService.js";

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
  const manifest = readMapArchiveSet(dataDirectory);
  const archives = manifest.active.archives;
  if (archives.length > 16) throw new MapSetupError("Map archive limit exceeded");
  const catalog = archives.length ? await catalogLoader({ fetchFn, signal }) : { features: [] };
  const regions = new Map(catalog.features.filter(feature => /^[a-z0-9]+(?:[-/][a-z0-9]+)*$/.test(feature.properties?.id))
    .map(feature => [feature.properties.id, feature]));
  const entries = {};
  const results = [];
  for (const [index, archive] of archives.entries()) {
    signal.throwIfAborted();
    const id = archive.id;
    const filename = mapArchivePath(dataDirectory, archive);
    const feature = regions.get(id);
    await onProgress({ phase: "check-updates", archive: id, completed: index + 1, total: archives.length });
    const details = await lstat(filename, { bigint: true });
    const fingerprint = [details.dev, details.ino, details.size, details.mtimeNs, details.ctimeNs].join(":");
    const before = previous.entries[id];
    const saved = before?.fingerprint === fingerprint ? before : null;
    if (saved) entries[id] = saved;
    let status = "unknown";
    let bytes = null;
    let lastModified = null;
    let canInstall = false;
    const recorded = Boolean(archive.source && archive.sha256 && archive.fingerprint === fingerprint);
    if (details.isFile() && feature) {
      try {
        const upstream = await resolveArchive(feature, { fetchFn, signal, includeMetadata: true });
        if (!upstream) status = "unavailable";
        else {
          const after = await lstat(filename, { bigint: true });
          const afterFingerprint = [after.dev, after.ino, after.size, after.mtimeNs, after.ctimeNs].join(":");
          if (afterFingerprint !== fingerprint) throw new MapSetupError("Local archive changed during update check");
          bytes = upstream.bytes;
          lastModified = "lastModified" in upstream ? upstream.lastModified : null;
          status = compareMapArchiveMetadata(recorded ? archive.source : saved?.baseline, upstream);
          const baseline = saved?.baseline;
          entries[id] = { fingerprint, current: upstream, baseline: baseline && (baseline.etag || baseline.lastModified) ? baseline : upstream };
          canInstall = Boolean(("etag" in upstream && upstream.etag || lastModified) && (!recorded || status !== "unchanged"));
        }
      } catch {
        signal.throwIfAborted();
        status = "error";
      }
    }
    results.push({ id, name: typeof feature?.properties.name === "string" ? feature.properties.name.slice(0, 200) : id,
      status, bytes, lastModified, canInstall, installedVersion: recorded ? "recorded" : "unverified" });
  }
  return { version: 1, entries, report: { checkedAt: now.toISOString(), identity: mapArchiveSetIdentity(dataDirectory),
    activeSet: manifest.active.id, previousSet: manifest.previous?.id || null, regions: results } };
}

export async function registerMapUpdateSchedule(queue, { enabled = getLocalThumbnailMapConfig().enabled } = {}) {
  if (!enabled) return queue.removeJobScheduler("local-map-monthly-updates");
  return queue.upsertJobScheduler("local-map-monthly-updates", { pattern: "0 3 1 * *", tz: "UTC" }, {
    name: "maps-updates", data: { scheduled: true }
  });
}