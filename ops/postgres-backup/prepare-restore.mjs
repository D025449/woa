#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  acquireBackupLock,
  buildAwsS3CpArgs,
  buildRestoreDatabaseName,
  getPostgresTools,
  loadBackupEnvironment,
  parseCliArgs,
  readOptionalGitCommit,
  requireEnvironment,
  resolveDatabaseCreator,
  runCommand,
  s3Uri,
  sha256File
} from "./backup-common.mjs";
import { applyRuntimeDatabasePointer } from "./runtime-database.mjs";

function printHelp() {
  console.log(`Usage: node ops/postgres-backup/prepare-restore.mjs --backup-prefix <key> [options]

Options:
  --backup-prefix <key>  S3 key prefix containing manifest.json
  --env-file <path>      Explicit backup environment file
  --admin-user <name>    PostgreSQL role with CREATEDB permission
  --result-file <path>   Write the machine-readable result as JSON
  --help                 Show this help
`);
}

function normalizeBackupRoot(value) {
  return String(value || "")
    .replace(/^s3:\/\/[^/]+\//u, "")
    .replace(/\/manifest\.json$/u, "")
    .replace(/^\/+|\/+$/gu, "");
}

async function prepareRestore() {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const backupRoot = normalizeBackupRoot(options["backup-prefix"]);
  if (!backupRoot) throw new Error("Missing required --backup-prefix.");

  const startedAt = Date.now();
  const envFile = await loadBackupEnvironment(options["env-file"]);
  const runtimeDatabase = applyRuntimeDatabasePointer();
  requireEnvironment([
    "DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD", "AWS_REGION"
  ]);
  const environment = String(process.env.BACKUP_ENVIRONMENT || process.env.NODE_ENV || "unknown");
  const sourceDatabase = String(process.env.DB_NAME);
  const logicalDatabase = runtimeDatabase.logicalDatabase;
  const targetDatabase = buildRestoreDatabaseName(logicalDatabase);
  if (targetDatabase === sourceDatabase || !targetDatabase.includes("_restore_")) {
    throw new Error("Refusing to restore without a generated restore database name.");
  }

  const bucket = String(process.env.BACKUP_S3_BUCKET || process.env.S3_BUCKET || "").trim();
  if (!bucket) throw new Error("Missing BACKUP_S3_BUCKET or S3_BUCKET.");

  const awsCli = process.env.BACKUP_AWS_CLI_PATH || "aws";
  const tools = getPostgresTools();
  const childEnv = { ...process.env, PGPASSWORD: process.env.DB_PASSWORD };
  const databaseCreator = await resolveDatabaseCreator({
    tools,
    explicitUser: options["admin-user"] || process.env.BACKUP_DB_ADMIN_USER,
    operatingSystemUser: os.userInfo().username
  });
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "cwa24-pg-restore-prepare-"));
  const manifestFile = path.join(tempDirectory, "manifest.json");
  const dumpFile = path.join(tempDirectory, "database.dump");
  const releaseLock = await acquireBackupLock(
    `restore:${process.env.DB_HOST}:${process.env.DB_PORT}/${sourceDatabase}`
  );
  let databaseCreated = false;

  console.log("Preparing isolated PostgreSQL restore", {
    environment,
    sourceDatabase,
    targetDatabase,
    backup: s3Uri(bucket, backupRoot),
    envFile,
    databaseCreator: databaseCreator.user
  });

  try {
    await runCommand(awsCli, buildAwsS3CpArgs(
      s3Uri(bucket, `${backupRoot}/manifest.json`),
      manifestFile
    ));
    const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
    if (manifest.format !== "cwa24-postgres-backup-manifest" || manifest.status !== "complete") {
      throw new Error("Selected S3 object is not a complete CWA24 PostgreSQL backup.");
    }
    if (manifest.environment !== environment) {
      throw new Error(`Refusing to restore a ${manifest.environment || "unknown"} backup in ${environment}.`);
    }
    const manifestLogicalDatabase = manifest.database?.logicalName || manifest.database?.name;
    if (manifestLogicalDatabase !== logicalDatabase) {
      throw new Error(
        `Backup database ${manifestLogicalDatabase || "unknown"} does not match ${logicalDatabase}.`
      );
    }
    if (manifest.archive?.bucket !== bucket || !manifest.archive?.key) {
      throw new Error("Backup manifest references an unexpected bucket or missing archive key.");
    }

    await runCommand(awsCli, buildAwsS3CpArgs(
      s3Uri(bucket, manifest.archive.key),
      dumpFile
    ));
    const [actualSha256, dumpStat] = await Promise.all([
      sha256File(dumpFile),
      fs.stat(dumpFile)
    ]);
    if (actualSha256 !== manifest.archive.sha256) {
      throw new Error(`Backup checksum mismatch: expected ${manifest.archive.sha256}, got ${actualSha256}`);
    }
    if (dumpStat.size !== manifest.archive.sizeBytes) {
      throw new Error(`Backup size mismatch: expected ${manifest.archive.sizeBytes}, got ${dumpStat.size}`);
    }
    await runCommand(tools.pgRestore, ["--list", dumpFile]);

    await runCommand(tools.createdb, [
      "--host", process.env.DB_HOST,
      "--port", process.env.DB_PORT,
      "--username", databaseCreator.user,
      "--owner", process.env.DB_USER,
      "--maintenance-db", "postgres",
      targetDatabase
    ], { env: databaseCreator.env });
    databaseCreated = true;

    await runCommand(tools.pgRestore, [
      "--host", process.env.DB_HOST,
      "--port", process.env.DB_PORT,
      "--username", process.env.DB_USER,
      "--dbname", targetDatabase,
      "--no-owner",
      "--no-privileges",
      "--single-transaction",
      "--exit-on-error",
      dumpFile
    ], { env: childEnv });

    const validationResult = await runCommand(tools.psql, [
      "--host", process.env.DB_HOST,
      "--port", process.env.DB_PORT,
      "--username", process.env.DB_USER,
      "--dbname", targetDatabase,
      "--no-psqlrc", "--tuples-only", "--no-align",
      "--command", `SELECT json_build_object(
        'database', current_database(),
        'tables', (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')),
        'views', (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('v', 'm')),
        'constraints', (SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'public'),
        'users', CASE WHEN to_regclass('public.users') IS NULL THEN NULL ELSE (SELECT count(*) FROM users) END,
        'workouts', CASE WHEN to_regclass('public.workouts') IS NULL THEN NULL ELSE (SELECT count(*) FROM workouts) END,
        'segments', CASE WHEN to_regclass('public.gps_segments') IS NULL THEN NULL ELSE (SELECT count(*) FROM gps_segments) END,
        'admins', CASE WHEN to_regclass('public.user_roles') IS NULL THEN NULL ELSE (SELECT count(*) FROM user_roles WHERE role = 'admin') END
      )::text;`
    ], { env: childEnv });
    const currentGitCommit = await readOptionalGitCommit();
    const result = {
      backupId: manifest.backupId,
      backupRoot,
      sourceDatabase,
      logicalDatabase,
      targetDatabase,
      environment,
      databaseCreated,
      validation: JSON.parse(validationResult.stdout),
      backupGitCommit: manifest.tool?.gitCommit || null,
      currentGitCommit,
      schemaCompatibility: manifest.tool?.gitCommit && currentGitCommit
        ? (manifest.tool.gitCommit === currentGitCommit ? "same-commit" : "migration-review-required")
        : "unknown",
      totalMs: Date.now() - startedAt
    };
    if (options["result-file"]) {
      await fs.writeFile(options["result-file"], `${JSON.stringify(result)}\n`, { mode: 0o600 });
    }
    console.log("Isolated PostgreSQL restore prepared", result);
  } catch (error) {
    if (databaseCreated) {
      console.error(`Restore database ${targetDatabase} was left in place for inspection.`);
    }
    throw error;
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
    await releaseLock();
  }
}

prepareRestore().catch((error) => {
  console.error("PostgreSQL restore preparation failed:", error.message);
  process.exitCode = 1;
});
