#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildAwsS3CpArgs,
  loadBackupEnvironment,
  parseCliArgs,
  requireEnvironment,
  runCommand,
  s3Uri,
  validatePostgresBackupDeletion
} from "./backup-common.mjs";

function printHelp() {
  console.log(`Usage: node ops/postgres-backup/delete-backup.mjs --backup-prefix <key> --confirm <id-prefix> [options]

Options:
  --backup-prefix <key>  S3 key prefix containing manifest.json
  --confirm <id-prefix>  First eight characters of the backup ID
  --env-file <path>      Explicit backup environment file
  --result-file <path>   Write the machine-readable result as JSON
  --help                 Show this help
`);
}

async function listBackupObjects(awsCli, bucket, root) {
  const response = await runCommand(awsCli, [
    "s3api", "list-objects-v2",
    "--bucket", bucket,
    "--prefix", `${root}/`,
    "--region", process.env.AWS_REGION,
    "--output", "json",
    "--no-cli-pager"
  ]);
  return JSON.parse(response.stdout || "{}").Contents || [];
}

async function deleteObjects(awsCli, bucket, objects, tempDirectory) {
  for (let index = 0; index < objects.length; index += 1000) {
    const batch = objects.slice(index, index + 1000);
    const requestFile = path.join(tempDirectory, `delete-${index}.json`);
    await fs.writeFile(requestFile, JSON.stringify({
      Objects: batch.map((object) => ({ Key: object.Key })),
      Quiet: true
    }));
    await runCommand(awsCli, [
      "s3api", "delete-objects",
      "--bucket", bucket,
      "--delete", `file://${requestFile}`,
      "--region", process.env.AWS_REGION,
      "--no-cli-pager"
    ]);
  }
}

async function deleteBackup() {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (!options["backup-prefix"] || !options.confirm) {
    throw new Error("Backup prefix and confirmation are required.");
  }

  await loadBackupEnvironment(options["env-file"]);
  requireEnvironment(["AWS_REGION"]);
  const bucket = String(process.env.BACKUP_S3_BUCKET || process.env.S3_BUCKET || "").trim();
  if (!bucket) throw new Error("Missing BACKUP_S3_BUCKET or S3_BUCKET.");

  const awsCli = process.env.BACKUP_AWS_CLI_PATH || "aws";
  const root = String(options["backup-prefix"]).replace(/^\/+|\/+$/gu, "");
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "cwa24-pg-delete-"));
  const manifestFile = path.join(tempDirectory, "manifest.json");

  try {
    await runCommand(awsCli, buildAwsS3CpArgs(
      s3Uri(bucket, `${root}/manifest.json`),
      manifestFile
    ));
    const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
    const deletion = validatePostgresBackupDeletion({
      manifest,
      bucket,
      root,
      confirmation: options.confirm
    });

    const objects = await listBackupObjects(awsCli, bucket, root);
    const manifestObject = objects.find((object) => object.Key === deletion.manifestKey);
    const dataObjects = objects.filter((object) => object.Key !== deletion.manifestKey);

    // Keep the manifest discoverable if deleting any backup data fails.
    await deleteObjects(awsCli, bucket, dataObjects, tempDirectory);
    if (manifestObject) await deleteObjects(awsCli, bucket, [manifestObject], tempDirectory);

    const result = {
      backupId: deletion.backupId,
      rootKey: root,
      deletedObjects: dataObjects.length + (manifestObject ? 1 : 0),
      deletedBytes: objects.reduce((sum, object) => sum + (Number(object.Size) || 0), 0)
    };
    if (options["result-file"]) {
      await fs.writeFile(options["result-file"], `${JSON.stringify(result)}\n`, { mode: 0o600 });
    }
    console.log("PostgreSQL backup deleted", result);
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
}

deleteBackup().catch((error) => {
  console.error("PostgreSQL backup deletion failed:", error.message);
  process.exitCode = 1;
});
