import fs from "node:fs/promises";
import path from "node:path";

import "../config/env.js";
import pool from "../services/database.js";
import UserAccountBackupService, {
  buildUserAccountBackupFilename
} from "../services/userAccountBackupService.js";

function outputArgument(argv) {
  const index = argv.indexOf("--output");
  return index >= 0 ? argv[index + 1] : null;
}

try {
  const backup = await UserAccountBackupService.exportAll();
  const output = path.resolve(outputArgument(process.argv.slice(2)) || buildUserAccountBackupFilename(backup.createdAt));
  await fs.writeFile(output, `${JSON.stringify(backup, null, 2)}\n`, { mode: 0o600 });
  console.log("User account backup exported", {
    output,
    users: backup.userCount
  });
} catch (error) {
  console.error("User account backup export failed:", error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
