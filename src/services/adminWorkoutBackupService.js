import { strToU8, zipSync } from "fflate";
import unzipper from "unzipper";
import { createHash } from "node:crypto";

import pool from "./database.js";
import { resolveAdminSegmentOwners } from "./adminSegmentBackupService.js";

export const ADMIN_WORKOUT_BACKUP_FORMAT = "cwa24-admin-workouts";
export const ADMIN_WORKOUT_BACKUP_VERSION = 1;
export const ADMIN_WORKOUT_BACKUP_MAX_BYTES = 256 * 1024 * 1024;

const MAX_WORKOUTS = 100000;
const MAX_ENTRY_BYTES = 128 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024;
const INSERT_BATCH_SIZE = 100;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export const ADMIN_WORKOUT_COLUMNS = [
  "uploaded_at", "start_time", "end_time", "year", "month", "week", "year_quarter",
  "year_month", "year_week", "total_elapsed_time", "total_timer_time", "total_distance",
  "total_cycles", "total_work", "total_calories", "total_ascent", "total_descent",
  "avg_speed", "max_speed", "avg_normalized_power", "avg_power", "max_power",
  "avg_heart_rate", "max_heart_rate", "avg_cadence", "max_cadence", "stream_codec",
  "validgps", "gps_source", "workout_type", "fit_device_metadata",
  "manual_gps_lookup_points", "segment_processing_status", "segment_processing_error",
  "segment_processing_updated_at", "points_count", "samplerategps", "gps_track_blob_codec",
  "gps_bounds", "track_start_lat", "track_start_lng", "track_end_lat", "track_end_lng"
];

export const ADMIN_WORKOUT_SEGMENT_COLUMNS = [
  "segmenttype", "segmentname", "start_offset", "end_offset", "duration", "avg_power",
  "avg_heart_rate", "avg_cadence", "avg_speed", "altimeters", "position", "created_at"
];

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function requiredString(value, field) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`Invalid ${field}.`);
  return normalized;
}

