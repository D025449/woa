import { strToU8, zipSync } from "fflate";
import unzipper from "unzipper";

import {
  buildSegmentGpx,
  parseSegmentGpx,
  SegmentGpxValidationError
} from "./segmentGpxService.js";

const ARCHIVE_FORMAT = "WOA_SEGMENTS_GPX";
const ARCHIVE_VERSION = 1;
const MAX_SEGMENTS = 5000;
const MAX_ENTRY_BYTES = 4 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;

export class SegmentGpxArchiveValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "SegmentGpxArchiveValidationError";
    this.statusCode = 400;
  }
}

function slugify(value, fallback) {
  const slug = String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || fallback;
}

function segmentEntryName(segment, index) {
  const id = String(segment.id ?? segment.sourceId ?? index + 1)
    .replace(/[^a-zA-Z0-9_-]/g, "_");
  const start = slugify(segment.start?.name, "start");
  const end = slugify(segment.end?.name, "end");
  return `segments/S-${id}__${start}__${end}.gpx`;
}

function entryUncompressedSize(entry) {
  return Number(entry?.uncompressedSize ?? entry?.vars?.uncompressedSize ?? 0);
}

async function openArchive(buffer) {
  try {
    return await unzipper.Open.buffer(buffer);
  } catch {
    throw new SegmentGpxArchiveValidationError("The uploaded file is not a readable ZIP archive");
  }
}

export function buildSegmentGpxArchive(segments, exportedAt = new Date()) {
  const normalizedSegments = Array.isArray(segments) ? segments : [];
  const entries = {
    "manifest.json": strToU8(JSON.stringify({
      format: ARCHIVE_FORMAT,
      version: ARCHIVE_VERSION,
      exportedAt: exportedAt.toISOString(),
      segmentCount: normalizedSegments.length
    }))
  };

  normalizedSegments.forEach((segment, index) => {
    entries[segmentEntryName(segment, index)] = strToU8(
      buildSegmentGpx([segment], exportedAt)
    );
  });

  return Buffer.from(zipSync(entries, { level: 6 }));
}

export async function detectSegmentArchiveKind(buffer) {
  const directory = await openArchive(buffer);
  const files = directory.files.filter((entry) => entry.type === "File");
  const manifestEntry = files.find((entry) => entry.path === "manifest.json");

  if (manifestEntry) {
    try {
      const manifest = JSON.parse((await manifestEntry.buffer()).toString("utf8"));
      if (manifest?.format === ARCHIVE_FORMAT) return "gpx";
      if (manifest?.format === "WOA_SEGMENTS") return "internal";
    } catch {
      // The regular decoder returns the more specific manifest error.
    }
  }

  return files.some((entry) => /\.gpx$/i.test(entry.path)) ? "gpx" : "internal";
}

export async function decodeSegmentGpxArchive(buffer) {
  const directory = await openArchive(buffer);
  const files = directory.files.filter((entry) => entry.type === "File");
  const gpxEntries = files.filter((entry) => /\.gpx$/i.test(entry.path));

  if (gpxEntries.length === 0 || gpxEntries.length > MAX_SEGMENTS) {
    throw new SegmentGpxArchiveValidationError(
      `GPX archive must contain 1 to ${MAX_SEGMENTS} GPX entries`
    );
  }

  const totalUncompressedBytes = files.reduce(
    (sum, entry) => sum + entryUncompressedSize(entry),
    0
  );
  if (
    totalUncompressedBytes > MAX_UNCOMPRESSED_BYTES ||
    gpxEntries.some((entry) => entryUncompressedSize(entry) > MAX_ENTRY_BYTES)
  ) {
    throw new SegmentGpxArchiveValidationError("GPX archive exceeds the allowed uncompressed size");
  }

  const segments = [];
  for (const entry of gpxEntries.sort((left, right) => left.path.localeCompare(right.path))) {
    try {
      const parsed = parseSegmentGpx(await entry.buffer());
      parsed.forEach((segment) => {
        segments.push({
          ...segment,
          entryName: entry.path
        });
      });
    } catch (error) {
      if (error instanceof SegmentGpxValidationError) {
        throw new SegmentGpxArchiveValidationError(`${entry.path}: ${error.message}`);
      }
      throw error;
    }
  }

  if (segments.length > MAX_SEGMENTS) {
    throw new SegmentGpxArchiveValidationError(
      `GPX archive contains more than ${MAX_SEGMENTS} segments`
    );
  }
  return segments;
}

export const SEGMENT_GPX_ARCHIVE_MAX_BYTES = 25 * 1024 * 1024;
