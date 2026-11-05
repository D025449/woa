import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import path from "node:path";
import dotenv from "dotenv";
import { Client } from "pg";
import { resolveRuntimeDatabaseEnvironment } from "../../ops/postgres-backup/runtime-database.mjs";
import { getLocalThumbnailMapConfig } from "../config/storagePaths.js";
import { MapSetupError, fetchMapCatalog, readMapWorkoutBounds, buildMapPlan, prepareMapArchives } from "../services/localMapProvisioningService.js";

const SAFE_ERROR_CODES = new Set(["28P01", "28000", "3D000", "42501", "42P01", "42703", "57014", "08001", "08006",
  "EACCES", "EPERM", "ENOENT", "ENOSPC", "EEXIST", "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ETIMEDOUT",
  "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
  "ERR_PARSE_ARGS_UNKNOWN_OPTION", "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL", "ERR_PARSE_ARGS_INVALID_OPTION_VALUE", "ABORT_ERR"]);
const MAP_STAGES = new Set(["arguments", "sqlite-runtime", "environment", "runtime-database", "database-connect",
  "database-read", "database-close", "catalog", "plan", "prepare"]);

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

export async function runMapCommand(argv, { clientFactory = config => new Client(config) } = {}) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    "env-file": { type: "string" }, json: { type: "boolean", default: false }, help: { type: "boolean", default: false }
  } });
  if (values.help) {
    console.log("Usage: npm run maps:plan|maps:prepare -- --env-file .env.production [--json]\nPlan reads GPS bounds and public metadata only. Prepare downloads validated archives; neither command writes database data or runs migrations.");
    return;
  }
  const command = positionals[0];
  if (!["plan", "prepare"].includes(command) || positionals.length !== 1 || !values["env-file"]) throw new MapSetupError("Specify plan|prepare and an explicit --env-file; see --help");
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
  const client = await mapStage("runtime-database", () => clientFactory(getMapDatabaseConfig(environment, values["env-file"])));
  const cancellation = new AbortController();
  const abort = () => cancellation.abort(new MapSetupError("Map command interrupted"));
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    await mapStage("database-connect", () => client.connect());
    const workouts = await mapStage("database-read", () => readMapWorkoutBounds(client));
    await mapStage("database-close", () => client.end());
    const catalog = await mapStage("catalog", () => fetchMapCatalog({ signal: cancellation.signal }));
    const plan = await mapStage("plan", () => buildMapPlan(workouts, catalog, { dataDirectory: getLocalThumbnailMapConfig().dataDirectory,
      signal: cancellation.signal }));
    let preparation;
    if (command === "prepare" && plan.report.readyToPrepare) preparation = await mapStage("prepare", () => prepareMapArchives(plan, { signal: cancellation.signal }));
    if (values.json) console.log(JSON.stringify({ ...plan.report, preparation }, null, 2));
    else {
      const report = plan.report;
      const gib = bytes => `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
      console.log(`Map directory: ${report.dataDirectory}\nGPS workouts: ${report.gpsWorkouts}; missing thumbnails: ${report.missingThumbnails}`);
      for (const archive of report.archives) console.log(`${archive.existingValid ? "REUSE" : "DOWNLOAD"} ${archive.id}: ${gib(archive.existingValid ? archive.existingBytes : archive.downloadBytes)}; ${archive.workouts} workouts`);
      console.log(`Download: ${gib(report.downloadBytes)}; free disk: ${gib(report.freeDiskBytes)}; archives after prepare: ${report.archiveCountAfterPrepare}/${report.archiveLimit}`);
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