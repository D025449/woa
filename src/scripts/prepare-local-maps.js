import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import path from "node:path";
import dotenv from "dotenv";
import { Client } from "pg";
import { getLocalThumbnailMapConfig } from "../config/storagePaths.js";
import { MapSetupError, fetchMapCatalog, readMapWorkoutBounds, buildMapPlan, prepareMapArchives } from "../services/localMapProvisioningService.js";

export async function runMapCommand(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    "env-file": { type: "string" }, json: { type: "boolean", default: false }, help: { type: "boolean", default: false }
  } });
  if (values.help) {
    console.log("Usage: npm run maps:plan|maps:prepare -- --env-file .env.production [--json]\nPlan reads GPS bounds and public metadata only. Prepare downloads validated archives; neither command writes database data or runs migrations.");
    return;
  }
  const command = positionals[0];
  if (!["plan", "prepare"].includes(command) || positionals.length !== 1 || !values["env-file"]) throw new MapSetupError("Specify plan|prepare and an explicit --env-file; see --help");
  try { await import("node:sqlite"); }
  catch { throw new MapSetupError("Node.js with node:sqlite support is required before preparing maps"); }
  const environment = dotenv.config({ path: path.resolve(values["env-file"]), override: true, quiet: true });
  if (environment.error || !environment.parsed?.DB_NAME || !environment.parsed?.DB_USER) throw new MapSetupError("Environment file unavailable or missing DB_NAME/DB_USER");
  const client = new Client({ host: environment.parsed.DB_HOST, port: Number(environment.parsed.DB_PORT || 5432),
    database: environment.parsed.DB_NAME, user: environment.parsed.DB_USER, password: environment.parsed.DB_PASSWORD,
    connectionTimeoutMillis: 15000 });
  const cancellation = new AbortController();
  const abort = () => cancellation.abort(new MapSetupError("Map command interrupted"));
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    await client.connect();
    const workouts = await readMapWorkoutBounds(client);
    await client.end();
    const catalog = await fetchMapCatalog({ signal: cancellation.signal });
    const plan = await buildMapPlan(workouts, catalog, { dataDirectory: getLocalThumbnailMapConfig().dataDirectory,
      signal: cancellation.signal });
    let preparation;
    if (command === "prepare" && plan.report.readyToPrepare) preparation = await prepareMapArchives(plan, { signal: cancellation.signal });
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
    console.error(error instanceof MapSetupError ? error.message : "Map command failed; check database access, Geofabrik metadata, archive validity, disk space and any preparation lock.");
    console.error("No database changes or migrations were performed.");
    process.exitCode = 1;
  });
}