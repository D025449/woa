import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function parseCliArgs(argv = []) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      throw new Error(`Unexpected argument: ${argument}`);
    }

    const separatorIndex = argument.indexOf("=");
    const key = argument.slice(2, separatorIndex >= 0 ? separatorIndex : undefined);
    if (separatorIndex >= 0) {
      options[key] = argument.slice(separatorIndex + 1);
      continue;
    }

    const next = argv[index + 1];
    if (next != null && !next.startsWith("--")) {
      options[key] = next;
      index += 1;
    } else {
      options[key] = true;
    }
  }
  return options;
}

export function parseEnvText(text) {
  const values = {};
  for (const rawLine of String(text || "").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separatorIndex = normalized.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = normalized.slice(0, separatorIndex).trim();
    if (!ENV_KEY_PATTERN.test(key)) {
      throw new Error(`Invalid environment key in backup env file: ${key}`);
    }

    let value = normalized.slice(separatorIndex + 1).trim();
    if (
      value.length >= 2
      && ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function resolveEnvFile(explicitPath, cwd = process.cwd()) {
  if (explicitPath) {
    const resolved = path.resolve(cwd, explicitPath);
    if (!await fileExists(resolved)) {
      throw new Error(`Backup env file does not exist: ${resolved}`);
    }
    return resolved;
  }

  if (process.env.BACKUP_ENV_FILE) {
    return resolveEnvFile(process.env.BACKUP_ENV_FILE, cwd);
  }

  const systemEnvFile = "/etc/cwa24/backup.env";
  if (await fileExists(systemEnvFile)) {
    return systemEnvFile;
  }

  if (process.env.NODE_ENV) {
    const environmentFile = path.join(cwd, `.env.${process.env.NODE_ENV}`);
    if (await fileExists(environmentFile)) {
      return environmentFile;
    }
  }

  const candidates = [".env.development", ".env.production"]
    .map((name) => path.join(cwd, name));
  const existing = [];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      existing.push(candidate);
    }
  }

  if (existing.length === 1) {
    return existing[0];
  }
  if (existing.length > 1) {
    throw new Error(
      "Multiple environment files found. Set NODE_ENV, BACKUP_ENV_FILE, or pass --env-file explicitly."
    );
  }
  throw new Error("No backup environment file found.");
}

export async function loadBackupEnvironment(explicitPath, cwd = process.cwd()) {
  const envFile = await resolveEnvFile(explicitPath, cwd);
  const parsed = parseEnvText(await fs.readFile(envFile, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] == null) {
      process.env[key] = value;
    }
  }
  return envFile;
}

export function requireEnvironment(keys) {
  const missing = keys.filter((key) => !String(process.env[key] || "").trim());
  if (missing.length > 0) {
    throw new Error(`Missing backup environment variables: ${missing.join(", ")}`);
  }
}

export function sanitizeKeyPart(value, fallback = "unknown") {
  const sanitized = String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 100);
  return sanitized || fallback;
}

export function normalizeS3Prefix(value = "backups/postgres") {
  return String(value || "backups/postgres")
    .split("/")
    .map((part) => sanitizeKeyPart(part, ""))
    .filter(Boolean)
    .join("/");
}

export function buildBackupLocation({
  prefix,
  environment,
  databaseName,
  timestamp,
  backupId
}) {
  const iso = new Date(timestamp).toISOString();
  const dayPath = iso.slice(0, 10).replaceAll("-", "/");
  const timestampPart = iso.replaceAll(":", "-").replace(/\.\d{3}Z$/u, "Z");
  const root = [
    normalizeS3Prefix(prefix),
    sanitizeKeyPart(environment),
    sanitizeKeyPart(databaseName),
    dayPath,
    `${timestampPart}-${sanitizeKeyPart(backupId)}`
  ].filter(Boolean).join("/");

  return {
    root,
    dumpKey: `${root}/database.dump`,
    manifestKey: `${root}/manifest.json`
  };
}

