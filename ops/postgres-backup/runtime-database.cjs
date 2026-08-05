const fs = require("node:fs");

const DATABASE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/u;
const DEFAULT_PRODUCTION_POINTER_FILE = "/etc/cwa24/active-database.env";

function assertDatabaseName(value, label = "database name") {
  const name = String(value || "").trim();
  if (!DATABASE_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid ${label}: ${name || "<empty>"}`);
  }
  return name;
}

function parsePointerText(text) {
  const values = {};
  for (const rawLine of String(text || "").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error("Invalid active database pointer line.");
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!["DB_NAME", "PREVIOUS_DB_NAME", "ACTIVATED_AT", "ACTIVATED_BACKUP_ID"].includes(key)) {
      throw new Error(`Unsupported active database pointer key: ${key}`);
    }
    values[key] = value;
  }
  if (values.DB_NAME) values.DB_NAME = assertDatabaseName(values.DB_NAME, "DB_NAME pointer");
  if (values.PREVIOUS_DB_NAME) {
    values.PREVIOUS_DB_NAME = assertDatabaseName(values.PREVIOUS_DB_NAME, "PREVIOUS_DB_NAME pointer");
  }
  return values;
}

function pointerFileForEnvironment(environment = process.env) {
  if (String(environment.NODE_ENV || "development") !== "production") return null;
  return String(
    environment.BACKUP_ACTIVE_DATABASE_FILE || DEFAULT_PRODUCTION_POINTER_FILE
  ).trim();
}

function readRuntimeDatabasePointer(environment = process.env) {
  const file = pointerFileForEnvironment(environment);
  if (!file || !fs.existsSync(file)) return { file, values: {} };
  return { file, values: parsePointerText(fs.readFileSync(file, "utf8")) };
}

function resolveRuntimeDatabaseEnvironment(environment = process.env) {
  const pointer = readRuntimeDatabasePointer(environment);
  const fallbackDatabase = assertDatabaseName(environment.DB_NAME || "cwa24_prod", "fallback DB_NAME");
  const databaseName = pointer.values.DB_NAME || fallbackDatabase;
  const logicalDatabase = assertDatabaseName(
    environment.BACKUP_DATABASE_ID || fallbackDatabase,
    "BACKUP_DATABASE_ID"
  );
  return {
    databaseName,
    logicalDatabase,
    pointerFile: pointer.file,
    previousDatabase: pointer.values.PREVIOUS_DB_NAME || null,
    activatedAt: pointer.values.ACTIVATED_AT || null,
    activatedBackupId: pointer.values.ACTIVATED_BACKUP_ID || null
  };
}

module.exports = {
  DATABASE_NAME_PATTERN,
  DEFAULT_PRODUCTION_POINTER_FILE,
  assertDatabaseName,
  parsePointerText,
  pointerFileForEnvironment,
  readRuntimeDatabasePointer,
  resolveRuntimeDatabaseEnvironment
};
