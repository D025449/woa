#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  acquireBackupLock,
  buildAwsS3CpArgs,
  buildBackupLocation,
  buildPgDumpArgs,
  getPostgresTools,
  loadBackupEnvironment,
  parseCliArgs,
  readOptionalGitCommit,
  requireEnvironment,
  runCommand,
  s3Uri,
  sanitizeKeyPart,
  sha256File
} from "./backup-common.mjs";
import {
  applyRuntimeDatabasePointer,
  assertManagedDatabaseName
} from "./runtime-database.mjs";

function printHelp() {
  console.log(`Usage: node ops/postgres-backup/create-backup.mjs [options]

Options:
  --env-file <path>  Explicit backup environment file
  --label <text>     Optional label stored in the manifest
  --source-db <name> Internal managed database to back up instead of the active database
  --result-file <path> Write the machine-readable result as JSON
  --help             Show this help
`);
}

async function createBackup() {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const startedAt = Date.now();
  const envFile = await loadBackupEnvironment(options["env-file"]);
  const runtimeDatabase = applyRuntimeDatabasePointer();
  requireEnvironment(["DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD", "AWS_REGION"]);

  const bucket = String(process.env.BACKUP_S3_BUCKET || process.env.S3_BUCKET || "").trim();
  if (!bucket) {
    throw new Error("Missing BACKUP_S3_BUCKET or S3_BUCKET.");
  }

  const awsCli = process.env.BACKUP_AWS_CLI_PATH || "aws";
  const sourceDatabase = options["source-db"]
    ? assertManagedDatabaseName(options["source-db"], runtimeDatabase.logicalDatabase, "backup source")
    : process.env.DB_NAME;
  const tools = getPostgresTools();
  const backupId = randomUUID();
  const timestamp = new Date();
  const environment = process.env.BACKUP_ENVIRONMENT || process.env.NODE_ENV || "unknown";
  const location = buildBackupLocation({
    prefix: process.env.BACKUP_S3_PREFIX,
    environment,
    databaseName: runtimeDatabase.logicalDatabase,
    timestamp,
    backupId
  });
  const releaseLock = await acquireBackupLock(
    `${process.env.DB_HOST}:${process.env.DB_PORT}/${sourceDatabase}`
  );
  let tempDirectory = null;
  const childEnv = { ...process.env, PGPASSWORD: process.env.DB_PASSWORD };

  console.log("Creating PostgreSQL backup", {
    environment,
    database: sourceDatabase,
    logicalDatabase: runtimeDatabase.logicalDatabase,
    bucket,
    rootKey: location.root,
    envFile
  });

  try {
    tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "cwa24-pg-backup-"));
    const dumpFile = path.join(tempDirectory, "database.dump");
    const manifestFile = path.join(tempDirectory, "manifest.json");
    const [pgDumpVersion, pgRestoreVersion, serverVersion, databaseSize, awsVersion] = await Promise.all([
      runCommand(tools.pgDump, ["--version"]),
      runCommand(tools.pgRestore, ["--version"]),
      runCommand(tools.psql, [
        "--host", process.env.DB_HOST,
        "--port", process.env.DB_PORT,
        "--username", process.env.DB_USER,
        "--dbname", sourceDatabase,
        "--no-psqlrc", "--tuples-only", "--no-align",
        "--command", "SHOW server_version;"
      ], { env: childEnv }),
      runCommand(tools.psql, [
        "--host", process.env.DB_HOST,
        "--port", process.env.DB_PORT,
        "--username", process.env.DB_USER,
        "--dbname", sourceDatabase,
        "--no-psqlrc", "--tuples-only", "--no-align",
        "--command", "SELECT pg_database_size(current_database());"
      ], { env: childEnv }),
      runCommand(awsCli, ["--version"])
    ]);

    const dumpStartedAt = Date.now();
    await runCommand(tools.pgDump, buildPgDumpArgs({
      outputFile: dumpFile,
      databaseName: sourceDatabase
    }), { env: childEnv });
    const dumpMs = Date.now() - dumpStartedAt;

    const verifyStartedAt = Date.now();
    await runCommand(tools.pgRestore, ["--list", dumpFile]);
    const verifyMs = Date.now() - verifyStartedAt;

    const dumpStat = await fs.stat(dumpFile);
    const sha256 = await sha256File(dumpFile);
    const gitCommit = await readOptionalGitCommit();
    const manifest = {
      format: "cwa24-postgres-backup-manifest",
      version: 2,
      status: "complete",
      backupId,
      createdAt: timestamp.toISOString(),
      label: options.label ? sanitizeKeyPart(options.label) : null,
      environment,
      database: {
        name: sourceDatabase,
        physicalName: sourceDatabase,
        logicalName: runtimeDatabase.logicalDatabase,
        serverVersion: serverVersion.stdout,
        sourceSizeBytes: Number(databaseSize.stdout)
      },
      archive: {
        format: "postgres-custom",
        compression: "gzip-level-1",
        bucket,
        key: location.dumpKey,
        sizeBytes: dumpStat.size,
        sha256
      },
      tool: {
        nodeVersion: process.version,
        pgDumpVersion: pgDumpVersion.stdout,
        pgRestoreVersion: pgRestoreVersion.stdout,
        awsCliVersion: awsVersion.stderr || awsVersion.stdout,
        appVersion: process.env.APP_VERSION || null,
        gitCommit
      },
      timingsMs: {
        dump: dumpMs,
        localVerification: verifyMs
      }
    };
    const uploadStartedAt = Date.now();
    await runCommand(awsCli, buildAwsS3CpArgs(
      dumpFile,
      s3Uri(bucket, location.dumpKey),
      { contentType: "application/octet-stream", sha256 }
    ), { inheritStdout: true });
    manifest.timingsMs.dumpUpload = Date.now() - uploadStartedAt;
    manifest.timingsMs.totalBeforeManifestUpload = Date.now() - startedAt;
    await fs.writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

    const manifestUploadStartedAt = Date.now();
    await runCommand(awsCli, buildAwsS3CpArgs(
      manifestFile,
      s3Uri(bucket, location.manifestKey),
      { contentType: "application/json" }
    ), { inheritStdout: true });
    const totalMs = Date.now() - startedAt;

    const result = {
      backupId,
      manifest: s3Uri(bucket, location.manifestKey),
      rootKey: location.root,
      dump: s3Uri(bucket, location.dumpKey),
      sizeBytes: dumpStat.size,
      sha256,
      manifestUploadMs: Date.now() - manifestUploadStartedAt,
      totalMs
    };
    if (options["result-file"]) {
      await fs.writeFile(options["result-file"], `${JSON.stringify(result)}\n`, { mode: 0o600 });
    }
    console.log("PostgreSQL backup completed", result);
  } finally {
    if (tempDirectory) {
      await fs.rm(tempDirectory, { recursive: true, force: true });
    }
    await releaseLock();
  }
}

createBackup().catch((error) => {
  console.error("PostgreSQL backup failed:", error.message);
  process.exitCode = 1;
});
