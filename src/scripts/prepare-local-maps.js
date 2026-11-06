import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import path from "node:path";
import dotenv from "dotenv";
import { Client } from "pg";
import { resolveRuntimeDatabaseEnvironment } from "../../ops/postgres-backup/runtime-database.mjs";
import { getLocalThumbnailMapConfig } from "../config/storagePaths.js";
import { MapSetupError, fetchMapCatalog, readMapWorkoutBounds, buildMapPlan, prepareMapArchives } from "../services/localMapProvisioningService.js";
import { validateMapApproval, summarizeMapDemand } from "../services/localMapAdminService.js";
import { installMapArchiveUpdates, rollbackMapArchives } from "../services/localMapLifecycleService.js";
import { saveMapDemand, canAutomaticallyPrepareMaps } from "../services/localMapDemandService.js";
import { readMapArchiveSet } from "../services/localMapArchiveSetService.js";
import { scanMapCleanup, deleteUnusedMapFiles, scanMapRetirement, retireMapRegions } from "../services/localMapCleanupService.js";

const SAFE_ERROR_CODES = new Set(["28P01", "28000", "3D000", "42501", "42P01", "42703", "57014", "08001", "08006",
  "EACCES", "EPERM", "ENOENT", "ENOSPC", "EEXIST", "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ETIMEDOUT",
  "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
  "ERR_PARSE_ARGS_UNKNOWN_OPTION", "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL", "ERR_PARSE_ARGS_INVALID_OPTION_VALUE", "ABORT_ERR"]);
const MAP_STAGES = new Set(["arguments", "sqlite-runtime", "environment", "runtime-database", "database-connect",
  "database-read", "database-close", "catalog", "plan", "prepare", "request", "install", "rollback", "demand",
  "cleanup-scan", "cleanup", "retire-scan", "retire"]);

function safeErrorCode(error) {
  return [error?.code, error?.cause?.code, error?.cause?.errors?.[0]?.code]
    .find(code => SAFE_ERROR_CODES.has(code)) || (error?.name === "TimeoutError" ? "TIMEOUT" : "UNKNOWN");
}

async function mapStage(stage, operation) {
  try { return await operation(); }
  catch (error) {
    throw Object.assign(new MapSetupError(error instanceof MapSetupError ? error.message : "Map command failed"),
      { stage, code: safeErrorCode(error) });
  }
}

export function formatMapCommandError(error) {
  const stage = MAP_STAGES.has(error?.stage) ? error.stage : "arguments";
  const code = error?.code === "TIMEOUT" ? "TIMEOUT" : safeErrorCode(error);
  return `${error instanceof MapSetupError ? error.message : "Map command failed"} [stage=${stage}, code=${code}]`;
}

export function getMapDatabaseConfig(environment, envFile) {
  const runtime = resolveRuntimeDatabaseEnvironment({ ...environment,
    NODE_ENV: environment.NODE_ENV || (path.basename(envFile) === ".env.production" ? "production" : "development") });
  return { host: environment.DB_HOST || "localhost", port: Number(environment.DB_PORT || 5432),
    database: runtime.databaseName, user: environment.DB_USER, password: environment.DB_PASSWORD,
    connectionTimeoutMillis: 15000 };
}

export function formatMapProgress(progress) {
  const phase = /^[a-z]+(?:-[a-z]+)*$/.test(progress.phase) ? progress.phase : "progress";
  const fields = [`[maps] ${phase}`];
  if (progress.archive !== undefined) {
    const id = typeof progress.archive === "string" && progress.archive.length <= 160
      && /^[a-z0-9]+(?:[-/][a-z0-9]+)*$/.test(progress.archive) ? progress.archive : "unknown";
    fields.push(`archive=${id}`);
  }
  if (Number.isSafeInteger(progress.attempt)) fields.push(`attempt=${progress.attempt}/3`);
  if (Number.isSafeInteger(progress.completed) && Number.isSafeInteger(progress.total)) fields.push(`${progress.completed}/${progress.total}`);
  if (Number.isSafeInteger(progress.bytes) && Number.isSafeInteger(progress.totalBytes) && progress.totalBytes > 0) {
    fields.push(`${progress.bytes}/${progress.totalBytes} bytes (${(100 * progress.bytes / progress.totalBytes).toFixed(1)}%)`);
  }
  return fields.join(" ");
}

