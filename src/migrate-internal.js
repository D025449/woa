import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import pool from "./services/database.js";


async function runMigrations() {

  // __dirname Ersatz in ESM
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  dotenv.config({
    path: `.env.${process.env.NODE_ENV || "development"}`
  });

  try {
    const migrationFiles = fs
      .readdirSync(path.join(__dirname, "migrations"))
      .sort();

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
    await pool.end();
  }
}

export async function createApp() {
  await runMigrations();
}


