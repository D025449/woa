#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  acquireBackupLock,
  getPostgresTools,
  loadBackupEnvironment,
  parseCliArgs,
  requireEnvironment,
  runCommand
} from "./backup-common.mjs";
import {
  applyRuntimeDatabasePointer,
  assertDatabaseName,
  writeRuntimeDatabasePointer
} from "./runtime-database.mjs";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

function printHelp() {
  console.log(`Usage: node ops/postgres-backup/switch-database.mjs --operation <activate|rollback> [options]

Options:
  --operation <name>       Activate a prepared restore or roll back the pointer
  --target-db <name>       Prepared restore database (activate only)
  --expected-source <name> Expected currently active database
  --backup-id <id>         Backup ID associated with the prepared restore
  --admin-auth-sub <sub>   Admin identity that must exist in the target database
  --result-file <path>     Write the machine-readable result as JSON
  --help                   Show this help
`);
}

async function validateAdminDatabase(tools, database, authSub, childEnv) {
  const result = await runCommand(tools.psql, [
    "--host", process.env.DB_HOST,
    "--port", process.env.DB_PORT,
    "--username", process.env.DB_USER,
    "--dbname", database,
    "--no-psqlrc", "--tuples-only", "--no-align",
    "--set", `admin_auth_sub=${authSub}`,
    "--command", `SELECT json_build_object(
      'database', current_database(),
      'adminPresent', EXISTS (
        SELECT 1
        FROM users u
        JOIN user_roles r ON r.uid = u.id AND r.role = 'admin'
        WHERE u.auth_sub = :'admin_auth_sub'
      ),
      'users', (SELECT count(*) FROM users),
      'workouts', (SELECT count(*) FROM workouts),
      'segments', (SELECT count(*) FROM gps_segments)
    )::text;`
  ], { env: childEnv });
  const validation = JSON.parse(result.stdout);
  if (!validation.adminPresent) {
    throw new Error("The authenticated administrator is not an admin in the target database.");
  }
  return validation;
}

function assertPreparedRestoreName(target, logicalDatabase) {
  const expectedPrefix = `${String(logicalDatabase).toLowerCase()}_restore_`;
  if (!target.toLowerCase().startsWith(expectedPrefix)) {
    throw new Error(`Refusing to activate database outside ${expectedPrefix}*.`);
  }
}

async function createSafetyBackup(operation, resultFile, childEnv) {
  const label = operation === "rollback" ? "before-pointer-rollback" : "before-restore-activation";
  await runCommand(process.execPath, [
    path.join(currentDirectory, "create-backup.mjs"),
    "--label", label,
    "--result-file", resultFile
  ], { cwd: path.resolve(currentDirectory, "../.."), env: childEnv, inheritStdout: true });
  return JSON.parse(await fs.readFile(resultFile, "utf8"));
}

async function switchDatabase() {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (String(process.env.NODE_ENV || "") !== "production") {
    throw new Error("Runtime database pointer switching is supported only in production.");
  }
  const operation = String(options.operation || "");
  if (!["activate", "rollback"].includes(operation)) {
    throw new Error("--operation must be activate or rollback.");
  }

  const startedAt = Date.now();
  const envFile = await loadBackupEnvironment(options["env-file"]);
  const runtime = applyRuntimeDatabasePointer();
  requireEnvironment([
    "DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD", "AWS_REGION",
    "BACKUP_ACTIVE_DATABASE_FILE"
  ]);
  const sourceDatabase = assertDatabaseName(process.env.DB_NAME, "active DB_NAME");
  const expectedSource = assertDatabaseName(options["expected-source"], "expected source database");
  if (sourceDatabase !== expectedSource) {
    throw new Error(`Active database changed from ${expectedSource} to ${sourceDatabase}; prepare again.`);
  }

  const targetDatabase = operation === "rollback"
    ? assertDatabaseName(runtime.previousDatabase, "rollback database")
    : assertDatabaseName(options["target-db"], "prepared restore database");
  if (targetDatabase === sourceDatabase) throw new Error("Target database is already active.");
  if (operation === "activate") assertPreparedRestoreName(targetDatabase, runtime.logicalDatabase);

  const adminAuthSub = String(options["admin-auth-sub"] || "").trim();
  if (!adminAuthSub) throw new Error("Missing --admin-auth-sub.");
  const tools = getPostgresTools();
  const childEnv = { ...process.env, PGPASSWORD: process.env.DB_PASSWORD };
  const releaseLock = await acquireBackupLock(
    `switch:${process.env.DB_HOST}:${process.env.DB_PORT}/${runtime.logicalDatabase}`
  );
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "cwa24-pg-switch-"));

  try {
    const validation = await validateAdminDatabase(tools, targetDatabase, adminAuthSub, childEnv);
    const safetyBackup = await createSafetyBackup(
      operation,
      path.join(tempDirectory, "safety-backup-result.json"),
      childEnv
    );
    await writeRuntimeDatabasePointer({
      file: runtime.pointerFile,
      databaseName: targetDatabase,
      previousDatabase: sourceDatabase,
      backupId: operation === "activate" ? options["backup-id"] : safetyBackup.backupId
    });
    const result = {
      operation,
      environment: "production",
      logicalDatabase: runtime.logicalDatabase,
      previousDatabase: sourceDatabase,
      activeDatabase: targetDatabase,
      pointerFile: runtime.pointerFile,
      validation,
      safetyBackup,
      envFile,
      totalMs: Date.now() - startedAt
    };
    if (options["result-file"]) {
      await fs.writeFile(options["result-file"], `${JSON.stringify(result)}\n`, { mode: 0o600 });
    }
    console.log("Production database pointer updated", result);
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
    await releaseLock();
  }
}

switchDatabase().catch((error) => {
  console.error("Production database switch failed:", error.message);
  process.exitCode = 1;
});