async function readLifecycleRequest() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 128 * 1024) throw new MapSetupError("Map lifecycle request too large");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function runMapCommand(argv, { clientFactory = config => new Client(config), fetchFn = fetch,
  progressWriter = message => console.error(message), requestReader = readLifecycleRequest } = {}) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    "env-file": { type: "string" }, "approved-regions": { type: "string" }, "record-demand": { type: "boolean", default: false }, quick: { type: "boolean", default: false }, json: { type: "boolean", default: false }, help: { type: "boolean", default: false }
  } });
  if (values.help) {
    console.log("Usage: npm run maps:plan|maps:prepare -- --env-file .env.production [--json] [--approved-regions id,...]\nPlan additionally accepts --quick for archive metadata/tile sampling without full SQLite integrity checks. Prepare does not accept --quick. --record-demand explicitly persists the admin demand summary for plan/prepare; plain plan remains read-only. Internal Ops demand records regional demand and downloads missing direct regions only with WOA_MAP_AUTO_DOWNLOAD=1 and the local provider. Internal Ops commands install|rollback|cleanup|retire require a bounded JSON approval request on stdin and an explicit --env-file. Internal cleanup-scan|retire-scan produce approval previews; cleanup deletes only approved unreferenced files, and retirement preserves the former active set for rollback. Restart all cooperating app/workers with reader reservations before cleanup. No command writes database data or runs migrations.");
    return;
  }
  const command = positionals[0];
  if (!["plan", "prepare", "demand", "install", "rollback", "cleanup-scan", "cleanup", "retire-scan", "retire"].includes(command) || positionals.length !== 1 || !values["env-file"]) throw new MapSetupError("Specify a supported map command and an explicit --env-file; see --help");
  if (values.quick && command !== "plan") throw new MapSetupError("--quick is only supported for plan; prepare requires full archive checks");
  if (values["record-demand"] && !["plan", "prepare"].includes(command)) throw new MapSetupError("--record-demand requires plan or prepare");
  await mapStage("sqlite-runtime", async () => {
    try { await import("node:sqlite"); }
    catch { throw new MapSetupError("Node.js with node:sqlite support is required before preparing maps"); }
  });
  const environment = await mapStage("environment", () => {
    const loaded = dotenv.config({ path: path.resolve(values["env-file"]), override: true, quiet: true });
    if (loaded.error || !loaded.parsed?.DB_NAME || !loaded.parsed?.DB_USER) {
      if (loaded.error) throw loaded.error;
      throw new MapSetupError("Environment file missing DB_NAME/DB_USER");
    }
    return loaded.parsed;
  });
  const lifecycleRequest = ["install", "rollback", "cleanup", "retire"].includes(command) ? await mapStage("request", requestReader) : null;
  const config = getLocalThumbnailMapConfig();
  if (command === "demand" && !config.enabled) {
    console.log(JSON.stringify({ demand: { skipped: true } }));
    return;
  }
  const client = await mapStage("runtime-database", () => clientFactory(getMapDatabaseConfig(environment, values["env-file"])));
  const cancellation = new AbortController();
  const abort = () => cancellation.abort(new MapSetupError("Map command interrupted"));
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  const onProgress = progress => progressWriter(formatMapProgress(progress));
  try {
    const options = { config, signal: cancellation.signal, onProgress, fetchFn };
    if (["cleanup-scan", "cleanup"].includes(command)) {
      const result = await mapStage(command, () => command === "cleanup-scan" ? scanMapCleanup(options)
        : deleteUnusedMapFiles(lifecycleRequest.snapshot, lifecycleRequest, options));
      console.log(JSON.stringify(command === "cleanup-scan" ? { cleanup: result } : { lifecycle: result }));
      return;
    }
    onProgress({ phase: "database-connect" });
    await mapStage("database-connect", () => client.connect());
    onProgress({ phase: "database-read" });
    const workouts = await mapStage("database-read", () => readMapWorkoutBounds(client));
    if (["retire-scan", "retire"].includes(command)) {
      const result = await mapStage(command, () => command === "retire-scan" ? scanMapRetirement(workouts, options)
        : retireMapRegions(lifecycleRequest.snapshot, lifecycleRequest, () => readMapWorkoutBounds(client), options));
      console.log(JSON.stringify(command === "retire-scan" ? { retirement: result } : { lifecycle: result }));
      return;
    }
    await mapStage("database-close", () => client.end());
    if (lifecycleRequest) {
      const options = { config: getLocalThumbnailMapConfig(), fetchFn, signal: cancellation.signal, onProgress };
      const lifecycle = await mapStage(command, () => command === "install"
        ? installMapArchiveUpdates(lifecycleRequest.snapshot, lifecycleRequest.approvedRegions, workouts, options)
        : rollbackMapArchives(lifecycleRequest, workouts, options));
      console.log(values.json ? JSON.stringify({ lifecycle }) : `Active map set: ${lifecycle.activeSet}; rolled back: ${lifecycle.rolledBack}`);
      return;
    }
    onProgress({ phase: "catalog" });
    const catalog = await mapStage("catalog", () => fetchMapCatalog({ signal: cancellation.signal, fetchFn }));
    onProgress({ phase: "plan" });
    const plan = await mapStage("plan", () => buildMapPlan(workouts, catalog, { dataDirectory: getLocalThumbnailMapConfig().dataDirectory,
      allowParentFallback: command !== "demand", inspectionMode: values.quick ? "sample" : "full", signal: cancellation.signal, fetchFn, onProgress }));
    if (command === "demand") {
      const automatic = canAutomaticallyPrepareMaps(plan.report, config, readMapArchiveSet(config.dataDirectory));
      let demand = { ...summarizeMapDemand(plan.report), automaticDownloads: config.automaticDownloads,
        downloadState: automatic ? "downloading" : plan.report.downloadBytes === 0 && !plan.report.unmappedWorkouts.length
          ? "available" : config.automaticDownloads ? "blocked" : "manual" };
      await mapStage("demand", () => saveMapDemand(demand, config));
      if (automatic) {
        try {
          const preparation = await mapStage("prepare", () => prepareMapArchives(plan, {
            versioned: true, missingOnly: true, signal: cancellation.signal, fetchFn, onProgress
          }));
          demand = { ...summarizeMapDemand({ ...plan.report, preparation }), automaticDownloads: true, downloadState: "available" };
          await mapStage("demand", () => saveMapDemand(demand, config));
        } catch (error) {
          await saveMapDemand({ ...demand, downloadState: "failed" }, config).catch(() => {});
          throw error;
        }
      }
      console.log(JSON.stringify({ demand }));
      return;
    }
    let preparation;
    if (values["approved-regions"] !== undefined) await mapStage("prepare", () => {
      try { validateMapApproval(plan.report, values["approved-regions"].split(",")); }
      catch { throw new MapSetupError("Map demand changed or approval invalid; check and approve the regions again"); }
    });
    if (command === "prepare" && plan.report.readyToPrepare) preparation = await mapStage("prepare", () => prepareMapArchives(plan,
      { signal: cancellation.signal, fetchFn, onProgress }));
    const demand = values["record-demand"] ? await mapStage("demand", () => saveMapDemand(summarizeMapDemand({ ...plan.report, preparation }), config)) : undefined;
    if (values.json) console.log(JSON.stringify({ ...plan.report, preparation, demand }, null, 2));
    else {
      const report = plan.report;
      const gib = bytes => `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
      console.log(`Map directory: ${report.dataDirectory}\nGPS workouts: ${report.gpsWorkouts}; missing thumbnails: ${report.missingThumbnails}`);
      for (const archive of report.archives) console.log(`${archive.existingValid ? archive.integrityChecked ? "REUSE" : "PRESENT (sampled)" : "DOWNLOAD"} ${archive.id}: ${gib(archive.existingValid ? archive.existingBytes : archive.downloadBytes)}; ${archive.workouts} workouts`);
      console.log(`Download: ${gib(report.downloadBytes)}; free disk: ${gib(report.freeDiskBytes)}; archives after prepare: ${report.archiveCountAfterPrepare}/${report.archiveLimit}`);
      const storage = preparation?.storage || report.storage;
      console.log(`Map storage: ${gib(storage.usedBytes)} / ${gib(storage.limitBytes)}; cache: ${gib(storage.cacheBytes)}; fits after cache cleanup: ${storage.fitsAfterCleanup}`);
      console.log(`Missing bounds: ${report.missingBounds.length}; unsupported bounds: ${report.unsupportedBounds.length}; unmapped workouts: ${report.unmappedWorkouts.length}; invalid unrelated archives: ${report.invalidUnneededArchives.length}`);
      console.log(`Plan complete: ${report.readyToPrepare}`);
      if (preparation) console.log(`Created: ${preparation.created.length}; reused: ${preparation.reused.length}; workouts with missing tiles: ${preparation.uncoveredWorkouts.length}; ready to activate: ${preparation.readyToActivate}`);
    }
    if (!plan.report.readyToPrepare || preparation?.readyToActivate === false) process.exitCode = 2;
  } finally {
    await client.end().catch(() => {});
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runMapCommand(process.argv.slice(2)).catch(error => {
    console.error(formatMapCommandError(error));
    console.error("No database changes or migrations were performed.");
    process.exitCode = 1;
  });
}