import "../config/env.js";

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Worker } from "bullmq";

import { runCommand } from "../../ops/postgres-backup/backup-common.mjs";
import { redisConnection } from "../queue/connection.js";
import { POSTGRES_BACKUP_OPS_QUEUE } from "../queue/postgres-backup-ops-queue.js";
import PostgresBackupCatalogService from "../services/postgresBackupCatalogService.js";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDirectory, "../..");

async function executeOperation(job, scriptName, args = []) {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "cwa24-backup-ops-job-"));
  const resultFile = path.join(tempDirectory, "result.json");
  try {
    await job.updateProgress({ percent: 10, phase: "running" });
    await runCommand(process.execPath, [
      path.join(projectRoot, "ops/postgres-backup", scriptName),
      ...args,
      "--result-file", resultFile
    ], { cwd: projectRoot, env: process.env });
    const result = JSON.parse(await fs.readFile(resultFile, "utf8"));
    await job.updateProgress({ percent: 100, phase: "completed" });
    return result;
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
}

async function restartProductionProcess(name) {
  const pm2 = process.env.BACKUP_PM2_PATH || "pm2";
  const ecosystem = process.env.BACKUP_ECOSYSTEM_FILE || "ecosystem.config.cjs";
  await runCommand(pm2, [
    "start", ecosystem,
    "--only", name,
    "--env", "production",
    "--update-env"
  ], { cwd: projectRoot, env: process.env, inheritStdout: true });
}

async function saveProductionProcessList() {
  await runCommand(process.env.BACKUP_PM2_PATH || "pm2", ["save"], {
    cwd: projectRoot,
    env: process.env,
    inheritStdout: true
  });
}

async function executeDatabaseSwitch(job, operation) {
  const args = [
    "--operation", operation,
    "--expected-source", String(job.data.sourceDatabase),
    "--admin-auth-sub", String(job.data.adminAuthSub)
  ];
  if (operation === "activate") {
    args.push(
      "--target-db", String(job.data.targetDatabase),
      "--backup-id", String(job.data.backupId)
    );
  }
  const result = await executeOperation(job, "switch-database.mjs", args);
  process.env.DB_NAME = result.activeDatabase;
  try {
    await restartProductionProcess(process.env.BACKUP_IMPORT_WORKER_NAME || "import-worker");
    await restartProductionProcess(process.env.BACKUP_APP_PROCESS_NAME || "cwa24");
    await saveProductionProcessList();
    return { ...result, processesRestarted: true };
  } catch (error) {
    const compensation = await executeOperation(job, "switch-database.mjs", [
      "--operation", "rollback",
      "--expected-source", result.activeDatabase,
      "--admin-auth-sub", String(job.data.adminAuthSub)
    ]);
    process.env.DB_NAME = compensation.activeDatabase;
    await restartProductionProcess(process.env.BACKUP_IMPORT_WORKER_NAME || "import-worker");
    await restartProductionProcess(process.env.BACKUP_APP_PROCESS_NAME || "cwa24");
    await saveProductionProcessList();
    throw new Error(
      `PM2 restart failed after database switch; pointer was restored to ${compensation.activeDatabase}.`,
      { cause: error }
    );
  }
}

const worker = new Worker(
  POSTGRES_BACKUP_OPS_QUEUE,
  async (job) => {
    if (job.name === "create") {
      const args = job.data?.label ? ["--label", String(job.data.label)] : [];
      return executeOperation(job, "create-backup.mjs", args);
    }
    if (job.name === "verify") {
      const root = PostgresBackupCatalogService.validateRoot(job.data?.backupRoot);
      return executeOperation(job, "verify-backup.mjs", ["--backup-prefix", root]);
    }
    if (job.name === "prepare-restore") {
      const root = PostgresBackupCatalogService.validateRoot(job.data?.backupRoot);
      return executeOperation(job, "prepare-restore.mjs", ["--backup-prefix", root]);
    }
    if (job.name === "activate-restore") {
      return executeDatabaseSwitch(job, "activate");
    }
    if (job.name === "rollback") {
      return executeDatabaseSwitch(job, "rollback");
    }
    throw new Error(`Unsupported PostgreSQL backup operation: ${job.name}`);
  },
  { connection: redisConnection, concurrency: 1 }
);

worker.on("ready", () => {
  console.log("PostgreSQL backup ops worker is ready");
});

worker.on("completed", (job, result) => {
  console.log("[backup-ops] completed", {
    jobId: job.id,
    operation: job.name,
    backupId: result?.backupId || null,
    targetDatabase: result?.targetDatabase || null
  });
});

worker.on("failed", (job, error) => {
  console.error("[backup-ops] failed", {
    jobId: job?.id,
    operation: job?.name,
    error: error.message
  });
});

worker.on("error", (error) => {
  console.error("PostgreSQL backup ops worker error", error);
});
