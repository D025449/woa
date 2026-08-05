import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const runtimeDatabase = require("./runtime-database.cjs");

export const {
  assertDatabaseName,
  pointerFileForEnvironment,
  readRuntimeDatabasePointer,
  resolveRuntimeDatabaseEnvironment
} = runtimeDatabase;

export function applyRuntimeDatabasePointer(environment = process.env) {
  const resolved = resolveRuntimeDatabaseEnvironment(environment);
  environment.DB_NAME = resolved.databaseName;
  environment.BACKUP_DATABASE_ID = resolved.logicalDatabase;
  if (resolved.pointerFile) environment.BACKUP_ACTIVE_DATABASE_FILE = resolved.pointerFile;
  return resolved;
}

export async function writeRuntimeDatabasePointer({
  file,
  databaseName,
  previousDatabase,
  backupId = null,
  activatedAt = new Date()
}) {
  const active = assertDatabaseName(databaseName, "active database");
  const previous = assertDatabaseName(previousDatabase, "previous database");
  if (!file) throw new Error("BACKUP_ACTIVE_DATABASE_FILE is required for activation.");
  const target = path.resolve(file);
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  const lines = [
    "# Managed by the CWA24 PostgreSQL backup wizard.",
    `DB_NAME=${active}`,
    `PREVIOUS_DB_NAME=${previous}`,
    `ACTIVATED_AT=${new Date(activatedAt).toISOString()}`,
    `ACTIVATED_BACKUP_ID=${String(backupId || "")}`,
    ""
  ];
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    await fs.writeFile(temp, lines.join("\n"), { mode: 0o640 });
    await fs.rename(temp, target);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
  return target;
}
