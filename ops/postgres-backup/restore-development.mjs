#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildAwsS3CpArgs,
  buildCreateDatabaseInvocation,
  buildRestoreDatabaseName,
  getPostgresTools,
  loadBackupEnvironment,
  normalizeS3Prefix,
  parseCliArgs,
  requireEnvironment,
  resolveDatabaseCreator,
  runCommand,
  s3Uri,
  sanitizeKeyPart,
  selectLatestManifestKey,
  sha256File
} from "./backup-common.mjs";

function printHelp() {
  console.log(`Usage: NODE_ENV=development npm run backup:restore:dev -- [options]

Options:
  --backup-prefix <key>  Restore a specific backup instead of the latest Dev backup
  --env-file <path>      Explicit development environment file
  --admin-user <name>    Explicit PostgreSQL role used only to create the restore DB
  --help                 Show this help
`);
}

function normalizeBackupRoot(value) {
  return String(value || "")
    .replace(/^s3:\/\/[^/]+\//u, "")
    .replace(/\/manifest\.json$/u, "")
    .replace(/^\/+|\/+$/gu, "");
}

async function findLatestBackupRoot({ awsCli, bucket, sourceDatabase }) {
  const prefix = [
    normalizeS3Prefix(process.env.BACKUP_S3_PREFIX),
    "development",
    sanitizeKeyPart(sourceDatabase)
  ].join("/");
  const result = await runCommand(awsCli, [
    "s3api", "list-objects-v2",
    "--bucket", bucket,
    "--prefix", prefix,
    "--output", "json"
  ]);
  const response = JSON.parse(result.stdout || "{}");
  const manifestKey = selectLatestManifestKey(response.Contents, prefix);
  if (!manifestKey) {
    throw new Error(`No complete development backup manifest found below s3://${bucket}/${prefix}/.`);
  }
  return normalizeBackupRoot(manifestKey);
}

async function restoreDevelopmentBackup() {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (process.env.NODE_ENV !== "development") {
    throw new Error("Development restore requires NODE_ENV=development.");
  }

  const envFile = await loadBackupEnvironment(options["env-file"]);
  requireEnvironment([
    "DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD", "AWS_REGION"
  ]);

  const sourceDatabase = process.env.DB_NAME;
  const targetDatabase = buildRestoreDatabaseName(sourceDatabase);
  if (targetDatabase === sourceDatabase || !targetDatabase.includes("_restore_")) {
    throw new Error("Refusing to restore without a generated restore database name.");
  }

  const bucket = String(process.env.BACKUP_S3_BUCKET || process.env.S3_BUCKET || "").trim();
  if (!bucket) {
    throw new Error("Missing BACKUP_S3_BUCKET or S3_BUCKET.");
  }

  const awsCli = process.env.BACKUP_AWS_CLI_PATH || "aws";
  const tools = getPostgresTools();
  const childEnv = { ...process.env, PGPASSWORD: process.env.DB_PASSWORD };
  const databaseCreator = await resolveDatabaseCreator({
    tools,
    explicitUser: options["admin-user"] || process.env.BACKUP_DB_ADMIN_USER,
    operatingSystemUser: os.userInfo().username
  });
  const backupRoot = options["backup-prefix"]
    ? normalizeBackupRoot(options["backup-prefix"])
    : await findLatestBackupRoot({ awsCli, bucket, sourceDatabase });
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "cwa24-pg-restore-dev-"));
  const manifestFile = path.join(tempDirectory, "manifest.json");
  const dumpFile = path.join(tempDirectory, "database.dump");
  let databaseCreated = false;

  console.log("Preparing development PostgreSQL restore", {
    sourceDatabase,
    targetDatabase,
    backup: s3Uri(bucket, backupRoot),
    envFile,
    databaseCreator: databaseCreator.user,
    databaseCreatorSource: databaseCreator.source
  });

  try {
    await runCommand(awsCli, buildAwsS3CpArgs(
      s3Uri(bucket, `${backupRoot}/manifest.json`),
      manifestFile
    ), { inheritStdout: true });
    const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
    if (manifest.format !== "cwa24-postgres-backup-manifest" || manifest.status !== "complete") {
      throw new Error("Selected S3 object is not a complete CWA24 PostgreSQL backup.");
    }
    if (manifest.environment !== "development") {
      throw new Error(`Refusing to restore a ${manifest.environment || "unknown"} backup in Dev mode.`);
    }
    if (manifest.database?.name !== sourceDatabase) {
      throw new Error(
        `Backup database ${manifest.database?.name || "unknown"} does not match ${sourceDatabase}.`
      );
    }
    if (manifest.archive?.bucket !== bucket || !manifest.archive?.key) {
      throw new Error("Backup manifest references an unexpected bucket or missing archive key.");
    }

    await runCommand(awsCli, buildAwsS3CpArgs(
      s3Uri(bucket, manifest.archive.key),
      dumpFile
    ), { inheritStdout: true });
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

    console.log("Creating isolated restore database", { targetDatabase, owner: process.env.DB_USER });
    const createDatabase = buildCreateDatabaseInvocation({
      tools,
      creator: databaseCreator,
      targetDatabase,
      owner: process.env.DB_USER
    });
    await runCommand(createDatabase.command, createDatabase.args, { env: createDatabase.env });
    databaseCreated = true;

    console.log("Restoring PostgreSQL archive", { targetDatabase });
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
    ], { env: childEnv, inheritStdout: true });

    const validation = await runCommand(tools.psql, [
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
        'users', (SELECT count(*) FROM users),
        'workouts', (SELECT count(*) FROM workouts)
      )::text;`
    ], { env: childEnv });

    console.log("Development PostgreSQL restore completed", {
      targetDatabase,
      validation: JSON.parse(validation.stdout),
      startCommand: `DB_NAME=${targetDatabase} PORT=3001 NODE_ENV=development npm start`
    });
  } catch (error) {
    if (databaseCreated) {
      console.error(`Restore database ${targetDatabase} was left in place for inspection.`);
    }
    throw error;
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
}

restoreDevelopmentBackup().catch((error) => {
  console.error("Development PostgreSQL restore failed:", error.message);
  process.exitCode = 1;
});
