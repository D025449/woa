import { createHash } from "node:crypto";

import { strToU8, zipSync } from "fflate";
import unzipper from "unzipper";

import SegmentMatcher from "./SegmentMatcher.js";

const ARCHIVE_FORMAT = "WOA_SEGMENTS";
const SEGMENT_FORMAT = "WOA_SEGMENT";
const ARCHIVE_VERSION = 1;
const MAX_SEGMENTS = 5000;
const MAX_POINTS_PER_SEGMENT = 20000;
const MAX_ENTRY_BYTES = 2 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;

export class SegmentArchiveValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "SegmentArchiveValidationError";
    this.statusCode = 400;
  }
}

function finiteNumber(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizePoint(point, label) {
  const lat = finiteNumber(point?.lat);
  const lng = finiteNumber(point?.lng);
  if (lat === null || lng === null || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw new SegmentArchiveValidationError(`${label} contains invalid coordinates`);
  }

  const ele = finiteNumber(point?.ele);
  return ele === null ? { lat, lng } : { lat, lng, ele };
}

function haversineMeters(a, b) {
  return SegmentMatcher.distance(a, b);
}

function computeDistance(track) {
  let total = 0;
  for (let index = 1; index < track.length; index += 1) {
    total += haversineMeters(track[index - 1], track[index]);
  }
  return total;
}

function computeAscent(track) {
  let total = 0;
  for (let index = 1; index < track.length; index += 1) {
    const previous = finiteNumber(track[index - 1]?.ele);
    const current = finiteNumber(track[index]?.ele);
    if (previous !== null && current !== null && current > previous) {
      total += current - previous;
    }
  }
  return total;
}

function normalizeEndpoint(raw, point, fallbackName) {
  return {
    lat: point.lat,
    lng: point.lng,
    name: typeof raw?.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 500) : fallbackName,
    altitude: finiteNumber(raw?.altitude, finiteNumber(point.ele))
  };
}

export function normalizeArchivedSegment(raw, entryName = "segment") {
  if (raw?.format !== SEGMENT_FORMAT || Number(raw?.version) !== ARCHIVE_VERSION) {
    throw new SegmentArchiveValidationError(`${entryName} has an unsupported segment format`);
  }
  if (!Array.isArray(raw.track) || raw.track.length < 2 || raw.track.length > MAX_POINTS_PER_SEGMENT) {
    throw new SegmentArchiveValidationError(`${entryName} must contain 2 to ${MAX_POINTS_PER_SEGMENT} track points`);
  }

  const track = raw.track.map((point, index) => normalizePoint(point, `${entryName} point ${index + 1}`));
  const distance = computeDistance(track);
  return {
    sourceId: raw.sourceId ?? null,
    distance,
    duration: Math.max(0, finiteNumber(raw.duration, 0)),
    ascent: computeAscent(track),
    start: normalizeEndpoint(raw.start, track[0], "Imported start"),
    end: normalizeEndpoint(raw.end, track[track.length - 1], "Imported end"),
    track,
    bestEffortsStatus: "queued"
  };
}

function serializeSegment(segment) {
  return {
    format: SEGMENT_FORMAT,
    version: ARCHIVE_VERSION,
    sourceId: segment.id ?? segment.sourceId ?? null,
    distance: finiteNumber(segment.distance, 0),
    duration: finiteNumber(segment.duration, 0),
    ascent: finiteNumber(segment.ascent, 0),
    start: segment.start,
    end: segment.end,
    track: segment.track
  };
}

export function buildSegmentArchive(segments, exportedAt = new Date()) {
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
    const sourceId = String(segment.id ?? index + 1).replace(/[^a-zA-Z0-9_-]/g, "_");
    entries[`segments/segment-${sourceId}.json`] = strToU8(JSON.stringify(serializeSegment(segment)));
  });

  return Buffer.from(zipSync(entries, { level: 6 }));
}

function entryUncompressedSize(entry) {
  return Number(entry?.uncompressedSize ?? entry?.vars?.uncompressedSize ?? 0);
}

