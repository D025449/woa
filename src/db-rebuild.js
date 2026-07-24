import { runMigrations, loadEnvForMigrations, assertRequiredDbEnv } from "./migrate-internal.js";

function getConfirmedDatabaseName() {
  const args = process.argv.slice(2);
  const confirmIndex = args.indexOf("--confirm");
  if (confirmIndex >= 0 && args[confirmIndex + 1]) {
    return String(args[confirmIndex + 1]).trim();
  }
  return String(process.env.DB_REBUILD_CONFIRM || "").trim();
}

function assertRebuildConfirmed() {
  const databaseName = String(process.env.DB_NAME || "").trim();
  const confirmedName = getConfirmedDatabaseName();
  if (!databaseName || confirmedName !== databaseName) {
    throw new Error(
      `Database rebuild requires --confirm ${databaseName || "<DB_NAME>"} `
      + "or DB_REBUILD_CONFIRM with the exact database name."
    );
  }
}

async function resetAppSchema() {
  loadEnvForMigrations();
  assertRequiredDbEnv();
  assertRebuildConfirmed();

  const { default: pool } = await import("./services/database.js");
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // The old schema contains geometry columns owned by PostGIS. CASCADE is
    // intentional here because the complete public schema is rebuilt below.
    await client.query("DROP EXTENSION IF EXISTS postgis_tiger_geocoder CASCADE;");
    await client.query("DROP EXTENSION IF EXISTS postgis_topology CASCADE;");
    await client.query("DROP EXTENSION IF EXISTS postgis CASCADE;");
    await client.query("DROP SCHEMA IF EXISTS public CASCADE;");
    await client.query("CREATE SCHEMA public AUTHORIZATION CURRENT_USER;");
    await client.query("GRANT USAGE ON SCHEMA public TO PUBLIC;");

    await client.query("COMMIT");
    console.log("App schema reset complete.");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function rebuildDatabase() {
  try {
    console.log("Resetting app schema...");
    await resetAppSchema();

    console.log("Running migrations...");
    await runMigrations({ allowExistingSchema: true });

    console.log("Database rebuild complete.");
  } catch (err) {
    console.error("Database rebuild failed:", err);
    process.exit(1);
  }
}

await rebuildDatabase();
