import { runMigrations, loadEnvForMigrations, assertRequiredDbEnv } from "./migrate-internal.js";

const APP_TABLES = [
  "group_invite_sender_dismissals",
  "group_feed_event_dismissals",
  "group_feed_event_groups",
  "group_feed_events",
  "gps_segment_best_efforts",
  "gps_segment_group_shares",
  "workout_group_shares",
  "group_invites",
  "group_members",
  "groups",
  "workout_segments",
  "gps_segments",
  "workouts",
  "user_memberships",
  "payment_webhook_events",
  "payment_orders",
  "account_plans",
  "user_profiles",
  "import_jobs",
  "users"
];

const APP_VIEWS = [
  "v_gps_segment_best_efforts",
  "v_workouts_with_best_efforts"
];

const APP_FUNCTIONS = [
  "set_updated_at()",
  "get_ftp_by_period2(BIGINT, TEXT)",
  "get_cp_best_efforts(TEXT, INT[], BIGINT)"
];

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, "\"\"")}"`;
}

async function resetAppSchema() {
  loadEnvForMigrations();
  assertRequiredDbEnv();

  const { default: pool } = await import("./services/database.js");
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query("CREATE EXTENSION IF NOT EXISTS postgis;");

    for (const viewName of APP_VIEWS) {
      await client.query(`DROP VIEW IF EXISTS ${quoteIdentifier(viewName)} CASCADE;`);
    }

    for (const tableName of APP_TABLES) {
      await client.query(`DROP TABLE IF EXISTS ${quoteIdentifier(tableName)} CASCADE;`);
    }

    for (const fnSignature of APP_FUNCTIONS) {
      await client.query(`DROP FUNCTION IF EXISTS ${fnSignature} CASCADE;`);
    }

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
    await runMigrations();

    console.log("Database rebuild complete.");
  } catch (err) {
    console.error("Database rebuild failed:", err);
    process.exit(1);
  }
}

await rebuildDatabase();
