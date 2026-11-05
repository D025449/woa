import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
export const MAP_OPERATIONS = new Set(["maps-scan", "maps-prepare"]);

export function validateMapApproval(report, approvedRegions) {
  if (!Array.isArray(approvedRegions) || !approvedRegions.length || approvedRegions.length > 16
    || approvedRegions.some(id => typeof id !== "string" || id.length > 160 || !/^[a-z0-9]+(?:[-/][a-z0-9]+)*$/.test(id))) {
    throw new Error("Invalid map region approval");
  }
  if (report.archives.some(archive => !archive.existingValid && !approvedRegions.includes(archive.id))) {
    throw new Error("Map demand changed; check and approve the new regions first");
  }
}

export async function executeMapOperation(job, { spawnFn = spawn } = {}) {
  if (!MAP_OPERATIONS.has(job.name)) throw new Error("Unsupported map operation");
  if (job.name === "maps-prepare") validateMapApproval({ archives: [] }, job.data.approvedRegions);
  const command = job.name === "maps-scan" ? "plan" : "prepare";
  const args = ["--", path.join(projectRoot, "src/scripts/prepare-local-maps.js"), command,
    "--env-file", path.join(projectRoot, `.env.${process.env.NODE_ENV || "development"}`), "--json"];
  if (command === "prepare") args.push("--approved-regions", job.data.approvedRegions.join(","));
  await job.updateProgress({ phase: "starting" });
  const child = spawnFn(process.execPath, args, { cwd: projectRoot, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let pending = "";
  let updates = Promise.resolve();
  let lastUpdate = 0;
  let tooLarge = false;
  let lastProgress = null;
  let failureTag = "";
  child.stdout.on("data", chunk => {
    if (tooLarge) return;
    output += chunk.toString();
    if (Buffer.byteLength(output) > 8 * 1024 ** 2) { tooLarge = true; child.kill("SIGKILL"); }
  });
  child.stderr.on("data", chunk => {
    pending = (pending + chunk.toString()).slice(-16384);
    const lines = pending.split(/\r?\n/);
    pending = lines.pop();
    for (const line of lines) {
      const failure = line.match(/\[stage=([a-z-]+), code=([A-Z0-9_]+)\]$/);
      if (failure) failureTag = ` [stage=${failure[1]}, code=${failure[2]}]`;
      const match = line.match(/^\[maps\] ([a-z-]+)(?: archive=([a-z0-9/-]+))?(?: attempt=(\d)\/3)?(?: (\d+)\/(\d+)(?: bytes \(([\d.]+)%\))?)?$/);
      if (!match) continue;
      const progress = { phase: match[1], archive: match[2] || null, attempt: Number(match[3]) || null,
        completed: match[4] === undefined ? null : Number(match[4]), total: match[5] === undefined ? null : Number(match[5]),
        percent: match[6] === undefined ? null : Number(match[6]) };
      const changed = lastProgress?.phase !== progress.phase || lastProgress?.archive !== progress.archive;
      lastProgress = progress;
      if (changed || Date.now() - lastUpdate >= 1000) {
        lastUpdate = Date.now();
        updates = updates.then(() => job.updateProgress(progress)).catch(() => {});
      }
    }
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", () => reject(new Error("Map command could not be started")));
    child.once("close", code => resolve(code));
  });
  await updates;
  if (tooLarge || ![0, 2].includes(exitCode)) throw new Error(`Map operation failed${failureTag}; check the map CLI on the server for diagnostics`);
  let report;
  try { report = JSON.parse(output); }
  catch { throw new Error("Map command returned an invalid report"); }
  const summary = summarizeMapDemand(report);
  await job.updateProgress({ phase: "completed", percent: 100 });
  return summary;
}

export function summarizeMapDemand(report, now = new Date()) {
  const created = new Set(report.preparation?.created || []);
  const regions = report.archives.map(archive => ({
    id: archive.id,
    name: archive.name,
    status: archive.existingValid || created.has(archive.id) ? "available" : "missing",
    bytes: archive.existingValid ? archive.existingBytes : archive.downloadBytes,
    workouts: archive.workouts,
    missingThumbnails: archive.missingThumbnails
  }));
  return {
    checkedAt: now.toISOString(),
    gpsWorkouts: report.gpsWorkouts,
    missingThumbnails: report.missingThumbnails,
    missingBounds: report.missingBounds.length,
    unsupportedBounds: report.unsupportedBounds.length,
    unmappedWorkouts: report.unmappedWorkouts.length,
    invalidArchives: report.invalidUnneededArchives.length,
    missingTileWorkouts: report.preparation?.uncoveredWorkouts?.length || 0,
    archiveCount: report.archiveCountAfterPrepare,
    archiveLimit: report.archiveLimit,
    freeDiskBytes: report.freeDiskBytes,
    downloadBytes: regions.filter(region => region.status === "missing").reduce((sum, region) => sum + region.bytes, 0),
    readyToPrepare: report.readyToPrepare,
    readyToActivate: report.preparation?.readyToActivate === true,
    regions
  };
}