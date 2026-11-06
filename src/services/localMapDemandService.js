import { getLocalThumbnailMapConfig } from "../config/storagePaths.js";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readFileSync, lstatSync } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { withMapStorageBudget } from "./localMapStorageService.js";

const DEMAND_FILE = "map-regional-demand.json";

export function readMapDemand(config = getLocalThumbnailMapConfig()) {
  const filename = path.join(config.dataDirectory, DEMAND_FILE);
  try {
    const details = lstatSync(filename);
    if (!details.isFile() || details.size > 128 * 1024) throw new Error("Invalid map demand file");
    const state = JSON.parse(readFileSync(filename, "utf8"));
    if (state.version !== 1 || !state.report || !Array.isArray(state.report.regions)
      || !Number.isFinite(Date.parse(state.report.checkedAt))) throw new Error("Invalid map demand state");
    return state.report;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function saveMapDemand(report, config = getLocalThumbnailMapConfig()) {
  const payload = JSON.stringify({ version: 1, report });
  if (Buffer.byteLength(payload) > 128 * 1024) throw new Error("Map demand state too large");
  return withMapStorageBudget(config, Buffer.byteLength(payload), async () => {
    readMapDemand(config);
    const temporary = path.join(config.dataDirectory, `${DEMAND_FILE}.${randomUUID()}.part`);
    try {
      const output = await open(temporary, "wx", 0o600);
      try { await output.writeFile(payload); await output.sync(); } finally { await output.close(); }
      await rename(temporary, path.join(config.dataDirectory, DEMAND_FILE));
      const directory = await open(config.dataDirectory, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
    return report;
  });
}

export function canAutomaticallyPrepareMaps(report, config, inventory) {
  return config.enabled && config.automaticDownloads && report.readyToPrepare
    && report.storage?.fitsAfterCleanup === true
    && report.archives.some(archive => !archive.existingValid)
    && !report.archives.some(archive => !archive.existingValid && inventory.active.archives.some(entry => entry.id === archive.id));
}

export async function enqueueImportedMapDemand({ enabled = getLocalThumbnailMapConfig().enabled,
  queueLoader = () => import("../queue/postgres-backup-ops-queue.js") } = {}) {
  if (!enabled) return false;
  try {
    const { postgresBackupOpsQueue: queue } = await queueLoader();
    await queue.add("maps-demand", { automatic: true }, {
      delay: 10000,
      attempts: 3,
      backoff: { type: "exponential", delay: 60000 },
      deduplication: { id: "local-map-import-demand", ttl: 10000, extend: true, replace: true }
    });
    return true;
  } catch {
    console.error("Imported map demand could not be queued; run an admin map scan to recover");
    return false;
  }
}