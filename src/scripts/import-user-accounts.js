import fs from "node:fs/promises";
import path from "node:path";

import "../config/env.js";
import pool from "../services/database.js";
import UserAccountBackupService from "../services/userAccountBackupService.js";

function fileArgument(argv) {
  const index = argv.indexOf("--file");
  return index >= 0 ? argv[index + 1] : null;
}

try {
  const input = fileArgument(process.argv.slice(2));
  if (!input) {
    throw new Error("Usage: npm run accounts:import -- --file <backup.json>");
  }
  const file = path.resolve(input);
  const backup = JSON.parse(await fs.readFile(file, "utf8"));
  const counts = await UserAccountBackupService.importAll(backup);
  console.log("User account backup imported", { file, counts });
} catch (error) {
  console.error("User account backup import failed:", error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
