#!/usr/bin/env node

import os from "node:os";
import {
  getPostgresTools,
  loadBackupEnvironment,
  parseCliArgs,
  requireEnvironment,
  resolveDatabaseCreator,
  runCommand
} from "./backup-common.mjs";

function printHelp() {
  console.log(`Usage: npm run backup:promote:dev -- --restore-db <name> --confirm <dev-db>

Options:
  --restore-db <name>  Existing isolated restore database to promote
  --confirm <name>     Must exactly match DB_NAME from .env.development
  --env-file <path>    Explicit development environment file
  --admin-user <name>  Explicit PostgreSQL role used for the database rename
  --help               Show this help
`);
}

function quoteIdentifier(value) {
  if (!/^[a-z_][a-z0-9_]*$/u.test(value)) {
    throw new Error(`Unsafe PostgreSQL database identifier: ${value}`);
  }
  return `"${value}"`;
}

function quoteLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function buildPreviousDatabaseName(sourceDatabase, timestamp = new Date()) {
  const timestampPart = timestamp.toISOString()
    .replace(/[-:]/gu, "")
    .replace(/T(\d{6}).*$/u, "_$1")
    .slice(0, 15);
  const suffix = `_before_restore_${timestampPart}`;
  return `${sourceDatabase.slice(0, 63 - suffix.length)}${suffix}`;
}

async function promoteDevelopmentRestore() {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (process.env.NODE_ENV !== "development") {
    throw new Error("Development promotion requires NODE_ENV=development.");
  }

  await loadBackupEnvironment(options["env-file"]);
  requireEnvironment(["DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD"]);

  const sourceDatabase = String(process.env.DB_NAME);
  const restoreDatabase = String(options["restore-db"] || "");
  const expectedRestorePrefix = `${sourceDatabase}_restore_`;
  const expectedRestorePattern = new RegExp(
    `^${expectedRestorePrefix.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\d{8}_\\d{6}$`,
    "u"
  );
  if (!expectedRestorePattern.test(restoreDatabase)) {
    throw new Error(`Restore database must match ${expectedRestorePrefix}YYYYMMDD_HHMMSS.`);
  }
  quoteIdentifier(sourceDatabase);
  quoteIdentifier(restoreDatabase);
  if (options.confirm !== sourceDatabase) {
    throw new Error(`Promotion requires --confirm ${sourceDatabase}.`);
  }

  const previousDatabase = buildPreviousDatabaseName(sourceDatabase);
  quoteIdentifier(previousDatabase);
  const tools = getPostgresTools();
  const databaseCreator = await resolveDatabaseCreator({
    tools,
    explicitUser: options["admin-user"] || process.env.BACKUP_DB_ADMIN_USER,
    operatingSystemUser: os.userInfo().username
  });
  const psqlBaseArgs = [
    "--host", process.env.DB_HOST,
    "--port", process.env.DB_PORT,
    "--username", databaseCreator.user,
    "--dbname", "postgres",
    "--no-psqlrc", "--tuples-only", "--no-align"
  ];
  const executeSql = async (sql) => runCommand(
    tools.psql,
    [...psqlBaseArgs, "--command", sql],
    { env: databaseCreator.env }
  );

  const databaseRows = await executeSql(
    `SELECT datname FROM pg_database WHERE datname IN (${quoteLiteral(sourceDatabase)}, ${quoteLiteral(restoreDatabase)}, ${quoteLiteral(previousDatabase)}) ORDER BY datname;`
  );
  const databases = new Set(databaseRows.stdout.split(/\r?\n/u).filter(Boolean));
  if (!databases.has(sourceDatabase)) {
    throw new Error(`Source database does not exist: ${sourceDatabase}`);
  }
  if (!databases.has(restoreDatabase)) {
    throw new Error(`Restore database does not exist: ${restoreDatabase}`);
  }
  if (databases.has(previousDatabase)) {
    throw new Error(`Generated rollback database already exists: ${previousDatabase}`);
  }

  console.log("Promoting development restore database", {
    sourceDatabase,
    restoreDatabase,
    previousDatabase,
    databaseCreator: databaseCreator.user
  });

  let sourceRenamed = false;
  let restoreRenamed = false;
  try {
    await executeSql(`ALTER DATABASE ${quoteIdentifier(sourceDatabase)} WITH ALLOW_CONNECTIONS false;`);
    await executeSql(`ALTER DATABASE ${quoteIdentifier(restoreDatabase)} WITH ALLOW_CONNECTIONS false;`);
    await executeSql(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname IN (${quoteLiteral(sourceDatabase)}, ${quoteLiteral(restoreDatabase)}) AND pid <> pg_backend_pid();`
    );
    await executeSql(
      `ALTER DATABASE ${quoteIdentifier(sourceDatabase)} RENAME TO ${quoteIdentifier(previousDatabase)};`
    );
    sourceRenamed = true;
    await executeSql(
      `ALTER DATABASE ${quoteIdentifier(restoreDatabase)} RENAME TO ${quoteIdentifier(sourceDatabase)};`
    );
    restoreRenamed = true;
    await executeSql(`ALTER DATABASE ${quoteIdentifier(sourceDatabase)} WITH ALLOW_CONNECTIONS true;`);
    await executeSql(`ALTER DATABASE ${quoteIdentifier(previousDatabase)} WITH ALLOW_CONNECTIONS true;`);
  } catch (error) {
    console.error("Promotion failed; attempting to restore database names and connections.");
    if (restoreRenamed) {
      await executeSql(
        `ALTER DATABASE ${quoteIdentifier(sourceDatabase)} RENAME TO ${quoteIdentifier(restoreDatabase)};`
      ).catch(() => {});
      await executeSql(
        `ALTER DATABASE ${quoteIdentifier(previousDatabase)} RENAME TO ${quoteIdentifier(sourceDatabase)};`
      ).catch(() => {});
    } else if (sourceRenamed) {
      await executeSql(
        `ALTER DATABASE ${quoteIdentifier(previousDatabase)} RENAME TO ${quoteIdentifier(sourceDatabase)};`
      ).catch(() => {});
    }
    await executeSql(`ALTER DATABASE ${quoteIdentifier(sourceDatabase)} WITH ALLOW_CONNECTIONS true;`)
      .catch(() => {});
    await executeSql(`ALTER DATABASE ${quoteIdentifier(restoreDatabase)} WITH ALLOW_CONNECTIONS true;`)
      .catch(() => {});
    throw error;
  }

  console.log("Development restore promoted successfully", {
    activeDatabase: sourceDatabase,
    rollbackDatabase: previousDatabase,
    rollbackSql: [
      `ALTER DATABASE ${sourceDatabase} RENAME TO ${sourceDatabase}_failed_restore;`,
      `ALTER DATABASE ${previousDatabase} RENAME TO ${sourceDatabase};`
    ]
  });
}

promoteDevelopmentRestore().catch((error) => {
  console.error("Development restore promotion failed:", error.message);
  process.exitCode = 1;
});
