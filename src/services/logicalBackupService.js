import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { finished } from "node:stream/promises";
import { gzipSync } from "node:zlib";

import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { strToU8 } from "fflate";
import unzipper from "unzipper";

import { normalizeS3Prefix, sanitizeKeyPart } from "../../ops/postgres-backup/backup-common.mjs";
import { applyCompactEncodingOptions, parseFitBufferCompactBrowser } from "../public/js/fit-import-compact-browser.js";
import { createWoa1FileFromCompactAsync } from "../public/js/woa-format-compact.js";
import FitExportService from "../shared/FitExportService.js";
import GpsTrackBlobCodec from "../shared/GpsTrackBlobCodec.js";
import Workout from "../shared/Workout.js";
import { toPostgresBox } from "../shared/postgresSpatial.js";
import AdminSegmentBackupService from "./adminSegmentBackupService.js";
import AdminWorkoutBackupService, {
  ADMIN_WORKOUT_BACKUP_FORMAT,
  ADMIN_WORKOUT_BACKUP_VERSION,
  buildAdminWorkoutBackup,
  serializeAdminWorkout
} from "./adminWorkoutBackupService.js";
import pool from "./database.js";
import { FileDBService } from "./fileDBService.js";
import { enqueueSegmentBestEfforts } from "./segment-best-efforts-service.js";
import StreamingZipFileWriter from "./streamingZipFileWriter.js";
import UserAccountBackupService from "./userAccountBackupService.js";
import { decodeWoa1BufferLight } from "./woa1Service.js";

export const LOGICAL_BACKUP_FORMAT = "cwa24-logical-backup-manifest";
export const LOGICAL_BACKUP_VERSION = 1;
const LOGICAL_FIT_FORMAT = "cwa24-logical-fit-workouts";
const LOGICAL_FIT_VERSION = 2;
const WORKOUT_BATCH_SIZE = 25;
const MODES = new Set(["native", "fit", "both"]);

function configuration() {
  const bucket = String(process.env.LOGICAL_BACKUP_S3_BUCKET || process.env.BACKUP_S3_BUCKET || process.env.S3_BUCKET || "").trim();
  const environment = String(process.env.BACKUP_ENVIRONMENT || process.env.NODE_ENV || "unknown").trim();
  const database = String(process.env.BACKUP_DATABASE_ID || process.env.DB_NAME || "").trim();
  if (!bucket || !database) throw new Error("Logical backups require an S3 bucket and DB_NAME.");
  const base = normalizeS3Prefix(process.env.LOGICAL_BACKUP_S3_PREFIX || "backups/logical");
  return {
    bucket,
    environment,
    database,
    prefix: [base, sanitizeKeyPart(environment), sanitizeKeyPart(database)].join("/")
  };
}

