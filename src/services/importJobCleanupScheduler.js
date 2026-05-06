import ImportJobCleanupService from "./importJobCleanupService.js";

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_START_DELAY_MS = 60 * 1000;

let schedulerHandle = null;
let schedulerRunning = false;

function isSchedulerEnabled() {
  return process.env.IMPORT_JOB_CLEANUP_ENABLED !== "false";
}

function getIntervalMs() {
  const parsed = Number(process.env.IMPORT_JOB_CLEANUP_INTERVAL_MS || DEFAULT_INTERVAL_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_MS;
}

function getRetentionHours() {
  const parsed = Number(process.env.IMPORT_JOB_RETENTION_HOURS || 24 * 7);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 24 * 7;
}

function getBatchSize() {
  const parsed = Number(process.env.IMPORT_JOB_CLEANUP_BATCH_SIZE || 500);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 500;
}

async function runCleanupSweep() {
  if (schedulerRunning) {
    return;
  }

  schedulerRunning = true;
  try {
    const summary = await ImportJobCleanupService.deleteOldFinishedJobs({
      olderThanHours: getRetentionHours(),
      limit: getBatchSize()
    });
    if (summary.deleted > 0) {
      console.log("Import job cleanup completed", summary);
    }
  } catch (error) {
    console.error("Import job cleanup failed", error);
  } finally {
    schedulerRunning = false;
  }
}

export function startImportJobCleanupScheduler() {
  if (!isSchedulerEnabled()) {
    console.log("Import job cleanup scheduler disabled");
    return null;
  }

  if (schedulerHandle) {
    return schedulerHandle;
  }

  setTimeout(() => {
    runCleanupSweep();
  }, DEFAULT_START_DELAY_MS).unref?.();

  schedulerHandle = setInterval(() => {
    runCleanupSweep();
  }, getIntervalMs());

  schedulerHandle.unref?.();
  console.log("Import job cleanup scheduler started", {
    intervalMs: getIntervalMs(),
    retentionHours: getRetentionHours(),
    batchSize: getBatchSize()
  });
  return schedulerHandle;
}
