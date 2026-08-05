import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  acquireBackupLock,
  buildBackupLocation,
  normalizeS3Prefix,
  parseCliArgs,
  parseEnvText,
  sanitizeKeyPart
} from "../ops/postgres-backup/backup-common.mjs";

test("backup CLI arguments support values and flags", () => {
  assert.deepEqual(
    parseCliArgs(["--env-file", "/tmp/backup.env", "--label=before migration", "--help"]),
    {
      "env-file": "/tmp/backup.env",
      label: "before migration",
      help: true
    }
  );
});

test("backup env parser handles comments, export, and quoted values", () => {
  assert.deepEqual(
    parseEnvText(`
# comment
export DB_NAME=cwa24_prod
DB_PASSWORD="secret value"
AWS_REGION='eu-central-1'
`),
    {
      DB_NAME: "cwa24_prod",
      DB_PASSWORD: "secret value",
      AWS_REGION: "eu-central-1"
    }
  );
});

test("backup S3 keys are deterministic and folder-like", () => {
  const location = buildBackupLocation({
    prefix: "/backups//postgres/",
    environment: "production",
    databaseName: "cwa24 prod",
    timestamp: new Date("2026-08-05T14:32:18.123Z"),
    backupId: "abc-123"
  });

  assert.equal(
    location.root,
    "backups/postgres/production/cwa24-prod/2026/08/05/2026-08-05T14-32-18Z-abc-123"
  );
  assert.equal(location.dumpKey, `${location.root}/database.dump`);
  assert.equal(location.manifestKey, `${location.root}/manifest.json`);
});

test("backup key sanitization removes unsafe separators", () => {
  assert.equal(sanitizeKeyPart(" before / migration "), "before-migration");
  assert.equal(normalizeS3Prefix("//backups///postgres//"), "backups/postgres");
});

test("backup lock prevents a concurrent backup and can be released", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cwa24-backup-lock-test-"));
  try {
    const release = await acquireBackupLock("localhost/test", { directory });
    await assert.rejects(
      acquireBackupLock("localhost/test", { directory }),
      /Another PostgreSQL backup is active/
    );
    await release();
    const releaseAgain = await acquireBackupLock("localhost/test", { directory });
    await releaseAgain();
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
