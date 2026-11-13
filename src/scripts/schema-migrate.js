#!/usr/bin/env node
// Tracked migration runner.
//
// Usage:
//   node -- src/scripts/schema-migrate.js status        [--env-file <path>]
//   node -- src/scripts/schema-migrate.js apply         [--env-file <path>] [--yes]
//   node -- src/scripts/schema-migrate.js mark-applied  --up-to <number> [--env-file <path>]
//
// Commands:
//   status        Show which migrations are applied and which are pending.
//   apply         Apply all pending safe migrations (with confirmation prompt).
//                 Migrations containing DROP TABLE / DROP COLUMN / TRUNCATE /
//                 ALTER COLUMN TYPE are blocked and must be applied manually.
//   mark-applied  Record migrations as applied without executing them.
//                 Use after manually applying migrations to an existing DB.
//
// Options:
//   --env-file <path>   Load environment variables from a file before connecting.
//   --yes               Skip the confirmation prompt in apply.
//   --up-to <number>    For mark-applied: mark all files whose numeric prefix
//                       is <= <number>.

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import pg from "pg";
import { applyRuntimeDatabasePointer } from "../../ops/postgres-backup/runtime-database.mjs";

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_DIR = path.resolve(__dirname, "../migrations");
const TRACKING_TABLE = "schema_migrations";

// Operations that can destroy or corrupt existing data — never auto-applied.
const DESTRUCTIVE = [
  { re: /\bDROP\s+TABLE\b/i,                       label: "DROP TABLE" },
  { re: /\bDROP\s+COLUMN\b/i,                      label: "DROP COLUMN" },
  { re: /\bTRUNCATE\b/i,                            label: "TRUNCATE" },
  { re: /\bALTER\s+COLUMN\b.+?\bTYPE\b/is,         label: "ALTER COLUMN TYPE" },
];

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const command = args[0];
  const opts = { envFile: null, yes: false, upTo: null, failOnBlocked: false };
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--env-file" && args[i + 1]) { opts.envFile = args[++i]; continue; }
    if (args[i] === "--yes")                      { opts.yes = true;          continue; }
    if (args[i] === "--fail-on-blocked")          { opts.failOnBlocked = true; continue; }
    if (args[i] === "--up-to" && args[i + 1])    { opts.upTo = Number(args[++i]); continue; }
  }
  return { command, opts };
}

// ---------------------------------------------------------------------------
// Env + DB
// ---------------------------------------------------------------------------

function loadEnv(envFile) {
  if (envFile) {
    if (!fs.existsSync(envFile)) {
      console.error(`--env-file not found: ${envFile}`);
      process.exit(1);
    }
    dotenv.config({ path: envFile, override: false });
    return;
  }
  const nodeEnv = process.env.NODE_ENV || "development";
  for (const candidate of [`.env.${nodeEnv}`, ".env"]) {
    if (fs.existsSync(path.resolve(process.cwd(), candidate))) {
      dotenv.config({ path: candidate, override: false });
      return;
    }
  }
}

function makePool() {
  const required = ["DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD"];
  const missing = required.filter((k) => !process.env[k]?.trim());
  if (missing.length) {
    console.error(`Missing DB environment variables: ${missing.join(", ")}`);
    process.exit(1);
  }
  return new Pool({
    host:     process.env.DB_HOST,
    port:     Number(process.env.DB_PORT),
    database: process.env.DB_NAME,
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    max: 1,
  });
}

// ---------------------------------------------------------------------------
// Migration file helpers
// ---------------------------------------------------------------------------

function getMigrationFiles() {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort((a, b) => {
      const na = parseInt(a, 10);
      const nb = parseInt(b, 10);
      return na !== nb ? na - nb : a.localeCompare(b);
    });
}

function detectDestructive(sql) {
  return DESTRUCTIVE.filter((d) => d.re.test(sql)).map((d) => d.label);
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function bootstrap(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${TRACKING_TABLE} (
      filename   TEXT        PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function getApplied(pool) {
  const { rows } = await pool.query(`SELECT filename FROM ${TRACKING_TABLE}`);
  return new Set(rows.map((r) => r.filename));
}

async function trackApplied(pool, filename) {
  await pool.query(
    `INSERT INTO ${TRACKING_TABLE} (filename) VALUES ($1) ON CONFLICT DO NOTHING`,
    [filename]
  );
}

// ---------------------------------------------------------------------------
// Interactive confirm
// ---------------------------------------------------------------------------

function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim().toLowerCase()); });
  });
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdStatus(pool) {
  const files  = getMigrationFiles();
  const applied = await getApplied(pool);
  const pending = files.filter((f) => !applied.has(f));

  console.log(`\nMigration status: ${applied.size} applied, ${pending.length} pending (${files.length} total)\n`);
  for (const f of files) {
    if (applied.has(f)) {
      console.log(`  ✓  ${f}`);
    } else {
      const destructive = detectDestructive(
        fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8")
      );
      const warn = destructive.length ? `  ⚠  blocked: ${destructive.join(", ")}` : "";
      console.log(`  ○  ${f}${warn}`);
    }
  }
  console.log();
}