function optionalStartTime(value, field) {
  if (value == null || value === "") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid ${field}.`);
  return date.toISOString();
}

function streamSha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function jsonValue(value) {
  if (value == null) return null;
  return typeof value === "string" ? JSON.parse(value) : value;
}

function serializeValue(value) {
  if (value instanceof Date) return value.toISOString();
  return value;
}

export function serializeAdminWorkout(row, ownerKey, segments, favoriteOwnerKeys) {
  const metadata = { ownerKey, sourceId: String(row.id) };
  for (const column of ADMIN_WORKOUT_COLUMNS) {
    metadata[column] = serializeValue(row[column]);
  }
  metadata.segments = segments.map((segment) => Object.fromEntries(
    ADMIN_WORKOUT_SEGMENT_COLUMNS.map((column) => [column, serializeValue(segment[column])])
  ));
  metadata.favoriteOwnerKeys = favoriteOwnerKeys;
  return metadata;
}

export function buildAdminWorkoutBackup({ workouts = [], segments = [], favorites = [] }, createdAt = new Date()) {
  if (workouts.length > MAX_WORKOUTS) {
    throw new Error(`Admin workout backup exceeds ${MAX_WORKOUTS} workouts.`);
  }
  const ownerByUid = new Map();
  const ensureOwner = ({ uid, authSub, email }) => {
    const key = String(uid);
    if (!ownerByUid.has(key)) {
      ownerByUid.set(key, {
        key: `owner-${ownerByUid.size + 1}`,
        authSub: requiredString(authSub, "workout owner authSub"),
        email: normalizeEmail(email),
        sourceUid: key,
        workoutCount: 0
      });
    }
    return ownerByUid.get(key);
  };
  for (const workout of workouts) {
    ensureOwner({
      uid: workout.uid,
      authSub: workout.owner_auth_sub,
      email: workout.owner_email
    }).workoutCount += 1;
  }
  for (const favorite of favorites) {
    ensureOwner({
      uid: favorite.uid,
      authSub: favorite.owner_auth_sub,
      email: favorite.owner_email
    });
  }
  const owners = [...ownerByUid.values()];
  const segmentsByWorkout = new Map();
  for (const segment of segments) {
    const key = String(segment.wid);
    const rows = segmentsByWorkout.get(key) || [];
    rows.push(segment);
    segmentsByWorkout.set(key, rows);
  }
  const favoritesByWorkout = new Map();
  for (const favorite of favorites) {
    const owner = ownerByUid.get(String(favorite.uid));
    if (!owner) continue;
    const key = String(favorite.workout_id);
    const rows = favoritesByWorkout.get(key) || [];
    rows.push(owner.key);
    favoritesByWorkout.set(key, rows);
  }

  /** @type {import("fflate").Zippable} */
  const entries = {};
  let segmentCount = 0;
  let favoriteCount = 0;
  for (const workout of workouts) {
    const sourceId = String(workout.id);
    const owner = ownerByUid.get(String(workout.uid));
    const workoutSegments = segmentsByWorkout.get(sourceId) || [];
    const favoriteOwnerKeys = favoritesByWorkout.get(sourceId) || [];
    segmentCount += workoutSegments.length;
    favoriteCount += favoriteOwnerKeys.length;
    const base = `workouts/${owner.key}/W-${sourceId}`;
    entries[`${base}.json`] = strToU8(JSON.stringify(
      serializeAdminWorkout(workout, owner.key, workoutSegments, favoriteOwnerKeys)
    ));
    entries[`${base}.stream`] = new Uint8Array(workout.stream || []);
    if (workout.gps_track_blob) {
      entries[`${base}.gps`] = new Uint8Array(workout.gps_track_blob);
    }
  }
  entries["manifest.json"] = strToU8(JSON.stringify({
    format: ADMIN_WORKOUT_BACKUP_FORMAT,
    version: ADMIN_WORKOUT_BACKUP_VERSION,
    createdAt: new Date(createdAt).toISOString(),
    workoutCount: workouts.length,
    segmentCount,
    favoriteCount,
    owners
  }));
  return Buffer.from(zipSync(entries, { level: 0 }));
}

function entrySize(entry) {
  return Number(entry?.uncompressedSize ?? entry?.vars?.uncompressedSize ?? 0);
}

export async function decodeAdminWorkoutBackup(buffer) {
  let directory;
  try {
    directory = await unzipper.Open.buffer(buffer);
  } catch {
    throw new Error("The uploaded file is not a readable ZIP archive.");
  }
  const files = directory.files.filter((entry) => entry.type === "File");
  const totalBytes = files.reduce((sum, entry) => sum + entrySize(entry), 0);
  if (totalBytes > MAX_UNCOMPRESSED_BYTES || files.some((entry) => entrySize(entry) > MAX_ENTRY_BYTES)) {
    throw new Error("Admin workout backup exceeds the allowed uncompressed size.");
  }
  const byPath = new Map(files.map((entry) => [entry.path, entry]));
  const manifestEntry = byPath.get("manifest.json");
  if (!manifestEntry) throw new Error("Admin workout backup manifest is missing.");
  let manifest;
  try {
    manifest = JSON.parse((await manifestEntry.buffer()).toString("utf8"));
  } catch {
    throw new Error("Admin workout backup manifest is invalid JSON.");
  }
  if (manifest?.format !== ADMIN_WORKOUT_BACKUP_FORMAT || Number(manifest?.version) !== ADMIN_WORKOUT_BACKUP_VERSION) {
    throw new Error("Unsupported admin workout backup format.");
  }
  const owners = Array.isArray(manifest.owners) ? manifest.owners.map((owner) => ({
    key: requiredString(owner?.key, "owner key"),
    authSub: requiredString(owner?.authSub, "owner authSub"),
    email: normalizeEmail(owner?.email),
    sourceUid: owner?.sourceUid == null ? null : String(owner.sourceUid),
    declaredWorkoutCount: Number(owner?.workoutCount) || 0
  })) : [];
  const ownerByKey = new Map(owners.map((owner) => [owner.key, owner]));
  if (ownerByKey.size !== owners.length) throw new Error("Duplicate owner key in workout backup.");

  const metadataEntries = files.filter((entry) => /^workouts\/[^/]+\/W-[^/]+\.json$/u.test(entry.path));
  if (metadataEntries.length > MAX_WORKOUTS || metadataEntries.length !== Number(manifest.workoutCount)) {
    throw new Error("Admin workout backup count does not match its manifest.");
  }
  const workouts = [];
  const actualCounts = new Map();
  let segmentCount = 0;
  let favoriteCount = 0;
  for (const entry of metadataEntries.sort((a, b) => a.path.localeCompare(b.path))) {
    let metadata;
    try {
      metadata = JSON.parse((await entry.buffer()).toString("utf8"));
    } catch {
      throw new Error(`${entry.path} is invalid JSON.`);
    }
    const owner = ownerByKey.get(String(metadata.ownerKey || ""));
    if (!owner) throw new Error(`${entry.path} references an unknown owner.`);
    const base = entry.path.slice(0, -5);
    const streamEntry = byPath.get(`${base}.stream`);
    if (!streamEntry) throw new Error(`${entry.path} has no workout stream.`);
    const gpsEntry = byPath.get(`${base}.gps`);
    const segments = Array.isArray(metadata.segments) ? metadata.segments : [];
    const favoriteOwnerKeys = Array.isArray(metadata.favoriteOwnerKeys) ? metadata.favoriteOwnerKeys : [];
    if (favoriteOwnerKeys.some((key) => !ownerByKey.has(String(key)))) {
      throw new Error(`${entry.path} contains an unknown favorite owner.`);
    }
    workouts.push({
      ownerKey: owner.key,
      sourceId: requiredString(metadata.sourceId, `${entry.path} sourceId`),
      metadata,
      stream: await streamEntry.buffer(),
      gpsTrackBlob: gpsEntry ? await gpsEntry.buffer() : null,
      segments,
      favoriteOwnerKeys
    });
    segmentCount += segments.length;
    favoriteCount += favoriteOwnerKeys.length;
    actualCounts.set(owner.key, (actualCounts.get(owner.key) || 0) + 1);
  }
  for (const owner of owners) {
    if ((actualCounts.get(owner.key) || 0) !== owner.declaredWorkoutCount) {
      throw new Error(`Workout count does not match owner ${owner.key}.`);
    }
  }
  if (segmentCount !== Number(manifest.segmentCount) || favoriteCount !== Number(manifest.favoriteCount)) {
    throw new Error("Workout backup child counts do not match its manifest.");
  }
  return { manifest, owners, workouts };
}

export function validateAdminWorkoutPreviewPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Workout preview must be an object.");
  }
  if (payload.format !== ADMIN_WORKOUT_BACKUP_FORMAT
    || Number(payload.version) !== ADMIN_WORKOUT_BACKUP_VERSION) {
    throw new Error("Unsupported admin workout preview format.");
  }
  const rawOwners = Array.isArray(payload.owners) ? payload.owners : [];
  const owners = rawOwners.map((owner, index) => ({
    key: requiredString(owner?.key, `owners[${index}].key`),
    authSub: requiredString(owner?.authSub, `owners[${index}].authSub`),
    email: normalizeEmail(owner?.email),
    sourceUid: owner?.sourceUid == null ? null : String(owner.sourceUid),
    declaredWorkoutCount: Number(owner?.workoutCount) || 0
  }));
  if (new Set(owners.map((owner) => owner.key)).size !== owners.length) {
    throw new Error("Duplicate owner key in workout preview.");
  }
  const rawWorkouts = Array.isArray(payload.workouts) ? payload.workouts : [];
  if (rawWorkouts.length > MAX_WORKOUTS || rawWorkouts.length !== Number(payload.workoutCount)) {
    throw new Error("Workout preview count does not match its manifest.");
  }
  const actualCounts = new Map();
  const workouts = rawWorkouts.map((row, index) => {
    if (!Array.isArray(row) || row.length < 2) {
      throw new Error(`Invalid workouts[${index}].`);
    }
    const ownerIndex = Number(row[0]);
    const owner = Number.isInteger(ownerIndex) ? owners[ownerIndex] : null;
    if (!owner) throw new Error(`Unknown owner in workouts[${index}].`);
    const startTime = optionalStartTime(row[1], `workouts[${index}].startTime`);
    const streamHash = row[2] == null ? null : String(row[2]).toLowerCase();
    const sourceId = row[3] == null ? null : String(row[3]);
    const chunkIndex = row[4] == null ? null : Number(row[4]);
    if (!startTime && !SHA256_PATTERN.test(streamHash || "")) {
      throw new Error(`Missing stream hash in workouts[${index}].`);
    }
    if (sourceId != null && !sourceId) throw new Error(`Invalid source id in workouts[${index}].`);
    if (chunkIndex != null && (!Number.isInteger(chunkIndex) || chunkIndex < 0)) {
      throw new Error(`Invalid chunk index in workouts[${index}].`);
    }
    actualCounts.set(owner.key, (actualCounts.get(owner.key) || 0) + 1);
    return { ownerKey: owner.key, startTime, streamHash, sourceId, chunkIndex };
  });
  for (const owner of owners) {
    if ((actualCounts.get(owner.key) || 0) !== owner.declaredWorkoutCount) {
      throw new Error(`Workout count does not match owner ${owner.key}.`);
    }
  }
  return {
    createdAt: optionalStartTime(payload.createdAt, "createdAt"),
    owners,
    workouts
  };
}

function publicPreview(prepared) {
  return {
    createdAt: prepared.decoded.manifest.createdAt || null,
    totals: prepared.totals,
    owners: prepared.mappings.map((mapping) => ({
      ownerKey: mapping.ownerKey,
      sourceAuthSub: mapping.sourceAuthSub,
      sourceEmail: mapping.sourceEmail,
      sourceUid: mapping.sourceUid,
      workoutCount: mapping.workoutCount,
      importCount: mapping.importCount,
      duplicateCount: mapping.duplicateCount,
      status: mapping.status,
      matchMethod: mapping.matchMethod,
      targetUid: mapping.targetUid,
      targetEmail: mapping.targetEmail
    }))
  };
}

async function prepareMetadataPreview(decoded, queryable) {
  const users = (await queryable.query("SELECT id, auth_sub, email FROM users ORDER BY id")).rows;
  const mappings = resolveAdminSegmentOwners(
    decoded.owners.map((owner) => ({ ...owner, declaredSegmentCount: owner.declaredWorkoutCount })),
    users
  ).map((mapping) => ({
    ...mapping,
    workoutCount: mapping.segmentCount,
    importCount: 0,
    duplicateCount: 0
  }));
  const workoutsByOwner = new Map();
  const importableWorkouts = [];
  for (const workout of decoded.workouts) {
    const rows = workoutsByOwner.get(workout.ownerKey) || [];
    rows.push(workout);
    workoutsByOwner.set(workout.ownerKey, rows);
  }
  for (const mapping of mappings) {
    if (mapping.status !== "matched") continue;
    const workouts = workoutsByOwner.get(mapping.ownerKey) || [];
    const startTimes = workouts.map((workout) => workout.startTime).filter(Boolean);
    const existingTimes = new Set(startTimes.length === 0 ? [] : (await queryable.query(
      "SELECT start_time FROM workouts WHERE uid = $1 AND start_time = ANY($2::timestamptz[])",
      [mapping.targetUid, startTimes]
    )).rows.map((row) => new Date(row.start_time).toISOString()));
    const existingNullHashes = new Set(workouts.some((workout) => !workout.startTime)
      ? (await queryable.query(
        "SELECT stream FROM workouts WHERE uid = $1 AND start_time IS NULL",
        [mapping.targetUid]
      )).rows.map((row) => streamSha256(row.stream))
      : []);
    for (const workout of workouts) {
      const duplicate = workout.startTime
        ? existingTimes.has(workout.startTime)
        : existingNullHashes.has(workout.streamHash);
      if (duplicate) mapping.duplicateCount += 1;
      else {
        mapping.importCount += 1;
        importableWorkouts.push(workout);
      }
    }
  }
  const totals = mappings.reduce((result, mapping) => {
    result.workouts += mapping.workoutCount;
    result.importable += mapping.importCount;
    result.duplicates += mapping.duplicateCount;
    if (mapping.status === "unmatched") result.unmatched += mapping.workoutCount;
    if (mapping.status === "conflict") result.conflicts += mapping.workoutCount;
    return result;
  }, { workouts: 0, importable: 0, duplicates: 0, unmatched: 0, conflicts: 0 });
  return {
    preview: publicPreview({
      decoded: { manifest: { createdAt: decoded.createdAt } },
      mappings,
      totals
    }),
    importableWorkouts
  };
}

export async function planAdminWorkoutMetadataImport(payload, queryable = pool) {
  let decoded;
  try {
    decoded = validateAdminWorkoutPreviewPayload(payload);
  } catch (error) {
    throw Object.assign(
      error instanceof Error ? error : new Error("Invalid workout preview metadata."),
      { statusCode: 400 }
    );
  }
  return prepareMetadataPreview(decoded, queryable);
}

async function prepareBackup(buffer, queryable) {
  const decoded = await decodeAdminWorkoutBackup(buffer);
  const users = (await queryable.query("SELECT id, auth_sub, email FROM users ORDER BY id")).rows;
  const mappings = resolveAdminSegmentOwners(
    decoded.owners.map((owner) => ({ ...owner, declaredSegmentCount: owner.declaredWorkoutCount })),
    users
  ).map((mapping) => ({ ...mapping, workoutCount: mapping.segmentCount }));
  const mappingByOwner = new Map(mappings.map((mapping) => [mapping.ownerKey, mapping]));
  for (const mapping of mappings) {
    mapping.importCount = 0;
    mapping.duplicateCount = 0;
    mapping.acceptedWorkouts = [];
  }
  for (const workout of decoded.workouts) {
    const mapping = mappingByOwner.get(workout.ownerKey);
    if (mapping?.status !== "matched") continue;
    mapping.acceptedWorkouts.push(workout);
  }
  for (const mapping of mappings) {
    if (mapping.status !== "matched" || mapping.acceptedWorkouts.length === 0) continue;
    const startTimes = mapping.acceptedWorkouts.map((workout) => workout.metadata.start_time).filter(Boolean);
    const existing = startTimes.length === 0 ? [] : (await queryable.query(
      "SELECT start_time FROM workouts WHERE uid = $1 AND start_time = ANY($2::timestamptz[])",
      [mapping.targetUid, startTimes]
    )).rows;
    const existingTimes = new Set(existing.map((row) => new Date(row.start_time).toISOString()));
    const nullStartStreams = mapping.acceptedWorkouts.some((workout) => !workout.metadata.start_time)
      ? (await queryable.query(
        "SELECT stream FROM workouts WHERE uid = $1 AND start_time IS NULL",
        [mapping.targetUid]
      )).rows.map((row) => Buffer.from(row.stream).toString("base64"))
      : [];
    const existingNullStartStreams = new Set(nullStartStreams);
    mapping.acceptedWorkouts = mapping.acceptedWorkouts.filter((workout) => {
      const duplicate = workout.metadata.start_time
        ? existingTimes.has(new Date(workout.metadata.start_time).toISOString())
        : existingNullStartStreams.has(Buffer.from(workout.stream).toString("base64"));
      if (duplicate) mapping.duplicateCount += 1;
      return !duplicate;
    });
    mapping.importCount = mapping.acceptedWorkouts.length;
  }
  const totals = mappings.reduce((result, mapping) => {
    result.workouts += mapping.workoutCount;
    result.importable += mapping.importCount;
    result.duplicates += mapping.duplicateCount;
    if (mapping.status === "unmatched") result.unmatched += mapping.workoutCount;
    if (mapping.status === "conflict") result.conflicts += mapping.workoutCount;
    return result;
  }, { workouts: 0, importable: 0, duplicates: 0, unmatched: 0, conflicts: 0 });
  return { decoded, mappings, mappingByOwner, totals };
}

function workoutInsertValues(workout, uid) {
  const metadata = workout.metadata;
  return [uid, ...ADMIN_WORKOUT_COLUMNS.map((column) => {
    if (column === "fit_device_metadata" || column === "manual_gps_lookup_points") {
      return metadata[column] == null ? null : JSON.stringify(jsonValue(metadata[column]));
    }
    return metadata[column] ?? null;
  }), workout.stream, workout.gpsTrackBlob];
}

async function insertWorkout(queryable, workout, uid) {
  const columns = ["uid", ...ADMIN_WORKOUT_COLUMNS, "stream", "gps_track_blob"];
  const values = workoutInsertValues(workout, uid);
  const placeholders = values.map((_, index) => `$${index + 1}`);
  const result = await queryable.query(
    `INSERT INTO workouts (${columns.join(", ")}) VALUES (${placeholders.join(", ")}) RETURNING id`,
    values
  );
  return String(result.rows[0].id);
}

async function insertSegments(queryable, workoutId, uid, segments) {
  for (const segment of segments) {
    await queryable.query(`
      INSERT INTO workout_segments (${["wid", "uid", ...ADMIN_WORKOUT_SEGMENT_COLUMNS].join(", ")})
      VALUES (${Array.from({ length: ADMIN_WORKOUT_SEGMENT_COLUMNS.length + 2 }, (_, i) => `$${i + 1}`).join(", ")})
      ON CONFLICT (wid, segmenttype, start_offset, duration) DO NOTHING
    `, [workoutId, uid, ...ADMIN_WORKOUT_SEGMENT_COLUMNS.map((column) => segment[column] ?? null)]);
  }
}

export default class AdminWorkoutBackupService {
  static async exportAll() {
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const workouts = (await client.query(`
        SELECT w.*, u.auth_sub AS owner_auth_sub, u.email AS owner_email
        FROM workouts w INNER JOIN users u ON u.id = w.uid
        ORDER BY w.uid, w.start_time ASC NULLS LAST, w.id
      `)).rows;
      const workoutIds = workouts.map((row) => row.id);
      const segments = workoutIds.length ? (await client.query(
        "SELECT * FROM workout_segments WHERE wid = ANY($1::bigint[]) ORDER BY wid, position NULLS LAST, id",
        [workoutIds]
      )).rows : [];
      const favorites = workoutIds.length ? (await client.query(
        `SELECT f.uid, f.workout_id, u.auth_sub AS owner_auth_sub, u.email AS owner_email
         FROM workout_favorites f
         INNER JOIN users u ON u.id = f.uid
         WHERE f.workout_id = ANY($1::bigint[])
         ORDER BY f.workout_id, f.uid`,
        [workoutIds]
      )).rows : [];
      const archive = buildAdminWorkoutBackup({ workouts, segments, favorites });
      await client.query("COMMIT");
      return { archive, workoutCount: workouts.length };
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

  static async previewMetadata(payload) {
    return (await planAdminWorkoutMetadataImport(payload, pool)).preview;
  }

  static async importAll(buffer) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const prepared = await prepareBackup(buffer, client);
      if (prepared.totals.conflicts > 0) {
        throw Object.assign(new Error("Owner mapping contains conflicts. Import was not started."), { statusCode: 409 });
      }
      const targetUidByOwner = new Map(prepared.mappings.map((mapping) => [mapping.ownerKey, mapping.targetUid]));
      let imported = 0;
      let importedSegments = 0;
      let importedFavorites = 0;
      for (const mapping of prepared.mappings) {
        if (mapping.status !== "matched") continue;
        for (let start = 0; start < mapping.acceptedWorkouts.length; start += INSERT_BATCH_SIZE) {
          const chunk = mapping.acceptedWorkouts.slice(start, start + INSERT_BATCH_SIZE);
          for (const workout of chunk) {
            const workoutId = await insertWorkout(client, workout, mapping.targetUid);
            await insertSegments(client, workoutId, mapping.targetUid, workout.segments);
            importedSegments += workout.segments.length;
            for (const favoriteOwnerKey of workout.favoriteOwnerKeys) {
              const favoriteUid = targetUidByOwner.get(favoriteOwnerKey);
              if (!favoriteUid) continue;
              const result = await client.query(
                "INSERT INTO workout_favorites (uid, workout_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
                [favoriteUid, workoutId]
              );
              importedFavorites += Number(result.rowCount || 0);
            }
            imported += 1;
          }
        }
      }
      await client.query("COMMIT");
      return { ...publicPreview(prepared), imported, importedSegments, importedFavorites };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}

export function buildAdminWorkoutBackupFilename(createdAt = new Date()) {
  const timestamp = new Date(createdAt).toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
  return `cwa24-admin-workouts-${timestamp}.zip`;
}
