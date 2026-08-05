import { strToU8, zipSync } from "fflate";
import unzipper from "unzipper";

import pool from "./database.js";
import SegmentDBService from "./segmentDBService.js";
import {
  filterNovelSegments,
  normalizeArchivedSegment
} from "./segmentArchiveService.js";

export const ADMIN_SEGMENT_BACKUP_FORMAT = "cwa24-admin-segments";
export const ADMIN_SEGMENT_BACKUP_VERSION = 1;
export const ADMIN_SEGMENT_BACKUP_MAX_BYTES = 100 * 1024 * 1024;

const MAX_SEGMENTS = 50000;
const MAX_ENTRY_BYTES = 2 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 500 * 1024 * 1024;

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function requiredString(value, field) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`Invalid ${field}.`);
  return normalized;
}

function serializeSegment(segment, ownerKey) {
  return {
    format: "WOA_SEGMENT",
    version: 1,
    ownerKey,
    sourceId: segment.id ?? null,
    distance: Number(segment.distance) || 0,
    duration: Number(segment.duration) || 0,
    ascent: Number(segment.ascent) || 0,
    start: segment.start,
    end: segment.end,
    track: segment.track
  };
}

export function buildAdminSegmentBackup(segments, createdAt = new Date()) {
  const rows = Array.isArray(segments) ? segments : [];
  if (rows.length > MAX_SEGMENTS) {
    throw new Error(`Admin segment backup exceeds ${MAX_SEGMENTS} segments.`);
  }

  const ownersByIdentity = new Map();
  for (const segment of rows) {
    const authSub = requiredString(segment.ownerAuthSub, "segment owner authSub");
    const email = normalizeEmail(segment.ownerEmail);
    const identity = `${authSub}\u0000${email}`;
    if (!ownersByIdentity.has(identity)) {
      ownersByIdentity.set(identity, {
        key: `owner-${ownersByIdentity.size + 1}`,
        authSub,
        email,
        sourceUid: String(segment.uid),
        segmentCount: 0
      });
    }
    ownersByIdentity.get(identity).segmentCount += 1;
  }

  const owners = [...ownersByIdentity.values()];
  const ownerByIdentity = new Map(
    owners.map((owner) => [`${owner.authSub}\u0000${owner.email}`, owner])
  );
  const entries = {
    "manifest.json": strToU8(JSON.stringify({
      format: ADMIN_SEGMENT_BACKUP_FORMAT,
      version: ADMIN_SEGMENT_BACKUP_VERSION,
      createdAt: new Date(createdAt).toISOString(),
      segmentCount: rows.length,
      owners
    }))
  };

  rows.forEach((segment, index) => {
    const identity = `${String(segment.ownerAuthSub).trim()}\u0000${normalizeEmail(segment.ownerEmail)}`;
    const owner = ownerByIdentity.get(identity);
    const sourceId = String(segment.id ?? index + 1).replace(/[^a-zA-Z0-9_-]/gu, "_");
    entries[`segments/${owner.key}-segment-${sourceId}.json`] = strToU8(
      JSON.stringify(serializeSegment(segment, owner.key))
    );
  });

  return Buffer.from(zipSync(entries, { level: 6 }));
}

function entrySize(entry) {
  return Number(entry?.uncompressedSize ?? entry?.vars?.uncompressedSize ?? 0);
}

