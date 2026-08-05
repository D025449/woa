import "../config/env.js";
import AdminBootstrapService from "../services/adminBootstrapService.js";
import pool from "../services/database.js";

const DEFAULT_BOOTSTRAP_ADMIN_EMAIL = String(
  process.env.BOOTSTRAP_ADMIN_EMAIL || "rainersoltek@cwa24.de"
).trim().toLowerCase();

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (!["--auth-sub", "--email", "--confirm"].includes(argument)) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${argument}.`);
    }
    options[argument.slice(2)] = value;
    index += 1;
  }
  return options;
}

function printHelp() {
  console.log(`Usage:
  NODE_ENV=development npm run admin:bootstrap
  NODE_ENV=development npm run admin:bootstrap -- --auth-sub <sub> --confirm <sub>
  NODE_ENV=development npm run admin:bootstrap -- --email <email> --confirm <email>

Without arguments, the configured default email is used:
  ${DEFAULT_BOOTSTRAP_ADMIN_EMAIL}

The command creates only the first admin. It is idempotent for that same user
and refuses to grant another admin after bootstrap has completed.
`);
}

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printHelp();
  } else {
    const usesDefault = !options["auth-sub"] && !options.email && !options.confirm;
    const result = await AdminBootstrapService.bootstrap({
      authSub: options["auth-sub"],
      email: usesDefault ? DEFAULT_BOOTSTRAP_ADMIN_EMAIL : options.email,
      confirm: usesDefault ? DEFAULT_BOOTSTRAP_ADMIN_EMAIL : options.confirm
    });
    console.log(result.created ? "First admin created" : "Admin already bootstrapped", result.user);
  }
} catch (error) {
  console.error("Admin bootstrap failed:", error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
