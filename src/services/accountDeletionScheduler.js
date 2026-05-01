import AccountDeletionService from "./accountDeletionService.js";

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_START_DELAY_MS = 30 * 1000;

let schedulerHandle = null;
let schedulerRunning = false;

function isSchedulerEnabled() {
  return process.env.ACCOUNT_DELETION_JOB_ENABLED !== "false";
}

function getIntervalMs() {
  const parsed = Number(process.env.ACCOUNT_DELETION_JOB_INTERVAL_MS || DEFAULT_INTERVAL_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_MS;
}

function getBatchSize() {
  const parsed = Number(process.env.ACCOUNT_DELETION_JOB_BATCH_SIZE || 25);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 25;
}

async function runDeletionSweep() {
  if (schedulerRunning) {
    return;
  }

  schedulerRunning = true;
  try {
    const summary = await AccountDeletionService.runDueDeletionBatch(getBatchSize());
    if (summary.deleted > 0) {
      console.log("Account deletion sweep completed", summary);
    }
  } catch (error) {
    console.error("Account deletion sweep failed", error);
  } finally {
    schedulerRunning = false;
  }
}

export function startAccountDeletionScheduler() {
  if (!isSchedulerEnabled()) {
    console.log("Account deletion scheduler disabled");
    return null;
  }

  if (schedulerHandle) {
    return schedulerHandle;
  }

  setTimeout(() => {
    runDeletionSweep();
  }, DEFAULT_START_DELAY_MS).unref?.();

  schedulerHandle = setInterval(() => {
    runDeletionSweep();
  }, getIntervalMs());

  schedulerHandle.unref?.();
  console.log("Account deletion scheduler started", {
    intervalMs: getIntervalMs(),
    batchSize: getBatchSize()
  });
  return schedulerHandle;
}

