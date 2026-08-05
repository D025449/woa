import assert from "node:assert/strict";
import test from "node:test";

import {
  assertBackupRootInPrefix,
  classifyManagedDatabases,
  normalizeBackupRoot
} from "../src/services/postgresBackupCatalogService.js";

const prefix = "backups/postgres/development/cwa24_dev";
const root = `${prefix}/2026/08/05/2026-08-05T06-22-47Z-backup-id`;

test("backup catalog normalizes S3 and manifest references", () => {
  assert.equal(normalizeBackupRoot(`s3://bucket/${root}/manifest.json`), root);
  assert.equal(normalizeBackupRoot(`${root}/manifest.json`), root);
});

test("backup catalog accepts only dated roots below the active environment", () => {
  assert.equal(assertBackupRootInPrefix(root, prefix), root);
  assert.throws(
    () => assertBackupRootInPrefix(
      "backups/postgres/production/cwa24_prod/2026/08/05/backup",
      prefix
    ),
    /outside the active environment/
  );
  assert.throws(
    () => assertBackupRootInPrefix(`${prefix}-other/2026/08/05/backup`, prefix),
    /outside the active environment/
  );
  assert.throws(
    () => assertBackupRootInPrefix(`${prefix}/latest`, prefix),
    /invalid structure/
  );
});

test("managed database inventory protects active and rollback databases", () => {
  const databases = classifyManagedDatabases([
    { datname: "cwa24_prod_restore_20260805_090000", size_bytes: "200" },
    { datname: "postgres", size_bytes: "1" },
    { datname: "cwa24_prod", size_bytes: "300" },
    { datname: "cwa24_prod_restore_20260804_090000", size_bytes: "100" }
  ], {
    database: "cwa24_prod",
    activeDatabase: "cwa24_prod_restore_20260805_090000",
    previousDatabase: "cwa24_prod",
    deletionSupported: true
  });

  assert.deepEqual(databases, [
    {
      name: "cwa24_prod_restore_20260805_090000",
      sizeBytes: 200,
      status: "active",
      deletable: false
    },
    { name: "cwa24_prod", sizeBytes: 300, status: "rollback", deletable: false },
    {
      name: "cwa24_prod_restore_20260804_090000",
      sizeBytes: 100,
      status: "inactive",
      deletable: true
    }
  ]);
});
