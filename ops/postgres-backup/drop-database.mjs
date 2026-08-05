#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  acquireBackupLock,
  buildDropDatabaseInvocation,
  getPostgresTools,
  loadBackupEnvironment,
  parseCliArgs,
  requireEnvironment,
  resolveDatabaseCreator,
  runCommand
} from "./backup-common.mjs";
import {
  applyRuntimeDatabasePointer,
  assertManagedDatabaseName
} from "./runtime-database.mjs";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

function printHelp() {
  console.log(`Usage: node ops/postgres-backup/drop-database.mjs --target-db <name> --confirm <name> [options]

Options:
  --target-db <name>   Inactive managed database to back up and delete
  --confirm <name>     Must exactly match --target-db
  --result-file <path> Write the machine-readable result as JSON
  --help               Show this help
`);
}

function assertInactiveTarget(targetDatabase, runtime) {
  if (targetDatabase === runtime.databaseName) {
    throw new Error(`Refusing to delete active database ${targetDatabase}.`);
  }
  if (targetDatabase === runtime.previousDatabase) {
    throw new Error(`Refusing to delete rollback database ${targetDatabase}.`);
  }
}

async function createSafetyBackup(targetDatabase, resultFile, childEnv) {
  await runCommand(process.execPath, [
    path.join(currentDirectory, "create-backup.mjs"),
    "--source-db", targetDatabase,
    "--label", "before-database-delete",
    "--result-file", resultFile
  ], {
    cwd: path.resolve(currentDirectory, "../.."),
    env: childEnv,
    inheritStdout: true
  });
  return JSON.parse(await fs.readFile(resultFile, "utf8"));
}

async function dropDatabase() {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const startedAt = Date.now();
  const envFile = await loadBackupEnvironment(options["env-file"]);
  if (String(process.env.NODE_ENV || "") !== "production") {
    throw new Error("Managed database deletion is supported only in production.");
  }
  let runtime = applyRuntimeDatabasePointer();
  requireEnvironment([
    "DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD", "AWS_REGION",
    "BACKUP_ACTIVE_DATABASE_FILE"
  ]);
  const targetDatabase = assertManagedDatabaseName(
    options["target-db"],
    runtime.logicalDatabase,
    "database deletion target"
  );
  if (String(options.confirm || "") !== targetDatabase) {
    throw new Error("Database deletion confirmation does not exactly match the target database.");
  }

  const releaseLock = await acquireBackupLock(
    `switch:${process.env.DB_HOST}:${process.env.DB_PORT}/${runtime.logicalDatabase}`
  );
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "cwa24-pg-drop-"));
  const childEnv = { ...process.env, PGPASSWORD: process.env.DB_PASSWORD };

  try {
    runtime = applyRuntimeDatabasePointer();
    assertInactiveTarget(targetDatabase, runtime);

    const safetyBackup = await createSafetyBackup(
      targetDatabase,
      path.join(tempDirectory, "safety-backup-result.json"),
      childEnv
    );

    runtime = applyRuntimeDatabasePointer();
    assertInactiveTarget(targetDatabase, runtime);

    const tools = getPostgresTools();
    const databaseCreator = await resolveDatabaseCreator({
      tools,
      explicitUser: process.env.BACKUP_DB_ADMIN_USER,
      operatingSystemUser: os.userInfo().username
    });
    const invocation = buildDropDatabaseInvocation({
      tools,
      creator: databaseCreator,
      targetDatabase
    });
    await runCommand(invocation.command, invocation.args, { env: invocation.env });

    const result = {
      environment: "production",
      logicalDatabase: runtime.logicalDatabase,
      deletedDatabase: targetDatabase,
      safetyBackup,
      envFile,
      totalMs: Date.now() - startedAt
    };
    if (options["result-file"]) {
      await fs.writeFile(options["result-file"], `${JSON.stringify(result)}\n`, { mode: 0o600 });
    }
    console.log("Inactive PostgreSQL database deleted", result);
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
    await releaseLock();
  }
}

dropDatabase().catch((error) => {
  console.error("PostgreSQL database deletion failed:", error.message);
  process.exitCode = 1;
});