export async function decodeAdminSegmentBackup(buffer) {
  let directory;
  try {
    directory = await unzipper.Open.buffer(buffer);
  } catch {
    throw new Error("The uploaded file is not a readable ZIP archive.");
  }

  const files = directory.files.filter((entry) => entry.type === "File");
  const manifestEntry = files.find((entry) => entry.path === "manifest.json");
  const segmentEntries = files.filter((entry) => /^segments\/[^/]+\.json$/iu.test(entry.path));
  if (!manifestEntry || segmentEntries.length > MAX_SEGMENTS) {
    throw new Error("Admin segment backup manifest is missing or contains too many segments.");
  }
  const totalBytes = files.reduce((sum, entry) => sum + entrySize(entry), 0);
  if (totalBytes > MAX_UNCOMPRESSED_BYTES || files.some((entry) => entrySize(entry) > MAX_ENTRY_BYTES)) {
    throw new Error("Admin segment backup exceeds the allowed uncompressed size.");
  }

  let manifest;
  try {
    manifest = JSON.parse((await manifestEntry.buffer()).toString("utf8"));
  } catch {
    throw new Error("Admin segment backup manifest is invalid JSON.");
  }
  if (
    manifest?.format !== ADMIN_SEGMENT_BACKUP_FORMAT ||
    Number(manifest?.version) !== ADMIN_SEGMENT_BACKUP_VERSION
  ) {
    throw new Error("Unsupported admin segment backup format.");
  }
  if (Number(manifest.segmentCount) !== segmentEntries.length) {
    throw new Error("Admin segment backup count does not match its manifest.");
  }

  const owners = Array.isArray(manifest.owners) ? manifest.owners : [];
  const ownerByKey = new Map();
  for (const owner of owners) {
    const key = requiredString(owner?.key, "owner key");
    if (ownerByKey.has(key)) throw new Error(`Duplicate owner key: ${key}`);
    ownerByKey.set(key, {
      key,
      authSub: requiredString(owner?.authSub, `owner ${key} authSub`),
      email: normalizeEmail(owner?.email),
      sourceUid: owner?.sourceUid == null ? null : String(owner.sourceUid),
      declaredSegmentCount: Number(owner?.segmentCount) || 0
    });
  }

  const segments = [];
  const actualCounts = new Map();
  for (const entry of segmentEntries.sort((left, right) => left.path.localeCompare(right.path))) {
    let raw;
    try {
      raw = JSON.parse((await entry.buffer()).toString("utf8"));
    } catch {
      throw new Error(`${entry.path} is invalid JSON.`);
    }
    const owner = ownerByKey.get(String(raw?.ownerKey || ""));
    if (!owner) throw new Error(`${entry.path} references an unknown owner.`);
    segments.push({ ownerKey: owner.key, segment: normalizeArchivedSegment(raw, entry.path) });
    actualCounts.set(owner.key, (actualCounts.get(owner.key) || 0) + 1);
  }
  for (const owner of ownerByKey.values()) {
    if ((actualCounts.get(owner.key) || 0) !== owner.declaredSegmentCount) {
      throw new Error(`Segment count does not match owner ${owner.key}.`);
    }
  }

  return { createdAt: manifest.createdAt || null, owners: [...ownerByKey.values()], segments };
}

export function resolveAdminSegmentOwners(owners, users) {
  const usersByAuthSub = new Map(users.map((user) => [String(user.auth_sub), user]));
  const usersByEmail = new Map();
  for (const user of users) {
    const email = normalizeEmail(user.email);
    const matches = usersByEmail.get(email) || [];
    matches.push(user);
    usersByEmail.set(email, matches);
  }

  return owners.map((owner) => {
    const authMatch = usersByAuthSub.get(owner.authSub) || null;
    const emailMatches = owner.email ? (usersByEmail.get(owner.email) || []) : [];
    const emailMatch = emailMatches.length === 1 ? emailMatches[0] : null;
    let status = "unmatched";
    let matchMethod = null;
    let target = null;

    if (authMatch && emailMatch && String(authMatch.id) !== String(emailMatch.id)) {
      status = "conflict";
    } else if (authMatch) {
      status = "matched";
      matchMethod = "auth_sub";
      target = authMatch;
    } else if (emailMatches.length > 1) {
      status = "conflict";
    } else if (emailMatch) {
      status = "matched";
      matchMethod = "email";
      target = emailMatch;
    }

    return {
      ownerKey: owner.key,
      sourceAuthSub: owner.authSub,
      sourceEmail: owner.email,
      sourceUid: owner.sourceUid,
      segmentCount: owner.declaredSegmentCount,
      status,
      matchMethod,
      targetUid: target?.id == null ? null : String(target.id),
      targetEmail: target?.email || null
    };
  });
}