function normalizeMode(value) {
  const mode = String(value || "native").trim().toLowerCase();
  if (!MODES.has(mode)) throw Object.assign(new Error("Backup mode must be native, fit, or both."), { statusCode: 400 });
  return mode;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function jsonValue(value) {
  if (value == null || typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

function rootFor(config, now, backupId) {
  const iso = now.toISOString();
  return `${config.prefix}/${iso.slice(0, 4)}/${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.replace(/[:.]/gu, "-")}-${backupId}`;
}

function validateRoot(value, config = configuration()) {
  const root = String(value || "").replace(/^s3:\/\/[^/]+\//u, "").replace(/\/manifest\.json$/u, "").replace(/^\/+|\/+$/gu, "");
  if (!root.startsWith(`${config.prefix}/`) || !/\/\d{4}\/\d{2}\/\d{2}\/[^/]+$/u.test(root)) {
    throw Object.assign(new Error("Selected logical backup is outside the active environment."), { statusCode: 400 });
  }
  return root;
}

function estimateEtaMs(startedAt, processed, total) {
  if (processed <= 0 || total <= processed) return processed >= total ? 0 : null;
  return Math.round(((Date.now() - startedAt) / processed) * (total - processed));
}

async function report(progress, percent, phase, details = {}) {
  await progress?.(percent, phase, details);
}

async function yieldToEventLoop() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function bodyToBuffer(body) {
  if (!body) throw new Error("S3 object has no body.");
  if (typeof body.transformToByteArray === "function") return Buffer.from(await body.transformToByteArray());
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function writeBodyToFile(body, filePath) {
  if (!body) throw new Error("S3 object has no body.");
  const output = createWriteStream(filePath, { highWaterMark: 256 * 1024 });
  const hash = createHash("sha256");
  let sizeBytes = 0;
  try {
    for await (const chunk of body) {
      const bytes = Buffer.from(chunk);
      hash.update(bytes);
      sizeBytes += bytes.byteLength;
      if (!output.write(bytes)) await once(output, "drain");
    }
    output.end();
    await finished(output);
    return { filePath, sizeBytes, sha256: hash.digest("hex") };
  } catch (error) {
    output.destroy(error);
    throw error;
  }
}

async function uploadBuffer(s3, config, key, bytes, contentType) {
  const body = Buffer.from(bytes);
  await s3.send(new PutObjectCommand({ Bucket: config.bucket, Key: key, Body: body, ContentType: contentType }));
  return { key, sizeBytes: body.byteLength, sha256: sha256(body) };
}

async function uploadFile(s3, config, key, file, contentType) {
  await s3.send(new PutObjectCommand({
    Bucket: config.bucket,
    Key: key,
    Body: createReadStream(file.filePath),
    ContentLength: file.sizeBytes,
    ContentType: contentType
  }));
  return { key, sizeBytes: file.sizeBytes, sha256: file.sha256 };
}

async function downloadArtifactToFile(s3, config, root, descriptor, filePath) {
  if (!descriptor?.key || !descriptor.key.startsWith(`${root}/`)) throw new Error("Logical backup artifact key is invalid.");
  const response = await s3.send(new GetObjectCommand({ Bucket: config.bucket, Key: descriptor.key }));
  const file = await writeBodyToFile(response.Body, filePath);
  if (file.sizeBytes !== Number(descriptor.sizeBytes) || file.sha256 !== descriptor.sha256) {
    throw new Error(`Logical backup artifact failed integrity validation: ${descriptor.key}`);
  }
  return file;
}

async function readArtifactBuffer(s3, config, root, descriptor) {
  if (!descriptor?.key || !descriptor.key.startsWith(`${root}/`)) throw new Error("Logical backup artifact key is invalid.");
  const response = await s3.send(new GetObjectCommand({ Bucket: config.bucket, Key: descriptor.key }));
  const bytes = await bodyToBuffer(response.Body);
  if (bytes.byteLength !== Number(descriptor.sizeBytes) || sha256(bytes) !== descriptor.sha256) {
    throw new Error(`Logical backup artifact failed integrity validation: ${descriptor.key}`);
  }
  return bytes;
}

function groupBy(rows, key) {
  const result = new Map();
  for (const row of rows) {
    const group = result.get(String(row[key])) || [];
    group.push(row);
    result.set(String(row[key]), group);
  }
  return result;
}

async function workoutFromStored(stream, codec) {
  const normalizedCodec = String(codec || "gzip").toLowerCase();
  const raw = normalizedCodec === "identity" ? stream : await Workout.decompress(stream, normalizedCodec);
  return Workout.fromBuffer(raw);
}

async function buildFit(workoutRow, metadata, segments) {
  const workout = await workoutFromStored(workoutRow.stream, metadata.stream_codec);
  const gps = workoutRow.gps_track_blob
    ? await GpsTrackBlobCodec.decodeCompressed(workoutRow.gps_track_blob, {
      codec: metadata.gps_track_blob_codec || "identity",
      includeGeoJson: false
    })
    : null;
  return FitExportService.buildFitFromWorkout(workout, {
    gpsCoordinates: gps?.track?.map((point) => [point.lat, point.lng]) || [],
    sampleRateGps: Number(metadata.samplerategps || gps?.sampleRateGps || 1),
    includeGps: Boolean(metadata.validgps && gps?.validGps),
    gpsSource: metadata.gps_source,
    fitDeviceMetadata: jsonValue(metadata.fit_device_metadata),
    normalizedPower: metadata.avg_normalized_power,
    totalCalories: metadata.total_calories,
    workoutType: metadata.workout_type,
    segments
  });
}

async function exportWorkoutFiles({ mode, tempDirectory, progress }) {
  const client = await pool.connect();
  const nativeWriter = mode === "native" || mode === "both"
    ? new StreamingZipFileWriter(path.join(tempDirectory, "workouts-native.zip"))
    : null;
  const fitWriter = mode === "fit" || mode === "both"
    ? new StreamingZipFileWriter(path.join(tempDirectory, "workouts-fit.zip"))
    : null;
  const startedAt = Date.now();
  let peakRssBytes = process.memoryUsage().rss;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const users = (await client.query(`
      SELECT u.id, u.auth_sub, u.email, COUNT(w.id)::integer AS workout_count
      FROM users u LEFT JOIN workouts w ON w.uid = u.id
      GROUP BY u.id, u.auth_sub, u.email
      ORDER BY u.id
    `)).rows;
    const owners = users.map((user, index) => ({
      key: `owner-${index + 1}`,
      authSub: String(user.auth_sub),
      email: String(user.email || "").trim().toLowerCase(),
      sourceUid: String(user.id),
      workoutCount: Number(user.workout_count) || 0
    }));
    const ownerByUid = new Map(owners.map((owner) => [owner.sourceUid, owner]));
    const ownerIndexByUid = new Map(owners.map((owner, index) => [owner.sourceUid, index]));
    const totals = (await client.query(`
      SELECT
        (SELECT COUNT(*) FROM workouts)::integer AS workouts,
        (SELECT COUNT(*) FROM workout_segments)::integer AS segments,
        (SELECT COUNT(*) FROM workout_favorites)::integer AS favorites
    `)).rows[0];
    const total = Number(totals.workouts) || 0;
    const previewRows = [];
    let processed = 0;
    let cursor = 0;

    while (true) {
      const workouts = (await client.query(`
        SELECT w.*
        FROM workouts w
        WHERE w.id > $1
        ORDER BY w.id
        LIMIT $2
      `, [cursor, WORKOUT_BATCH_SIZE])).rows;
      if (workouts.length === 0) break;
      const ids = workouts.map((row) => row.id);
      const segments = (await client.query(
        "SELECT * FROM workout_segments WHERE wid = ANY($1::bigint[]) ORDER BY wid, position NULLS LAST, id",
        [ids]
      )).rows;
      const favorites = (await client.query(`
        SELECT f.uid, f.workout_id
        FROM workout_favorites f
        WHERE f.workout_id = ANY($1::bigint[])
        ORDER BY f.workout_id, f.uid
      `, [ids])).rows;
      const segmentsByWorkout = groupBy(segments, "wid");
      const favoritesByWorkout = groupBy(favorites, "workout_id");

      for (const workout of workouts) {
        const owner = ownerByUid.get(String(workout.uid));
        if (!owner) throw new Error(`Workout ${workout.id} has no logical backup owner.`);
        const workoutSegments = segmentsByWorkout.get(String(workout.id)) || [];
        const favoriteOwnerKeys = (favoritesByWorkout.get(String(workout.id)) || [])
          .map((favorite) => ownerByUid.get(String(favorite.uid))?.key)
          .filter(Boolean);
        const metadata = serializeAdminWorkout(workout, owner.key, workoutSegments, favoriteOwnerKeys);
        const base = `workouts/${owner.key}/W-${workout.id}`;
        previewRows.push([
          ownerIndexByUid.get(owner.sourceUid),
          metadata.start_time ? new Date(metadata.start_time).toISOString() : null,
          createHash("sha256").update(workout.stream).digest("hex")
        ]);

        if (nativeWriter) {
          await nativeWriter.add(`${base}.json`, strToU8(JSON.stringify(metadata)));
          await nativeWriter.add(`${base}.stream`, workout.stream);
          if (workout.gps_track_blob) await nativeWriter.add(`${base}.gps`, workout.gps_track_blob);
        }
        if (fitWriter) {
          const fit = await buildFit(workout, metadata, workoutSegments);
          await fitWriter.add(`${base}.fit`, fit);
          await fitWriter.add(`${base}.json`, strToU8(JSON.stringify(metadata)));
        }
        processed += 1;
      }
      cursor = Number(workouts.at(-1).id);
      const percent = 10 + Math.round((processed / Math.max(1, total)) * 70);
      await report(progress, percent, fitWriter ? "encoding-workouts-fit" : "encoding-workouts-native", {
        processed,
        total,
        etaMs: estimateEtaMs(startedAt, processed, total)
      });
      peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
      await yieldToEventLoop();
    }

    const nativeManifest = {
      format: ADMIN_WORKOUT_BACKUP_FORMAT,
      version: ADMIN_WORKOUT_BACKUP_VERSION,
      createdAt: new Date().toISOString(),
      workoutCount: total,
      segmentCount: Number(totals.segments) || 0,
      favoriteCount: Number(totals.favorites) || 0,
      owners
    };
    const fitManifest = {
      format: LOGICAL_FIT_FORMAT,
      version: LOGICAL_FIT_VERSION,
      createdAt: nativeManifest.createdAt,
      workoutCount: total,
      owners
    };
    const previewIndex = Buffer.from(JSON.stringify({
      format: ADMIN_WORKOUT_BACKUP_FORMAT,
      version: ADMIN_WORKOUT_BACKUP_VERSION,
      createdAt: nativeManifest.createdAt,
      workoutCount: total,
      owners,
      workouts: previewRows
    }));

    if (nativeWriter) await nativeWriter.add("manifest.json", strToU8(JSON.stringify(nativeManifest)));
    if (fitWriter) await fitWriter.add("manifest.json", strToU8(JSON.stringify(fitManifest)));
    const [nativeFile, fitFile] = await Promise.all([
      nativeWriter?.finish() || null,
      fitWriter?.finish() || null
    ]);
    await client.query("COMMIT");
    return {
      workoutCount: total,
      previewIndex,
      nativeFile,
      fitFile,
      profile: { elapsedMs: Date.now() - startedAt, peakRssBytes }
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    nativeWriter?.abort(error);
    fitWriter?.abort(error);
    throw error;
  } finally {
    client.release();
  }
}

function entryMap(directory) {
  return new Map(directory.files.filter((entry) => entry.type === "File").map((entry) => [entry.path, entry]));
}

async function readJsonEntry(entry, label) {
  if (!entry) throw new Error(`${label} is missing.`);
  try { return JSON.parse((await entry.buffer()).toString("utf8")); } catch { throw new Error(`${label} is invalid JSON.`); }
}

async function compactPreviewFromArchive(filePath, source) {
  const directory = await unzipper.Open.file(filePath);
  const files = entryMap(directory);
  const manifest = await readJsonEntry(files.get("manifest.json"), "Workout manifest");
  const owners = Array.isArray(manifest.owners) ? manifest.owners.map((owner) => ({
    ...owner,
    workoutCount: Number(owner.workoutCount ?? owner.declaredWorkoutCount) || 0
  })) : [];
  const ownerIndex = new Map(owners.map((owner, index) => [String(owner.key), index]));
  const workouts = [];
  if (source === "fit" && Number(manifest.version) === 1 && Array.isArray(manifest.workouts)) {
    const ownerByKey = new Map(owners.map((owner) => [String(owner.key), owner]));
    for (const row of manifest.workouts) {
      let streamHash = null;
      if (!row.sourceMetadata?.start_time) {
        const decoded = await fitEntryToWorkout(row, files, ownerByKey);
        streamHash = sha256(decoded.stream);
      }
      workouts.push([
        ownerIndex.get(String(row.ownerKey)),
        row.sourceMetadata?.start_time ? new Date(row.sourceMetadata.start_time).toISOString() : null,
        streamHash
      ]);
    }
  } else {
    const metadataEntries = [...files.values()].filter((entry) => /^workouts\/[^/]+\/W-[^/]+\.json$/u.test(entry.path));
    for (const entry of metadataEntries) {
      const metadata = await readJsonEntry(entry, entry.path);
      let streamHash = null;
      if (!metadata.start_time && source === "native") {
        const streamEntry = files.get(entry.path.replace(/\.json$/u, ".stream"));
        if (streamEntry) streamHash = sha256(await streamEntry.buffer());
      }
      workouts.push([
        ownerIndex.get(String(metadata.ownerKey)),
        metadata.start_time ? new Date(metadata.start_time).toISOString() : null,
        streamHash || "0".repeat(64)
      ]);
    }
  }
  return {
    format: ADMIN_WORKOUT_BACKUP_FORMAT,
    version: ADMIN_WORKOUT_BACKUP_VERSION,
    createdAt: manifest.createdAt || null,
    workoutCount: workouts.length,
    owners,
    workouts
  };
}

function fitSourceEntries(manifest, files) {
  if (Number(manifest.version) === 1 && Array.isArray(manifest.workouts)) return manifest.workouts;
  return [...files.values()]
    .filter((entry) => /^workouts\/[^/]+\/W-[^/]+\.json$/u.test(entry.path))
    .map((entry) => ({ metadataEntry: entry }));
}

async function fitEntryToWorkout(source, files, ownerByKey) {
  const metadata = source.metadataEntry
    ? await readJsonEntry(source.metadataEntry, source.metadataEntry.path)
    : source.sourceMetadata;
  const fitPath = source.path || source.metadataEntry.path.replace(/\.json$/u, ".fit");
  const fitEntry = files.get(fitPath);
  const owner = ownerByKey.get(String(source.ownerKey || metadata.ownerKey));
  if (!fitEntry || !owner) throw new Error(`Incomplete FIT workout artifact: ${fitPath}`);
  const parsed = applyCompactEncodingOptions(parseFitBufferCompactBrowser(await fitEntry.buffer()), {});
  const result = await createWoa1FileFromCompactAsync(parsed, {
    sourceName: fitPath,
    sampleRateSeconds: 5,
    gpsCoordinateEncoding: "bitmap-columnar",
    powerEncoding: "delta8-q4w",
    distanceEncoding: "uint8-q05m",
    altitudeEncoding: "rle-delta-q1m",
    streamCodec: "gzip",
    gpsTrackBlobCodec: "identity",
    compressWorkoutStream: async (bytes) => gzipSync(bytes, { level: 4 }),
    compressGpsTrack: null
  });
  const decoded = decodeWoa1BufferLight(result.bytes);
  const prepared = FileDBService.preparePersistedWoaInsertPayload(decoded.meta, {
    uid: owner.sourceUid,
    workoutStreamStoredBytes: decoded.workoutStreamStoredBytes,
    gpsTrackStoredBytes: decoded.gpsTrackStoredBytes
  });
  const mapped = {
    ...metadata,
    ...prepared.fileRow,
    validgps: prepared.fileRow.validGps,
    gps_bounds: prepared.fileRow.validGps ? toPostgresBox(prepared.gps_track.bbox) : null,
    track_start_lat: prepared.trackStartLat,
    track_start_lng: prepared.trackStartLng,
    track_end_lat: prepared.trackEndLat,
    track_end_lng: prepared.trackEndLng,
    points_count: prepared.points_count,
    samplerategps: prepared.sampleRateGPS,
    gps_source: prepared.gpsSource,
    stream_codec: prepared.streamCodec,
    gps_track_blob_codec: prepared.gpsTrackBlobCodec
  };
  return {
    owner,
    metadata: mapped,
    stream: Buffer.from(decoded.workoutStreamStoredBytes),
    gpsTrackBlob: decoded.gpsTrackStoredBytes.byteLength ? Buffer.from(decoded.gpsTrackStoredBytes) : null,
    sourceId: String(source.sourceId || metadata.sourceId),
    segments: source.segments || metadata.segments || [],
    favoriteOwnerKeys: source.favoriteOwnerKeys || metadata.favoriteOwnerKeys || []
  };
}

async function nativeEntryToWorkout(metadataEntry, files, ownerByKey) {
  const metadata = await readJsonEntry(metadataEntry, metadataEntry.path);
  const owner = ownerByKey.get(String(metadata.ownerKey));
  const base = metadataEntry.path.slice(0, -5);
  const streamEntry = files.get(`${base}.stream`);
  if (!owner || !streamEntry) throw new Error(`Incomplete native workout artifact: ${base}`);
  return {
    owner,
    metadata,
    stream: await streamEntry.buffer(),
    gpsTrackBlob: files.has(`${base}.gps`) ? await files.get(`${base}.gps`).buffer() : null,
    sourceId: String(metadata.sourceId),
    segments: metadata.segments || [],
    favoriteOwnerKeys: metadata.favoriteOwnerKeys || []
  };
}

async function importWorkoutBatch(entries, ownerByKey) {
  const workouts = [];
  const segments = [];
  const favorites = [];
  for (const entry of entries) {
    workouts.push({
      ...entry.metadata,
      id: entry.sourceId,
      uid: entry.owner.sourceUid,
      owner_auth_sub: entry.owner.authSub,
      owner_email: entry.owner.email,
      stream: entry.stream,
      gps_track_blob: entry.gpsTrackBlob
    });
    for (const segment of entry.segments) segments.push({ ...segment, wid: entry.sourceId });
    for (const favoriteOwnerKey of entry.favoriteOwnerKeys) {
      const favoriteOwner = ownerByKey.get(String(favoriteOwnerKey));
      if (favoriteOwner) favorites.push({
        workout_id: entry.sourceId,
        uid: favoriteOwner.sourceUid,
        owner_auth_sub: favoriteOwner.authSub,
        owner_email: favoriteOwner.email
      });
    }
  }
  return AdminWorkoutBackupService.importAll(buildAdminWorkoutBackup({ workouts, segments, favorites }));
}

async function restoreWorkoutFile(filePath, source, progress) {
  const directory = await unzipper.Open.file(filePath);
  const files = entryMap(directory);
  const manifest = await readJsonEntry(files.get("manifest.json"), "Workout manifest");
  const nativeFormatValid = source === "native"
    && manifest.format === ADMIN_WORKOUT_BACKUP_FORMAT
    && Number(manifest.version) === ADMIN_WORKOUT_BACKUP_VERSION;
  const fitFormatValid = source === "fit"
    && manifest.format === LOGICAL_FIT_FORMAT
    && [1, LOGICAL_FIT_VERSION].includes(Number(manifest.version));
  if (!nativeFormatValid && !fitFormatValid) {
    throw new Error(`Unsupported logical ${source.toUpperCase()} workout artifact.`);
  }
  const owners = Array.isArray(manifest.owners) ? manifest.owners.map((owner) => ({
    ...owner,
    workoutCount: Number(owner.workoutCount ?? owner.declaredWorkoutCount) || 0
  })) : [];
  const ownerByKey = new Map(owners.map((owner) => [String(owner.key), owner]));
  const sources = source === "fit"
    ? fitSourceEntries(manifest, files)
    : [...files.values()].filter((entry) => /^workouts\/[^/]+\/W-[^/]+\.json$/u.test(entry.path));
  if (sources.length !== Number(manifest.workoutCount)) {
    throw new Error("Logical workout artifact count does not match its manifest.");
  }
  const aggregate = { imported: 0, importedSegments: 0, importedFavorites: 0 };
  const startedAt = Date.now();
  for (let offset = 0; offset < sources.length; offset += WORKOUT_BATCH_SIZE) {
    const batchSources = sources.slice(offset, offset + WORKOUT_BATCH_SIZE);
    const batch = [];
    for (const item of batchSources) {
      batch.push(source === "fit"
        ? await fitEntryToWorkout(item, files, ownerByKey)
        : await nativeEntryToWorkout(item, files, ownerByKey));
    }
    const result = await importWorkoutBatch(batch, ownerByKey);
    aggregate.imported += Number(result.imported) || 0;
    aggregate.importedSegments += Number(result.importedSegments) || 0;
    aggregate.importedFavorites += Number(result.importedFavorites) || 0;
    const processed = Math.min(offset + batch.length, sources.length);
    await report(progress, 60 + Math.round((processed / Math.max(1, sources.length)) * 38), `restoring-workouts-${source}`, {
      processed,
      total: sources.length,
      etaMs: estimateEtaMs(startedAt, processed, sources.length)
    });
    await yieldToEventLoop();
  }
  return aggregate;
}

export default class LogicalBackupService {
  static configuration() { return configuration(); }
  static validateRoot(value) { return validateRoot(value); }

  static async create({ mode = "native", label = null, progress = null } = {}) {
    const selectedMode = normalizeMode(mode);
    const config = configuration();
    const s3 = new S3Client({ region: process.env.AWS_REGION });
    const now = new Date();
    const backupId = randomUUID();
    const root = rootFor(config, now, backupId);
    const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "cwa24-logical-backup-"));
    const startedAt = Date.now();
    try {
      await report(progress, 2, "exporting-accounts");
      const accountsStartedAt = Date.now();
      const accountBackup = await UserAccountBackupService.exportAll();
      const accounts = Buffer.from(`${JSON.stringify(accountBackup)}\n`);
      const accountsMs = Date.now() - accountsStartedAt;
      await report(progress, 5, "exporting-segments");
      const segmentsStartedAt = Date.now();
      const segmentResult = await AdminSegmentBackupService.exportAll();
      const segmentsMs = Date.now() - segmentsStartedAt;
      await report(progress, 10, "exporting-workouts", { processed: 0, total: null, etaMs: null });
      const workoutResult = await exportWorkoutFiles({ mode: selectedMode, tempDirectory, progress });

      await report(progress, 82, "uploading-s3");
      const uploadStartedAt = Date.now();
      const artifacts = {
        accounts: await uploadBuffer(s3, config, `${root}/accounts.json`, accounts, "application/json"),
        segments: await uploadBuffer(s3, config, `${root}/segments.zip`, segmentResult.archive, "application/zip"),
        workoutIndex: await uploadBuffer(s3, config, `${root}/workout-index.json`, workoutResult.previewIndex, "application/json")
      };
      if (workoutResult.nativeFile) {
        artifacts.workoutsNative = await uploadFile(s3, config, `${root}/workouts-native.zip`, workoutResult.nativeFile, "application/zip");
      }
      await report(progress, 91, "uploading-s3", { processed: 1, total: workoutResult.fitFile ? 2 : 1 });
      if (workoutResult.fitFile) {
        artifacts.workoutsFit = await uploadFile(s3, config, `${root}/workouts-fit.zip`, workoutResult.fitFile, "application/zip");
      }
      const manifest = {
        format: LOGICAL_BACKUP_FORMAT,
        version: LOGICAL_BACKUP_VERSION,
        status: "complete",
        backupId,
        createdAt: now.toISOString(),
        label: String(label || "").trim().slice(0, 80) || null,
        environment: config.environment,
        database: config.database,
        mode: selectedMode,
        counts: {
          users: Number(accountBackup.users?.length || 0),
          segments: segmentResult.segmentCount,
          workouts: workoutResult.workoutCount
        },
        artifacts,
        implementation: { workoutArchiveVersion: 2, batchSize: WORKOUT_BATCH_SIZE }
      };
      await s3.send(new PutObjectCommand({
        Bucket: config.bucket,
        Key: `${root}/manifest.json`,
        Body: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
        ContentType: "application/json"
      }));
      console.info("[logical-backup] create.profile", {
        backupId,
        mode: selectedMode,
        workoutCount: workoutResult.workoutCount,
        accountsMs,
        segmentsMs,
        workoutsMs: workoutResult.profile.elapsedMs,
        uploadMs: Date.now() - uploadStartedAt,
        totalMs: Date.now() - startedAt,
        peakRssBytes: workoutResult.profile.peakRssBytes,
        nativeBytes: workoutResult.nativeFile?.sizeBytes || 0,
        fitBytes: workoutResult.fitFile?.sizeBytes || 0
      });
      await report(progress, 100, "completed", { processed: workoutResult.workoutCount, total: workoutResult.workoutCount, etaMs: 0 });
      return { ...manifest, rootKey: root };
    } finally {
      await fs.rm(tempDirectory, { recursive: true, force: true });
    }
  }

  static async list({ limit = 50 } = {}) {
    const config = configuration();
    const s3 = new S3Client({ region: process.env.AWS_REGION });
    const objects = [];
    let continuationToken;
    do {
      const response = await s3.send(new ListObjectsV2Command({
        Bucket: config.bucket,
        Prefix: `${config.prefix}/`,
        ContinuationToken: continuationToken
      }));
      objects.push(...(response.Contents || []));
      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);
    const keys = objects.filter((value) => value.Key?.endsWith("/manifest.json"))
      .sort((a, b) => new Date(b.LastModified || 0).getTime() - new Date(a.LastModified || 0).getTime()).slice(0, limit);
    const backups = [];
    for (const item of keys) {
      try {
        const body = await bodyToBuffer((await s3.send(new GetObjectCommand({ Bucket: config.bucket, Key: item.Key }))).Body);
        const manifest = JSON.parse(body.toString("utf8"));
        if (manifest.format === LOGICAL_BACKUP_FORMAT && manifest.status === "complete") {
          backups.push({ ...manifest, rootKey: item.Key.replace(/\/manifest\.json$/u, "") });
        }
      } catch (error) {
        console.warn("Skipping unreadable logical backup manifest", { key: item.Key, error: error.message });
      }
    }
    return { ...config, backups };
  }

  static async loadManifest(rootValue) {
    const config = configuration();
    const root = validateRoot(rootValue, config);
    const s3 = new S3Client({ region: process.env.AWS_REGION });
    const body = await bodyToBuffer((await s3.send(new GetObjectCommand({ Bucket: config.bucket, Key: `${root}/manifest.json` }))).Body);
    const manifest = JSON.parse(body.toString("utf8"));
    if (manifest.format !== LOGICAL_BACKUP_FORMAT || manifest.status !== "complete") throw new Error("Invalid logical backup manifest.");
    return { config, root, s3, manifest };
  }

  static async preview(rootValue, { accounts = true, segments = true, workouts = true, workoutSource = "native" } = {}) {
    const loaded = await this.loadManifest(rootValue);
    const result = { manifest: loaded.manifest, selections: { accounts, segments, workouts, workoutSource } };
    if (segments) {
      result.segments = await AdminSegmentBackupService.preview(
        await readArtifactBuffer(loaded.s3, loaded.config, loaded.root, loaded.manifest.artifacts.segments)
      );
    }
    if (workouts) {
      if (loaded.manifest.artifacts.workoutIndex) {
        const index = JSON.parse((await readArtifactBuffer(
          loaded.s3,
          loaded.config,
          loaded.root,
          loaded.manifest.artifacts.workoutIndex
        )).toString("utf8"));
        result.workouts = await AdminWorkoutBackupService.previewMetadata(index);
      } else {
        const descriptor = workoutSource === "fit" ? loaded.manifest.artifacts.workoutsFit : loaded.manifest.artifacts.workoutsNative;
        if (!descriptor) throw Object.assign(new Error(`Backup has no ${workoutSource.toUpperCase()} workout artifact.`), { statusCode: 400 });
        const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "cwa24-logical-preview-"));
        try {
          const file = await downloadArtifactToFile(loaded.s3, loaded.config, loaded.root, descriptor, path.join(tempDirectory, "workouts.zip"));
          result.workouts = await AdminWorkoutBackupService.previewMetadata(await compactPreviewFromArchive(file.filePath, workoutSource));
        } finally {
          await fs.rm(tempDirectory, { recursive: true, force: true });
        }
      }
    }
    return result;
  }

  static async restore(rootValue, options = {}, progress = null) {
    const loaded = await this.loadManifest(rootValue);
    const selected = {
      accounts: options.accounts !== false,
      segments: options.segments !== false,
      workouts: options.workouts !== false,
      workoutSource: options.workoutSource === "fit" ? "fit" : "native"
    };
    const result = { selections: selected };
    if (selected.accounts) {
      await report(progress, 5, "restoring-accounts");
      const bytes = await readArtifactBuffer(loaded.s3, loaded.config, loaded.root, loaded.manifest.artifacts.accounts);
      result.accounts = await UserAccountBackupService.importAll(JSON.parse(bytes.toString("utf8")));
    }
    if (selected.segments) {
      await report(progress, 25, "restoring-segments");
      result.segments = await AdminSegmentBackupService.importAll(
        await readArtifactBuffer(loaded.s3, loaded.config, loaded.root, loaded.manifest.artifacts.segments)
      );
      const queueResults = await Promise.allSettled(
        result.segments.queueTargets.filter((target) => target.segmentIds.length > 0).map((target) => enqueueSegmentBestEfforts(target))
      );
      result.segments.queueFailures = queueResults.filter((entry) => entry.status === "rejected").length;
    }
    if (selected.workouts) {
      const descriptor = selected.workoutSource === "fit" ? loaded.manifest.artifacts.workoutsFit : loaded.manifest.artifacts.workoutsNative;
      if (!descriptor) throw Object.assign(new Error(`Backup has no ${selected.workoutSource.toUpperCase()} workout artifact.`), { statusCode: 400 });
      const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "cwa24-logical-restore-"));
      try {
        await report(progress, 45, "downloading-workouts");
        const file = await downloadArtifactToFile(loaded.s3, loaded.config, loaded.root, descriptor, path.join(tempDirectory, "workouts.zip"));
        result.workouts = await restoreWorkoutFile(file.filePath, selected.workoutSource, progress);
      } finally {
        await fs.rm(tempDirectory, { recursive: true, force: true });
      }
    }
    await report(progress, 100, "completed", { etaMs: 0 });
    return result;
  }
}
