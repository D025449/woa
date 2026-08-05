#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildAwsS3CpArgs,
  getPostgresTools,
  loadBackupEnvironment,
  parseCliArgs,
  requireEnvironment,
  runCommand,
  s3Uri,
  sha256File
} from "./backup-common.mjs";

function printHelp() {
  console.log(`Usage: node ops/postgres-backup/verify-backup.mjs --backup-prefix <key> [options]

Options:
  --backup-prefix <key>  S3 key prefix containing manifest.json
  --env-file <path>      Explicit backup environment file
  --result-file <path>   Write the machine-readable result as JSON
  --help                 Show this help
`);
}

async function verifyBackup() {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (!options["backup-prefix"]) {
    throw new Error("Missing required --backup-prefix.");
  }

  await loadBackupEnvironment(options["env-file"]);
  requireEnvironment(["AWS_REGION"]);
  const bucket = String(process.env.BACKUP_S3_BUCKET || process.env.S3_BUCKET || "").trim();
  if (!bucket) {
    throw new Error("Missing BACKUP_S3_BUCKET or S3_BUCKET.");
  }

  const awsCli = process.env.BACKUP_AWS_CLI_PATH || "aws";
  const tools = getPostgresTools();
  const root = String(options["backup-prefix"]).replace(/^\/+|\/+$/gu, "");
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "cwa24-pg-verify-"));
  const manifestFile = path.join(tempDirectory, "manifest.json");
  const dumpFile = path.join(tempDirectory, "database.dump");

  try {
    await runCommand(awsCli, buildAwsS3CpArgs(
      s3Uri(bucket, `${root}/manifest.json`),
      manifestFile
    ), { inheritStdout: true });
    const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
    if (manifest.format !== "cwa24-postgres-backup-manifest" || manifest.status !== "complete") {
      throw new Error("S3 object is not a complete CWA24 PostgreSQL backup manifest.");
    }
    if (manifest.archive?.bucket !== bucket || !manifest.archive?.key) {
      throw new Error("Backup manifest references an unexpected bucket or missing archive key.");
    }

    await runCommand(awsCli, buildAwsS3CpArgs(
      s3Uri(bucket, manifest.archive.key),
      dumpFile
    ), { inheritStdout: true });
    const actualSha256 = await sha256File(dumpFile);
    if (actualSha256 !== manifest.archive.sha256) {
      throw new Error(`Backup checksum mismatch: expected ${manifest.archive.sha256}, got ${actualSha256}`);
    }
    const stat = await fs.stat(dumpFile);
    if (stat.size !== manifest.archive.sizeBytes) {
      throw new Error(`Backup size mismatch: expected ${manifest.archive.sizeBytes}, got ${stat.size}`);
    }
    await runCommand(tools.pgRestore, ["--list", dumpFile]);

    const result = {
      backupId: manifest.backupId,
      createdAt: manifest.createdAt,
      rootKey: root,
      archive: s3Uri(bucket, manifest.archive.key),
      sizeBytes: stat.size,
      sha256: actualSha256
    };
    if (options["result-file"]) {
      await fs.writeFile(options["result-file"], `${JSON.stringify(result)}\n`, { mode: 0o600 });
    }
    console.log("PostgreSQL backup verified", result);
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
}

verifyBackup().catch((error) => {
  console.error("PostgreSQL backup verification failed:", error.message);
  process.exitCode = 1;
});
