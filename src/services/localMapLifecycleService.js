import path from "node:path";
import { open, unlink } from "node:fs/promises";
import { getLocalThumbnailMapConfig } from "../config/storagePaths.js";
import { getLocalMapCoverageBounds } from "../shared/localThumbnailMapViewport.js";
import { MapSetupError, prepareMapArchives, inspectMapArchive, mapArchiveMetadata, checkMapArchiveCoverage } from "./localMapProvisioningService.js";
import { readMapArchiveSet, mapArchivePath, mapArchiveSetIdentity, describeMapArchive, activateMapArchiveSet } from "./localMapArchiveSetService.js";

export function validateMapInstallation(snapshot, approvedRegions, now = Date.now()) {
  const checkedAt = Date.parse(snapshot?.report?.checkedAt);
  if (!Number.isFinite(checkedAt) || now - checkedAt > 3600000 || checkedAt > now + 60000
    || !/^[a-f0-9]{64}$/.test(snapshot?.report?.identity || "") || !Array.isArray(approvedRegions)
    || !approvedRegions.length || approvedRegions.length > 16 || new Set(approvedRegions).size !== approvedRegions.length
    || approvedRegions.some(id => typeof id !== "string" || !/^[a-z0-9]+(?:[-/][a-z0-9]+)*$/.test(id)
      || !snapshot.report.regions.some(region => region.id === id && region.canInstall)
      || !snapshot.entries[id]?.current || !(snapshot.entries[id].current.etag || snapshot.entries[id].current.lastModified))) {
    throw new MapSetupError("Update approval expired or invalid; check updates again");
  }
}

function workoutCoverage(workouts) {
  return workouts.map(workout => {
    if (!workout.bounds) throw new MapSetupError("Workout bounds missing; cannot validate archive coverage");
    return { id: workout.id, bounds: getLocalMapCoverageBounds(workout.bounds) };
  });
}

export async function installMapArchiveUpdates(snapshot, approvedRegions, workouts, {
  config = getLocalThumbnailMapConfig(), fetchFn = fetch, signal = undefined, onProgress = (_progress) => {}
} = {}) {
  validateMapInstallation(snapshot, approvedRegions);
  const current = readMapArchiveSet(config.dataDirectory);
  if (mapArchiveSetIdentity(config.dataDirectory) !== snapshot.report.identity) throw new MapSetupError("Active archive set changed; check updates again");
  const archives = approvedRegions.map(id => {
    const entry = current.active.archives.find(archive => archive.id === id);
    if (!entry) throw new MapSetupError("Approved region is no longer active");
    const upstream = snapshot.entries[id].current;
    return { id, filename: entry.filename, url: upstream.url, downloadBytes: upstream.bytes };
  });
  const guardedFetch = async (url, options) => {
    const approved = archives.find(archive => archive.url === String(url));
    if (!approved || options?.method === "HEAD") throw new MapSetupError("Archive changed; check updates again");
    const response = await fetchFn(url, options);
    const expected = snapshot.entries[approved.id].current;
    const received = mapArchiveMetadata(response.headers);
    if (!response.ok || Number(response.headers.get("content-length")) !== expected.bytes
      || expected.etag && expected.etag !== received.etag
      || expected.lastModified && expected.lastModified !== received.lastModified) {
      await response.body?.cancel();
      throw new MapSetupError("Archive version differs from approval; check updates again");
    }
    return response;
  };
  const coverage = workoutCoverage(workouts);
  const result = await prepareMapArchives({ report: { ...config, readyToPrepare: true, archives }, coverage }, {
    versioned: true, forceRegions: approvedRegions, expectedIdentity: snapshot.report.identity,
    fetchFn: guardedFetch, signal, onProgress
  });
  return { checkedAt: new Date().toISOString(), activeSet: result.activeSet, installed: result.created, rolledBack: false };
}

export async function rollbackMapArchives(request, workouts, {
  config = getLocalThumbnailMapConfig(), signal = undefined, onProgress = (_progress) => {}
} = {}) {
  const lockPath = path.join(config.dataDirectory, ".maps-prepare.lock");
  const lock = await open(lockPath, "wx");
  try {
    const manifest = readMapArchiveSet(config.dataDirectory, { checkFiles: false });
    if (!manifest.previous?.archives.length || manifest.previous.id !== request.previousSet
      || mapArchiveSetIdentity(config.dataDirectory) !== request.expectedIdentity) throw new MapSetupError("Rollback target changed; refresh first");
    for (const entry of manifest.previous.archives) {
      signal?.throwIfAborted();
      onProgress({ phase: "verify-rollback", archive: entry.id });
      if (!entry.sha256) throw new MapSetupError("Rollback checksum unavailable");
      await describeMapArchive(config.dataDirectory, entry);
      if (!(await inspectMapArchive(mapArchivePath(config.dataDirectory, entry))).valid) throw new MapSetupError("Rollback archive invalid");
    }
    const uncovered = await checkMapArchiveCoverage(config.dataDirectory, manifest.previous.archives, workoutCoverage(workouts), { signal, onProgress });
    if (uncovered.length) throw new MapSetupError("Rollback coverage incomplete; active set unchanged");
    onProgress({ phase: "activate-set" });
    await activateMapArchiveSet(config, manifest.previous, request.expectedIdentity, manifest.active);
    return { checkedAt: new Date().toISOString(), activeSet: manifest.previous.id, installed: [], rolledBack: true };
  } finally { await lock.close(); await unlink(lockPath); }
}