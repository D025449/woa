export const GPS_SEGMENT_BEST_EFFORTS_REBUILD_KEY = "gps-segment-best-efforts-harmonized-v1";
export const DEFAULT_GPS_SEGMENT_BEST_EFFORTS_BATCH_SIZE = 100;

function parsePositiveInteger(value, flag) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} requires a positive integer`);
  }
  return parsed;
}

export function parseGpsSegmentBestEffortsRebuildArgs(args = []) {
  const options = {
    apply: false,
    batchSize: DEFAULT_GPS_SEGMENT_BEST_EFFORTS_BATCH_SIZE,
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

export function assertGpsSegmentBestEffortsWriteTarget(options, currentDatabase) {
  if (!options?.apply) return;
  if (!options.confirmDatabase) {
    throw new Error("Write mode requires --confirm-db with the exact target database name");
  }
  if (options.confirmDatabase !== currentDatabase) {
    throw new Error(
      `Database confirmation mismatch: expected "${currentDatabase}", received "${options.confirmDatabase}"`
    );
  }
}

export function groupEligibleWorkoutsByOwner(rows = []) {
  const groups = new Map();
  for (const row of rows) {
    const uid = Number(row?.uid);
    const workoutId = Number(row?.id);
    if (!Number.isInteger(uid) || uid <= 0 || !Number.isInteger(workoutId) || workoutId <= 0) {
      continue;
    }
    if (!groups.has(uid)) groups.set(uid, []);
    groups.get(uid).push(workoutId);
  }
  return [...groups.entries()].map(([uid, workoutIds]) => ({ uid, workoutIds }));
}

export function createGpsSegmentBestEffortsRebuildSummary() {
  return {
    processedWorkouts: 0,
    oldRows: 0,
    newRows: 0,
    addedMatchKeys: 0,
    removedMatchKeys: 0,
    changedRows: 0,
    elapsedMs: 0,
    batches: 0
  };
}

export function addGpsSegmentBestEffortsBatchSummary(summary, batch) {
  return {
    processedWorkouts: summary.processedWorkouts + Number(batch.workoutCount || 0),
    oldRows: summary.oldRows + Number(batch.oldRowCount || 0),
    newRows: summary.newRows + Number(batch.newRowCount || 0),
    addedMatchKeys: summary.addedMatchKeys + Number(batch.addedMatchKeyCount || 0),
    removedMatchKeys: summary.removedMatchKeys + Number(batch.removedMatchKeyCount || 0),
    changedRows: summary.changedRows + Number(batch.changedRowCount || 0),
    elapsedMs: summary.elapsedMs + Number(batch.elapsedMs || 0),
    batches: summary.batches + 1
  };
}

export function getGpsSegmentBestEffortsRebuildUsage() {
  return [
    "Recompute persisted GPS segment best efforts with the harmonized compact matcher.",
    "",
    "Usage:",
    "  npm run migrate:gps-segment-best-efforts -- [options]",
    "",
    "Options:",
    "  --apply                    Replace rows and persist checkpoints (default is dry-run)",
    "  --confirm-db <name>        Exact current_database() value; required with --apply",
    `  --batch-size <count>       Eligible workouts per scan batch (default ${DEFAULT_GPS_SEGMENT_BEST_EFFORTS_BATCH_SIZE})`,
    "  --limit <count>            Stop after this many workouts without marking the run complete",
    "  --rerun-completed          Deliberately reset and repeat an already completed version",
    "  --help                     Show this help",
    "",
    "Examples:",
    "  npm run migrate:gps-segment-best-efforts -- --batch-size 100",
    "  npm run migrate:gps-segment-best-efforts -- --apply --confirm-db cwa24_dev",
    "  NODE_ENV=production npm run migrate:gps-segment-best-efforts -- --apply --confirm-db cwa24_prod"
  ].join("\n");
}