export function buildPgDumpArgs({ outputFile }) {
  return [
    "--host", process.env.DB_HOST,
    "--port", process.env.DB_PORT,
    "--username", process.env.DB_USER,
    "--dbname", process.env.DB_NAME,
    "--format=custom",
    "--compress=1",
    "--no-owner",
    "--no-privileges",
    "--file", outputFile
  ];
}

export function getPostgresTools() {
  const pgDump = process.env.BACKUP_PG_DUMP_PATH || "pg_dump";
  const toolDirectory = path.dirname(pgDump);
  const hasExplicitDirectory = toolDirectory !== ".";
  return {
    pgDump,
    pgRestore: process.env.BACKUP_PG_RESTORE_PATH
      || (hasExplicitDirectory ? path.join(toolDirectory, "pg_restore") : "pg_restore"),
    psql: process.env.BACKUP_PSQL_PATH
      || (hasExplicitDirectory ? path.join(toolDirectory, "psql") : "psql")
  };
}

export async function runCommand(command, args, {
  env = process.env,
  cwd = process.cwd(),
  inheritStdout = false
} = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", inheritStdout ? "inherit" : "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];
    child.stdout?.on("data", (chunk) => stdout.push(chunk));
    child.stderr?.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      const stdoutText = Buffer.concat(stdout).toString("utf8").trim();
      const stderrText = Buffer.concat(stderr).toString("utf8").trim();
      if (code === 0) {
        resolve({ stdout: stdoutText, stderr: stderrText });
        return;
      }
      reject(new Error(
        `${command} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}`
        + (stderrText ? `: ${stderrText}` : "")
      ));
    });
  });
}

export async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export async function acquireBackupLock(identity, {
  directory = "/tmp",
  staleAfterMs = 12 * 60 * 60 * 1000
} = {}) {
  const lockHash = createHash("sha256").update(String(identity)).digest("hex").slice(0, 20);
  const lockDirectory = path.join(directory, `cwa24-postgres-backup-${lockHash}.lock`);

  const acquire = async (allowStaleCleanup) => {
    try {
      await fs.mkdir(lockDirectory, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      const stat = await fs.stat(lockDirectory);
      if (allowStaleCleanup && Date.now() - stat.mtimeMs > staleAfterMs) {
        await fs.rm(lockDirectory, { recursive: true, force: true });
        return acquire(false);
      }
      throw new Error(`Another PostgreSQL backup is active (${lockDirectory}).`, { cause: error });
    }

    await fs.writeFile(
      path.join(lockDirectory, "owner.json"),
      `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
      { mode: 0o600 }
    );
    return async () => {
      await fs.rm(lockDirectory, { recursive: true, force: true });
    };
  };

  return acquire(true);
}

export function buildAwsS3CpArgs(source, destination, {
  contentType,
  sha256
} = {}) {
  const args = ["s3", "cp", source, destination, "--only-show-errors"];
  if (contentType) {
    args.push("--content-type", contentType);
  }
  if (sha256) {
    args.push("--metadata", `sha256=${sha256}`);
  }

  const isUpload = !String(source).startsWith("s3://");
  const encryption = String(process.env.BACKUP_S3_SSE || "").trim();
  if (isUpload && encryption) {
    args.push("--sse", encryption);
  }
  if (isUpload && process.env.BACKUP_S3_KMS_KEY_ID) {
    args.push("--sse-kms-key-id", process.env.BACKUP_S3_KMS_KEY_ID);
  }
  return args;
}

export function s3Uri(bucket, key) {
  return `s3://${bucket}/${key}`;
}

export async function readOptionalGitCommit(cwd = process.cwd()) {
  if (process.env.APP_GIT_COMMIT) {
    return process.env.APP_GIT_COMMIT;
  }
  try {
    const result = await runCommand("git", ["rev-parse", "HEAD"], { cwd });
    return result.stdout || null;
  } catch {
    return null;
  }
}