async function cmdApply(pool, opts) {
  const files   = getMigrationFiles();
  const applied = await getApplied(pool);
  const pending = files.filter((f) => !applied.has(f));

  if (pending.length === 0) {
    console.log("Nothing to apply — all migrations are up to date.");
    return;
  }

  const plan = pending.map((f) => {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8");
    return { file: f, sql, destructive: detectDestructive(sql) };
  });

  const safe    = plan.filter((m) => m.destructive.length === 0);
  const blocked = plan.filter((m) => m.destructive.length > 0);

  console.log(`\nPending migrations: ${pending.length}\n`);
  for (const m of plan) {
    if (m.destructive.length) {
      console.log(`  ✗ blocked  ${m.file}  (${m.destructive.join(", ")})`);
    } else {
      console.log(`  ○ ready    ${m.file}`);
    }
  }

  if (blocked.length > 0) {
    console.log(`\n⚠  ${blocked.length} migration(s) blocked — contain potentially destructive operations.`);
    console.log("   Review and apply them manually, then run:");
    console.log(`   npm run migrate:mark-applied -- --up-to <number>\n`);
    if (opts.failOnBlocked) {
      console.error("Aborting deploy: resolve blocked migrations before deploying.");
      process.exit(1);
    }
  }

  if (safe.length === 0) {
    console.log("No safe migrations to apply automatically.");
    return;
  }

  if (!opts.yes) {
    const answer = await confirm(`Apply ${safe.length} safe migration(s)? [y/N] `);
    if (answer !== "y" && answer !== "yes") {
      console.log("Aborted.");
      return;
    }
  }

  let applyCount = 0;
  for (const m of safe) {
    process.stdout.write(`  Applying ${m.file} ... `);
    try {
      await pool.query(m.sql);
      await trackApplied(pool, m.file);
      console.log("done");
      applyCount++;
    } catch (err) {
      console.log("FAILED");
      console.error(`\nError in ${m.file}:\n  ${err.message}`);
      console.error("\nStopped. Fix the error and re-run.");
      break;
    }
  }

  console.log(`\n${applyCount}/${safe.length} migration(s) applied.`);
  if (blocked.length > 0) {
    console.log(`${blocked.length} blocked migration(s) still require manual execution.`);
  }
}

async function cmdMarkApplied(pool, opts) {
  if (opts.upTo == null || !Number.isFinite(opts.upTo)) {
    console.error("Specify --up-to <number>  e.g.  --up-to 101");
    process.exit(1);
  }

  const files   = getMigrationFiles();
  const applied = await getApplied(pool);
  const toMark  = files
    .filter((f) => parseInt(f, 10) <= opts.upTo)
    .filter((f) => !applied.has(f));

  if (toMark.length === 0) {
    console.log(`All migrations up to ${opts.upTo} are already recorded.`);
    return;
  }

  console.log(`\nWill mark as applied (without executing):\n`);
  for (const f of toMark) console.log(`  ${f}`);

  const answer = await confirm(`\nMark ${toMark.length} migration(s) as applied? [y/N] `);
  if (answer !== "y" && answer !== "yes") { console.log("Aborted."); return; }

  for (const f of toMark) {
    await trackApplied(pool, f);
    console.log(`  recorded: ${f}`);
  }
  console.log(`\n${toMark.length} migration(s) recorded.`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const COMMANDS = ["status", "apply", "mark-applied"];

async function main() {
  const { command, opts } = parseArgs();

  if (!COMMANDS.includes(command)) {
    console.error("Usage: node -- src/scripts/schema-migrate.js <command> [options]\n");
    console.error("Commands:");
    console.error("  status                                Show migration status");
    console.error("  apply        [--yes] [--env-file f]  Apply pending safe migrations");
    console.error("  mark-applied --up-to <n> [--env-file f]");
    console.error("               Mark migrations as applied without executing them");
    process.exit(1);
  }

  loadEnv(opts.envFile);
  applyRuntimeDatabasePointer(process.env);
  const pool = makePool();

  try {
    await bootstrap(pool);
    if      (command === "status")       await cmdStatus(pool);
    else if (command === "apply")        await cmdApply(pool, opts);
    else if (command === "mark-applied") await cmdMarkApplied(pool, opts);
  } catch (err) {
    console.error(`\nFatal: ${err.message}`);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
