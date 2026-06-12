import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function resolveAppTempRoot() {
  const configured = String(process.env.WOA_TEMP_DIR || "").trim();

  if (configured) {
    return path.resolve(configured);
  }

  return path.resolve(process.cwd(), "tmp");
}

export function getImportUploadDir() {
  return path.join(resolveAppTempRoot(), "woa-imports");
}

export function getSegmentPersistTempDir() {
  return path.join(resolveAppTempRoot(), "woa-postprocess", "segment-persist");
}

export function getThumbnailTempDir() {
  return path.join(resolveAppTempRoot(), "woa-postprocess", "thumbnails");
}

export function ensureDirSync(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
  return targetPath;
}

export async function getFilesystemCapacitySnapshot(targetPath) {
  try {
    const stats = await fs.promises.statfs(targetPath);
    const blockSize = Number(stats.bsize || 0);
    const freeBytes = Number(stats.bavail || 0) * blockSize;
    const totalBytes = Number(stats.blocks || 0) * blockSize;

    return {
      path: targetPath,
      freeBytes,
      totalBytes
    };
  } catch {
    return {
      path: targetPath,
      freeBytes: null,
      totalBytes: null
    };
  }
}