async function prepareBackup(buffer, queryable) {
  let decoded;
  try {
    decoded = await decodeAdminSegmentBackup(buffer);
  } catch (error) {
    throw Object.assign(
      error instanceof Error ? error : new Error("Invalid admin segment backup."),
      { statusCode: 400 }
    );
  }
  const usersResult = await queryable.query("SELECT id, auth_sub, email FROM users ORDER BY id");
  const mappings = resolveAdminSegmentOwners(decoded.owners, usersResult.rows);
  const segmentsByOwner = new Map();
  for (const entry of decoded.segments) {
    const entries = segmentsByOwner.get(entry.ownerKey) || [];
    entries.push(entry.segment);
    segmentsByOwner.set(entry.ownerKey, entries);
  }

  for (const mapping of mappings) {
    mapping.importCount = 0;
    mapping.duplicateCount = 0;
    if (mapping.status !== "matched") continue;
    const existing = await SegmentDBService.getOwnedSegmentsForArchive(mapping.targetUid, queryable);
    const novel = filterNovelSegments(segmentsByOwner.get(mapping.ownerKey) || [], existing);
    mapping.importCount = novel.accepted.length;
    mapping.duplicateCount = novel.skippedDuplicates;
    mapping.acceptedSegments = novel.accepted;
  }

  const totals = mappings.reduce((result, mapping) => {
    result.segments += mapping.segmentCount;
    result.importable += mapping.importCount;
    result.duplicates += mapping.duplicateCount;
    if (mapping.status === "unmatched") result.unmatched += mapping.segmentCount;
    if (mapping.status === "conflict") result.conflicts += mapping.segmentCount;
    return result;
  }, { segments: 0, importable: 0, duplicates: 0, unmatched: 0, conflicts: 0 });

  return { decoded, mappings, segmentsByOwner, totals };
}

function publicPreview(prepared) {
  return {
    createdAt: prepared.decoded.createdAt,
    totals: prepared.totals,
    owners: prepared.mappings.map(({ acceptedSegments: _acceptedSegments, ...mapping }) => mapping)
  };
}

export default class AdminSegmentBackupService {
  static async exportAll() {
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const segments = await SegmentDBService.getAllSegmentsForAdminArchive(client);
      const archive = buildAdminSegmentBackup(segments);
      await client.query("COMMIT");
      return { archive, segmentCount: segments.length };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  static async preview(buffer) {
    return publicPreview(await prepareBackup(buffer, pool));
  }

  static async importAll(buffer) {
    const client = await pool.connect();
    const queueTargets = [];
    try {
      await client.query("BEGIN");
      const prepared = await prepareBackup(buffer, client);
      if (prepared.totals.conflicts > 0) {
        const error = Object.assign(
          new Error("Owner mapping contains conflicts. Import was not started."),
          { statusCode: 409 }
        );
        throw error;
      }

      let imported = 0;
      for (const mapping of prepared.mappings) {
        if (mapping.status !== "matched" || mapping.acceptedSegments.length === 0) continue;
        const rows = await SegmentDBService.insertGpsSegmentsBulk(
          mapping.targetUid,
          mapping.acceptedSegments,
          client
        );
        imported += rows.length;
        queueTargets.push({
          uid: mapping.targetUid,
          segmentIds: rows.map((row) => Number(row.id)).filter(Number.isInteger)
        });
      }
      await client.query("COMMIT");
      return { ...publicPreview(prepared), imported, queueTargets };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}

export function buildAdminSegmentBackupFilename(createdAt = new Date()) {
  const timestamp = new Date(createdAt).toISOString()
    .replace(/[-:]/gu, "")
    .replace(/\.\d{3}Z$/u, "Z");
  return `cwa24-admin-segments-${timestamp}.zip`;
}
