import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client
} from "@aws-sdk/client-s3";

import { normalizeS3Prefix, sanitizeKeyPart } from "../../ops/postgres-backup/backup-common.mjs";
import { readRuntimeDatabasePointer } from "../../ops/postgres-backup/runtime-database.mjs";

function backupConfiguration() {
  const bucket = String(process.env.BACKUP_S3_BUCKET || process.env.S3_BUCKET || "").trim();
  const environment = String(process.env.BACKUP_ENVIRONMENT || process.env.NODE_ENV || "unknown").trim();
  const database = String(process.env.BACKUP_DATABASE_ID || process.env.DB_NAME || "").trim();
  const activeDatabase = String(process.env.DB_NAME || "").trim();
  const pointer = readRuntimeDatabasePointer();
  if (!bucket || !database) {
    throw new Error("Backup catalog requires an S3 bucket and DB_NAME.");
  }
  const prefix = [
    normalizeS3Prefix(process.env.BACKUP_S3_PREFIX),
    sanitizeKeyPart(environment),
    sanitizeKeyPart(database)
  ].join("/");
  return {
    bucket,
    environment,
    database,
    activeDatabase,
    previousDatabase: pointer.values.PREVIOUS_DB_NAME || null,
    activationSupported: environment === "production" && Boolean(process.env.BACKUP_ACTIVE_DATABASE_FILE),
    prefix
  };
}

export function normalizeBackupRoot(value) {
  return String(value || "")
    .replace(/^s3:\/\/[^/]+\//u, "")
    .replace(/\/manifest\.json$/u, "")
    .replace(/^\/+|\/+$/gu, "");
}

export function assertBackupRootInPrefix(root, prefix) {
  const normalizedRoot = normalizeBackupRoot(root);
  const normalizedPrefix = String(prefix || "").replace(/^\/+|\/+$/gu, "");
  if (!normalizedRoot.startsWith(`${normalizedPrefix}/`)) {
    throw Object.assign(new Error("Selected backup is outside the active environment."), { statusCode: 400 });
  }
  if (!/\/\d{4}\/\d{2}\/\d{2}\/[^/]+$/u.test(normalizedRoot)) {
    throw Object.assign(new Error("Selected backup key has an invalid structure."), { statusCode: 400 });
  }
  return normalizedRoot;
}

async function bodyToString(body) {
  if (!body) throw new Error("S3 manifest has no response body.");
  if (typeof body.transformToString === "function") return body.transformToString("utf-8");
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function publicManifest(manifest, rootKey) {
  if (manifest?.format !== "cwa24-postgres-backup-manifest" || manifest?.status !== "complete") {
    return null;
  }
  return {
    backupId: manifest.backupId,
    rootKey,
    createdAt: manifest.createdAt,
    label: manifest.label || null,
    environment: manifest.environment,
    database: manifest.database?.logicalName || manifest.database?.name || null,
    physicalDatabase: manifest.database?.physicalName || manifest.database?.name || null,
    sourceSizeBytes: Number(manifest.database?.sourceSizeBytes) || 0,
    archiveSizeBytes: Number(manifest.archive?.sizeBytes) || 0,
    sha256: manifest.archive?.sha256 || null,
    gitCommit: manifest.tool?.gitCommit || null,
    appVersion: manifest.tool?.appVersion || null,
    serverVersion: manifest.database?.serverVersion || null,
    timingsMs: manifest.timingsMs || null
  };
}

export default class PostgresBackupCatalogService {
  static configuration() {
    return backupConfiguration();
  }

  static async list({ limit = 50 } = {}) {
    const config = backupConfiguration();
    const s3 = new S3Client({ region: process.env.AWS_REGION });
    const manifestKeys = [];
    let continuationToken;

    do {
      const response = await s3.send(new ListObjectsV2Command({
        Bucket: config.bucket,
        Prefix: `${config.prefix}/`,
        ContinuationToken: continuationToken
      }));
      for (const object of response.Contents || []) {
        if (object.Key?.endsWith("/manifest.json")) {
          manifestKeys.push({ key: object.Key, lastModified: object.LastModified || null });
        }
      }
      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);

    manifestKeys.sort((left, right) => (
      new Date(right.lastModified || 0).getTime() - new Date(left.lastModified || 0).getTime()
    ));
    const selected = manifestKeys.slice(0, Math.max(1, Math.min(100, Number(limit) || 50)));
    const manifests = [];
    for (let index = 0; index < selected.length; index += 8) {
      const batch = selected.slice(index, index + 8);
      const values = await Promise.all(batch.map(async ({ key }) => {
        try {
          const response = await s3.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
          const manifest = JSON.parse(await bodyToString(response.Body));
          return publicManifest(manifest, key.replace(/\/manifest\.json$/u, ""));
        } catch (error) {
          console.warn("Skipping unreadable PostgreSQL backup manifest", { key, error: error.message });
          return null;
        }
      }));
      manifests.push(...values.filter(Boolean));
    }
    return { ...config, backups: manifests };
  }

  static validateRoot(root) {
    const config = backupConfiguration();
    return assertBackupRootInPrefix(root, config.prefix);
  }
}
