import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  acquireBackupLock,
  buildBackupLocation,
  buildCreateDatabaseInvocation,
  buildDatabaseCreatorCandidates,
  buildRestoreDatabaseName,
  normalizeS3Prefix,
  parseCliArgs,
  parseEnvText,
  sanitizeKeyPart,
  selectLatestManifestKey
} from "../ops/postgres-backup/backup-common.mjs";
import {
  applyRuntimeDatabasePointer,
  writeRuntimeDatabasePointer
} from "../ops/postgres-backup/runtime-database.mjs";

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

test("restore database names are isolated and stay within PostgreSQL limits", () => {
  const name = buildRestoreDatabaseName(
    "cwa24_dev",
    new Date("2026-08-05T08:45:12.000Z")
  );
  assert.equal(name, "cwa24_dev_restore_20260805_084512");
  assert.ok(name.length <= 63);
  assert.ok(buildRestoreDatabaseName("x".repeat(100)).length <= 63);
});

test("latest backup selection only considers manifests below the expected prefix", () => {
  const prefix = "backups/postgres/development/cwa24_dev";
  const key = selectLatestManifestKey([
    {
      Key: `${prefix}/2026/08/04/old/manifest.json`,
      LastModified: "2026-08-04T10:00:00Z"
    },
    {
      Key: `${prefix}/2026/08/05/new/manifest.json`,
      LastModified: "2026-08-05T10:00:00Z"
    },
    {
      Key: "backups/postgres/production/cwa24_prod/latest/manifest.json",
      LastModified: "2026-08-06T10:00:00Z"
    }
  ], prefix);
  assert.equal(key, `${prefix}/2026/08/05/new/manifest.json`);
});

test("database creator candidates prefer explicit and OS users without duplicates", () => {
  assert.deepEqual(buildDatabaseCreatorCandidates({
    explicitUser: "postgres",
    operatingSystemUser: "D025449",
    appUser: "cwa24user"
  }), ["postgres", "D025449", "cwa24user"]);
  assert.deepEqual(buildDatabaseCreatorCandidates({
    explicitUser: "D025449",
    operatingSystemUser: "D025449",
    appUser: "cwa24user"
  }), ["D025449", "cwa24user"]);
});

test("production runtime pointer separates physical and logical database names", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cwa24-db-pointer-test-"));
  const pointerFile = path.join(directory, "active-database.env");
  try {
    await writeRuntimeDatabasePointer({
      file: pointerFile,
      databaseName: "cwa24_prod_restore_20260805_084512",
      previousDatabase: "cwa24_prod",
      backupId: "backup-123",
      activatedAt: new Date("2026-08-05T09:00:00Z")
    });
    const environment = {
      NODE_ENV: "production",
      DB_NAME: "cwa24_prod",
      BACKUP_DATABASE_ID: "cwa24_prod",
      BACKUP_ACTIVE_DATABASE_FILE: pointerFile
    };
    const resolved = applyRuntimeDatabasePointer(environment);
    assert.equal(environment.DB_NAME, "cwa24_prod_restore_20260805_084512");
    assert.equal(environment.BACKUP_DATABASE_ID, "cwa24_prod");
    assert.equal(resolved.previousDatabase, "cwa24_prod");
    assert.equal(resolved.activatedBackupId, "backup-123");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("development ignores the production runtime pointer", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cwa24-db-pointer-dev-test-"));
  const pointerFile = path.join(directory, "active-database.env");
  try {
    await fs.writeFile(pointerFile, "DB_NAME=wrong_for_dev\n");
    const environment = {
      NODE_ENV: "development",
      DB_NAME: "cwa24_dev",
      BACKUP_ACTIVE_DATABASE_FILE: pointerFile
    };
    const resolved = applyRuntimeDatabasePointer(environment);
    assert.equal(resolved.databaseName, "cwa24_dev");
    assert.equal(environment.DB_NAME, "cwa24_dev");
    assert.equal(resolved.pointerFile, null);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("database creation uses local sudo without exposing a PostgreSQL password", () => {
  const previousPort = process.env.DB_PORT;
  process.env.DB_PORT = "5432";
  try {
    const invocation = buildCreateDatabaseInvocation({
      tools: { createdb: "/usr/bin/createdb" },
      creator: {
        user: "postgres",
        source: "sudo-local",
        sudoUser: "postgres",
        env: { NODE_ENV: "production" }
      },
      targetDatabase: "cwa24_prod_restore_20260805_140000",
      owner: "cwa24user"
    });
    assert.equal(invocation.command, "sudo");
    assert.deepEqual(invocation.args, [
      "-n", "-u", "postgres", "/usr/bin/createdb",
      "--port", "5432",
      "--owner", "cwa24user",
      "--maintenance-db", "postgres",
      "cwa24_prod_restore_20260805_140000"
    ]);
    assert.equal(invocation.env.PGPASSWORD, undefined);
  } finally {
    if (previousPort === undefined) delete process.env.DB_PORT;
    else process.env.DB_PORT = previousPort;
  }
});

test("production switch validates the admin through a psql file", async () => {
  const switchSource = await fs.readFile(
    new URL("../ops/postgres-backup/switch-database.mjs", import.meta.url),
    "utf8"
  );
  const validationSql = await fs.readFile(
    new URL("../ops/postgres-backup/validate-admin-database.sql", import.meta.url),
    "utf8"
  );

  assert.match(switchSource, /"--file", validateAdminSqlFile/u);
  assert.doesNotMatch(switchSource, /"--command"[\s\S]*admin_auth_sub/u);
  assert.match(validationSql, /u\.auth_sub = :'admin_auth_sub'/u);
});
