import assert from "node:assert/strict";
import test from "node:test";

import {
  assertBackupRootInPrefix,
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
