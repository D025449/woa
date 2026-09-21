import {
  configureGpsSegmentRebuildDatabase,
  assertGpsSegmentRebuildDatabaseUnchanged
} from "./gps-segment-best-efforts-rebuild-helpers.js";

export const GPS_SEGMENT_ELEVATION_PROFILE_REBUILD_KEY = "gps-segment-elevation-profiles-v3";
export const DEFAULT_GPS_SEGMENT_ELEVATION_PROFILE_BATCH_SIZE = 32;

function parsePositiveInteger(value, flag) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} requires a positive integer`);
  }
  return parsed;
}

export function parseGpsSegmentElevationProfileRebuildArgs(args = []) {
  const options = {
    apply: false,
    batchSize: DEFAULT_GPS_SEGMENT_ELEVATION_PROFILE_BATCH_SIZE,
    confirmDatabase: null,
    help: false,
    limit: null,
    rerunCompleted: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--apply") {
      options.apply = true;
    } else if (arg === "--batch-size") {
      options.batchSize = parsePositiveInteger(args[index + 1], arg);
      index += 1;
    } else if (arg === "--confirm-db") {
      const database = String(args[index + 1] || "").trim();
      if (!database) throw new Error(`${arg} requires the exact target database name`);
      options.confirmDatabase = database;
      index += 1;
    } else if (arg === "--limit") {
      options.limit = parsePositiveInteger(args[index + 1], arg);
      index += 1;
    } else if (arg === "--rerun-completed") {
      options.rerunCompleted = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.rerunCompleted && !options.apply) {
    throw new Error("--rerun-completed is only valid together with --apply");
  }
  return options;
}

export function assertGpsSegmentElevationProfileWriteTarget(options, currentDatabase) {
  if (!options?.apply && !options?.confirmDatabase) return;
  if (!options.confirmDatabase) {
    throw new Error("Write mode requires --confirm-db with the exact target database name");
  }
  if (options.confirmDatabase !== currentDatabase) {
    throw new Error(
      `Database confirmation mismatch: expected "${currentDatabase}", received "${options.confirmDatabase}"`
    );
  }
}

export function createGpsSegmentElevationProfileSummary() {
  return {
    processedSegments: 0,
    confirmedSegments: 0,
    candidateSegments: 0,
    unavailableSegments: 0,
    retainedSegments: 0,
    batches: 0
  };
}

export function addGpsSegmentElevationProfileBatch(summary, results) {
  const rows = Array.isArray(results) ? results : [];
  return {
    processedSegments: summary.processedSegments + rows.length,
    confirmedSegments: summary.confirmedSegments
      + rows.filter((row) => row?.workout_altitude_status === "confirmed").length,
    candidateSegments: summary.candidateSegments
      + rows.filter((row) => row?.workout_altitude_status === "candidate").length,
    unavailableSegments: summary.unavailableSegments
      + rows.filter((row) => row?.workout_altitude_status === "unavailable").length,
    retainedSegments: summary.retainedSegments + rows.filter((row) => row?.retained === true).length,
    batches: summary.batches + 1
  };
}

export function getGpsSegmentElevationProfileRebuildUsage() {
  return [
    "Build workout-derived elevation profiles for existing GPS segments.",
    "",
    "Usage:",
    "  npm run migrate:gps-segment-elevation-profiles -- [options]",
    "",
    "Options:",
    "  --apply                    Persist profiles and checkpoints (default is a read-only dry run)",
    "  --confirm-db <name>        Exact current_database() value; required with --apply",
    `  --batch-size <count>       Segments per batch (default ${DEFAULT_GPS_SEGMENT_ELEVATION_PROFILE_BATCH_SIZE})`,
    "  --limit <count>            Stop after this many eligible segments without completing the run",
    "  --rerun-completed          Deliberately reset and repeat an already completed version",
    "  --help                     Show this help",
    "",
    "A failed or limited apply run resumes from its persisted segment checkpoint.",
    "Production requires the active database pointer (/etc/cwa24/active-database.env by default).",
    "The pointer overrides DB_NAME from .env.production; a missing pointer aborts the run.",
    "",
    "Examples:",
    "  npm run migrate:gps-segment-elevation-profiles -- --confirm-db cwa24_dev",
    "  npm run migrate:gps-segment-elevation-profiles -- --apply --confirm-db cwa24_dev",
    "  NODE_ENV=production npm run migrate:gps-segment-elevation-profiles -- --confirm-db cwa24_prod_restore_20260805_144216",
    "  NODE_ENV=production npm run migrate:gps-segment-elevation-profiles -- --apply --confirm-db cwa24_prod_restore_20260805_144216"
  ].join("\n");
}

export { configureGpsSegmentRebuildDatabase, assertGpsSegmentRebuildDatabaseUnchanged };
