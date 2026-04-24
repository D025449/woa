import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { fileURLToPath } from "url";

let poolInstance = null;
const REQUIRED_DB_ENV_VARS = ["DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD"];

function hasRequiredDbEnv() {
  return REQUIRED_DB_ENV_VARS.every((key) => {
    const value = process.env[key];
    return typeof value === "string" && value.trim().length > 0;
  });
}

function loadEnvForMigrations() {
  if (hasRequiredDbEnv()) {
    return;
  }

  const nodeEnv = process.env.NODE_ENV || "development";
  const envCandidates = [`.env.${nodeEnv}`, ".env"];

  for (const envPath of envCandidates) {
    if (!fs.existsSync(envPath)) {
      continue;
    }
    dotenv.config({ path: envPath, override: false });
    if (hasRequiredDbEnv()) {
      return;
    }
  }
}

function assertRequiredDbEnv() {
  const missing = REQUIRED_DB_ENV_VARS.filter((key) => {
    const value = process.env[key];
    return !(typeof value === "string" && value.trim().length > 0);
  });

  if (missing.length > 0) {
    throw new Error(
      `Missing DB env vars for migration runner: ${missing.join(", ")}. ` +
      "Provide them via PM2/CI environment (recommended for production) or local .env files."
    );
  }
}

async function getPool() {
  if (!poolInstance) {
    const module = await import("./services/database.js");
    poolInstance = module.default;
  }
  return poolInstance;
}

async function runMigrations() {

  // __dirname Ersatz in ESM
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  loadEnvForMigrations();
  assertRequiredDbEnv();

  try {
    const pool = await getPool();
    const forcedOrder = new Map([
      // import_jobs depends on users.uid FK, so it must run after users table creation.
      ["000_import_jobs.sql", 150]
    ]);

    const migrationFiles = fs
      .readdirSync(path.join(__dirname, "migrations"))
      .sort((a, b) => {
        const aRank = forcedOrder.has(a) ? forcedOrder.get(a) : Number.parseInt(a, 10);
        const bRank = forcedOrder.has(b) ? forcedOrder.get(b) : Number.parseInt(b, 10);

        if (aRank !== bRank) {
          return aRank - bRank;
        }

        return a.localeCompare(b);
      });

    for (const file of migrationFiles) {
      const sql = fs.readFileSync(
        path.join(__dirname, "migrations", file),
        "utf8"
      );

      console.log(`Running migration: ${file}`);
      await pool.query(sql);
    }

    console.log("Migrations complete.");
  } catch (err) {
    console.error("Migration failed:", err);
    process.exit(1);
  } finally {
    const pool = await getPool();
    await pool.end();
    poolInstance = null;
  }
}

export async function createApp() {
  await runMigrations();
}

export { runMigrations, loadEnvForMigrations, assertRequiredDbEnv };