export async function decodeSegmentArchive(buffer) {
  let directory;
  try {
    directory = await unzipper.Open.buffer(buffer);
  } catch {
    throw new SegmentArchiveValidationError("The uploaded file is not a readable ZIP archive");
  }

  const files = directory.files.filter((entry) => entry.type === "File");
  const manifestEntry = files.find((entry) => entry.path === "manifest.json");
  const segmentEntries = files.filter((entry) => /^segments\/[^/]+\.json$/i.test(entry.path));
  if (!manifestEntry || segmentEntries.length > MAX_SEGMENTS) {
    throw new SegmentArchiveValidationError(`Archive manifest is missing or contains more than ${MAX_SEGMENTS} segments`);
  }

  const totalUncompressedBytes = files.reduce((sum, entry) => sum + entryUncompressedSize(entry), 0);
  if (totalUncompressedBytes > MAX_UNCOMPRESSED_BYTES || files.some((entry) => entryUncompressedSize(entry) > MAX_ENTRY_BYTES)) {
    throw new SegmentArchiveValidationError("Segment archive exceeds the allowed uncompressed size");
  }

  let manifest;
  try {
    manifest = JSON.parse((await manifestEntry.buffer()).toString("utf8"));
  } catch {
    throw new SegmentArchiveValidationError("Archive manifest is invalid JSON");
  }
  if (manifest?.format !== ARCHIVE_FORMAT || Number(manifest?.version) !== ARCHIVE_VERSION) {
    throw new SegmentArchiveValidationError("Unsupported segment archive format");
  }
  if (Number(manifest.segmentCount) !== segmentEntries.length) {
    throw new SegmentArchiveValidationError("Archive segment count does not match its manifest");
  }

  const segments = [];
  for (const entry of segmentEntries.sort((a, b) => a.path.localeCompare(b.path))) {
    let raw;
    try {
      raw = JSON.parse((await entry.buffer()).toString("utf8"));
    } catch {
      throw new SegmentArchiveValidationError(`${entry.path} is invalid JSON`);
    }
    segments.push(normalizeArchivedSegment(raw, entry.path));
  }
  return segments;
}

export function segmentTrackFingerprint(track) {
  const hash = createHash("sha256");
  for (const point of track) {
    hash.update(`${Math.round(Number(point.lat) * 1e5)},${Math.round(Number(point.lng) * 1e5)};`);
  }
  return hash.digest("hex");
}

function sampleTrack(track, sampleCount = 24) {
  if (track.length <= sampleCount) return track;
  return Array.from({ length: sampleCount }, (_, index) => track[Math.round(index * (track.length - 1) / (sampleCount - 1))]);
}

function trackCoverage(source, target, maxDistanceMeters = 25) {
  const samples = sampleTrack(source);
  const matching = samples.filter((point) => SegmentMatcher.pointToPolylineDistance(point, target) <= maxDistanceMeters);
  return matching.length / samples.length;
}

export function areSegmentTracksSimilar(left, right) {
  if (!left?.track?.length || !right?.track?.length) return false;
  if (haversineMeters(left.track[0], right.track[0]) > 50) return false;
  if (haversineMeters(left.track[left.track.length - 1], right.track[right.track.length - 1]) > 50) return false;

  const leftDistance = finiteNumber(left.distance, computeDistance(left.track));
  const rightDistance = finiteNumber(right.distance, computeDistance(right.track));
  if (Math.abs(leftDistance - rightDistance) > Math.max(50, Math.max(leftDistance, rightDistance) * 0.05)) return false;

  return trackCoverage(left.track, right.track) >= 0.9 && trackCoverage(right.track, left.track) >= 0.9;
}

export function filterNovelSegments(importedSegments, existingSegments) {
  const accepted = [];
  const known = [...(Array.isArray(existingSegments) ? existingSegments : [])];
  const fingerprints = new Set(known.map((segment) => segmentTrackFingerprint(segment.track)));

  for (const segment of importedSegments) {
    const fingerprint = segmentTrackFingerprint(segment.track);
    const duplicate = fingerprints.has(fingerprint) || known.some((candidate) => areSegmentTracksSimilar(segment, candidate));
    if (duplicate) continue;
    accepted.push(segment);
    known.push(segment);
    fingerprints.add(fingerprint);
  }

  return {
    accepted,
    skippedDuplicates: importedSegments.length - accepted.length
  };
}

export const SEGMENT_ARCHIVE_MAX_BYTES = 25 * 1024 * 1024;
