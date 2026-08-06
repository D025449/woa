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
  planAdminWorkoutMetadataImport,
  serializeAdminWorkout
} from "./adminWorkoutBackupService.js";
import pool from "./database.js";
import { FileDBService } from "./fileDBService.js";
import { enqueueSegmentBestEfforts } from "./segment-best-efforts-service.js";
import {
  buildLogicalWorkoutChunkCollection,
  LOGICAL_WORKOUT_CHUNK_SIZE,
  validateLogicalWorkoutChunkCollection,
  validateLogicalWorkoutChunkIndex
} from "./logicalWorkoutChunkFormat.js";
import StreamingZipFileWriter from "./streamingZipFileWriter.js";
import UserAccountBackupService from "./userAccountBackupService.js";
import { decodeWoa1BufferLight } from "./woa1Service.js";

export const LOGICAL_BACKUP_FORMAT = "cwa24-logical-backup-manifest";
export const LOGICAL_BACKUP_VERSION = 2;
const LOGICAL_FIT_FORMAT = "cwa24-logical-fit-workouts";
const LOGICAL_FIT_VERSION = 3;
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

async function workoutFromStored(stream, codec, profile = null) {
  const normalizedCodec = String(codec || "gzip").toLowerCase();
  let startedAt = performance.now();
  const raw = normalizedCodec === "identity" ? stream : await Workout.decompress(stream, normalizedCodec);
  if (profile) profile.decompressWorkoutMs += performance.now() - startedAt;
  startedAt = performance.now();
  const workout = Workout.fromBuffer(raw);
  if (profile) profile.parseWorkoutMs += performance.now() - startedAt;
  return workout;
}

async function buildFit(workoutRow, metadata, segments, profile = null) {
  const workout = await workoutFromStored(workoutRow.stream, metadata.stream_codec, profile);
  let startedAt = performance.now();
  const gps = workoutRow.gps_track_blob
    ? await GpsTrackBlobCodec.decodeCompressed(workoutRow.gps_track_blob, {
      codec: metadata.gps_track_blob_codec || "identity",
      includeGeoJson: false
    })
    : null;
  if (profile) profile.decodeGpsTrackMs += performance.now() - startedAt;
  startedAt = performance.now();
  const gpsCoordinates = gps?.track?.map((point) => [point.lat, point.lng]) || [];
  if (profile) profile.mapGpsTrackMs += performance.now() - startedAt;
  return FitExportService.buildFitFromWorkout(workout, {
    gpsCoordinates,
    sampleRateGps: Number(metadata.samplerategps || gps?.sampleRateGps || 1),
    includeGps: Boolean(metadata.validgps && gps?.validGps),
    gpsSource: metadata.gps_source,
    fitDeviceMetadata: jsonValue(metadata.fit_device_metadata),
    normalizedPower: metadata.avg_normalized_power,
    totalCalories: metadata.total_calories,
    workoutType: metadata.workout_type,
    segments,
    profile
  });
}

function chunkOwners(owners, workoutCounts, referencedOwnerKeys) {
  return owners.filter((owner) => referencedOwnerKeys.has(owner.key)).map((owner) => ({
    ...owner,
    workoutCount: workoutCounts.get(owner.key) || 0
  }));
}

async function exportWorkoutFiles({ mode, tempDirectory, s3, config, root, progress }) {
  const client = await pool.connect();
  const includeNative = mode === "native" || mode === "both";
  const includeFit = mode === "fit" || mode === "both";
  const startedAt = Date.now();
  let peakRssBytes = process.memoryUsage().rss;
  let chunkUploadMs = 0;
  let activeChunk = null;
  const fitProfile = {
    decompressWorkoutMs: 0,
    parseWorkoutMs: 0,
    decodeGpsTrackMs: 0,
    mapGpsTrackMs: 0,
    normalizeRecordsMs: 0,
    analyzeRecordsMs: 0,
    writeMetadataMs: 0,
    writeRecordsMs: 0,
    writeSummariesMs: 0,
    finalizeMs: 0,
    totalMs: 0,
    recordCount: 0
  };

  const startChunk = (index) => ({
    index,
    workoutCount: 0,
    segmentCount: 0,
    favoriteCount: 0,
    workoutCounts: new Map(),
    referencedOwnerKeys: new Set(),
    nativeWriter: includeNative
      ? new StreamingZipFileWriter(path.join(tempDirectory, `workouts-native-${index}.zip`))
      : null,
    fitWriter: includeFit
      ? new StreamingZipFileWriter(path.join(tempDirectory, `workouts-fit-${index}.zip`))
      : null
  });

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
    const nativeChunks = [];
    const fitChunks = [];
    let processed = 0;
    let cursor = 0;
    let chunkIndex = 0;

    const finishChunk = async () => {
      if (!activeChunk || activeChunk.workoutCount === 0) return;
      const createdAt = new Date().toISOString();
      const ownersForChunk = chunkOwners(owners, activeChunk.workoutCounts, activeChunk.referencedOwnerKeys);
      if (activeChunk.nativeWriter) {
        await activeChunk.nativeWriter.add("manifest.json", strToU8(JSON.stringify({
          format: ADMIN_WORKOUT_BACKUP_FORMAT,
          version: ADMIN_WORKOUT_BACKUP_VERSION,
          createdAt,
          workoutCount: activeChunk.workoutCount,
          segmentCount: activeChunk.segmentCount,
          favoriteCount: activeChunk.favoriteCount,
          owners: ownersForChunk
        })));
      }
      if (activeChunk.fitWriter) {
        await activeChunk.fitWriter.add("manifest.json", strToU8(JSON.stringify({
          format: LOGICAL_FIT_FORMAT,
          version: LOGICAL_FIT_VERSION,
          createdAt,
          workoutCount: activeChunk.workoutCount,
          owners: ownersForChunk
        })));
      }
      const [nativeFile, fitFile] = await Promise.all([
        activeChunk.nativeWriter?.finish() || null,
        activeChunk.fitWriter?.finish() || null
      ]);
      const uploadStartedAt = Date.now();
      await report(progress, 10 + Math.round((processed / Math.max(1, total)) * 70), "uploading-workout-chunk", {
        processed,
        total,
        chunk: activeChunk.index + 1,
        chunks: Math.ceil(total / LOGICAL_WORKOUT_CHUNK_SIZE),
        etaMs: estimateEtaMs(startedAt, processed, total)
      });
      const chunkName = String(activeChunk.index).padStart(5, "0");
      const [nativeArtifact, fitArtifact] = await Promise.all([
        nativeFile
          ? uploadFile(s3, config, `${root}/workouts/native/chunk-${chunkName}.zip`, nativeFile, "application/zip")
          : null,
        fitFile
          ? uploadFile(s3, config, `${root}/workouts/fit/chunk-${chunkName}.zip`, fitFile, "application/zip")
          : null
      ]);
      chunkUploadMs += Date.now() - uploadStartedAt;
      if (nativeArtifact) nativeChunks.push({ ...nativeArtifact, index: activeChunk.index, workoutCount: activeChunk.workoutCount });
      if (fitArtifact) fitChunks.push({ ...fitArtifact, index: activeChunk.index, workoutCount: activeChunk.workoutCount });
      await Promise.all([nativeFile?.filePath, fitFile?.filePath].filter(Boolean).map((filePath) => fs.rm(filePath, { force: true })));
      activeChunk = null;
      peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
      await yieldToEventLoop();
    };

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
        activeChunk ||= startChunk(chunkIndex);
        const owner = ownerByUid.get(String(workout.uid));
        if (!owner) throw new Error(`Workout ${workout.id} has no logical backup owner.`);
        const workoutSegments = segmentsByWorkout.get(String(workout.id)) || [];
        const favoriteOwnerKeys = (favoritesByWorkout.get(String(workout.id)) || [])
          .map((favorite) => ownerByUid.get(String(favorite.uid))?.key)
          .filter(Boolean);
        const metadata = serializeAdminWorkout(workout, owner.key, workoutSegments, favoriteOwnerKeys);
        const base = `workouts/${owner.key}/W-${workout.id}`;
        const startTime = metadata.start_time ? new Date(metadata.start_time).toISOString() : null;
        activeChunk.workoutCount += 1;
        activeChunk.segmentCount += workoutSegments.length;
        activeChunk.favoriteCount += favoriteOwnerKeys.length;
        activeChunk.workoutCounts.set(owner.key, (activeChunk.workoutCounts.get(owner.key) || 0) + 1);
        activeChunk.referencedOwnerKeys.add(owner.key);
        favoriteOwnerKeys.forEach((ownerKey) => activeChunk.referencedOwnerKeys.add(ownerKey));
        previewRows.push([
          ownerIndexByUid.get(owner.sourceUid),
          startTime,
          startTime ? null : createHash("sha256").update(workout.stream).digest("hex"),
          String(workout.id),
          activeChunk.index
        ]);

        if (activeChunk.nativeWriter) {
          await activeChunk.nativeWriter.add(`${base}.json`, strToU8(JSON.stringify(metadata)));
          await activeChunk.nativeWriter.add(`${base}.stream`, workout.stream);
          if (workout.gps_track_blob) await activeChunk.nativeWriter.add(`${base}.gps`, workout.gps_track_blob);
        }
        if (activeChunk.fitWriter) {
          const fit = await buildFit(workout, metadata, workoutSegments, fitProfile);
          await activeChunk.fitWriter.add(`${base}.fit`, fit);
          await activeChunk.fitWriter.add(`${base}.json`, strToU8(JSON.stringify(metadata)));
        }
        processed += 1;
        if (activeChunk.workoutCount >= LOGICAL_WORKOUT_CHUNK_SIZE) {
          await finishChunk();
          chunkIndex += 1;
        }
      }
      cursor = Number(workouts.at(-1).id);
      const percent = 10 + Math.round((processed / Math.max(1, total)) * 70);
      await report(progress, percent, includeFit ? "encoding-workouts-fit" : "encoding-workouts-native", {
        processed,
        total,
        etaMs: estimateEtaMs(startedAt, processed, total)
      });
      peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
      await yieldToEventLoop();
    }
    await finishChunk();
    const createdAt = new Date().toISOString();
    const previewIndex = Buffer.from(JSON.stringify({
      format: ADMIN_WORKOUT_BACKUP_FORMAT,
      version: ADMIN_WORKOUT_BACKUP_VERSION,
      createdAt,
      workoutCount: total,
      owners,
      workouts: previewRows
    }));
    await client.query("COMMIT");
    return {
      workoutCount: total,
      previewIndex,
      nativeCollection: includeNative ? buildLogicalWorkoutChunkCollection(nativeChunks) : null,
      fitCollection: includeFit ? buildLogicalWorkoutChunkCollection(fitChunks) : null,
      profile: { elapsedMs: Date.now() - startedAt, peakRssBytes, chunkUploadMs, fit: fitProfile }
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    activeChunk?.nativeWriter?.abort(error);
    activeChunk?.fitWriter?.abort(error);
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

async function restoreWorkoutChunk(filePath, source, selectedWorkouts, owners) {
  const directory = await unzipper.Open.file(filePath);
  const files = entryMap(directory);
  const manifest = await readJsonEntry(files.get("manifest.json"), "Workout manifest");
  const nativeFormatValid = source === "native"
    && manifest.format === ADMIN_WORKOUT_BACKUP_FORMAT
    && Number(manifest.version) === ADMIN_WORKOUT_BACKUP_VERSION;
  const fitFormatValid = source === "fit"
    && manifest.format === LOGICAL_FIT_FORMAT
    && Number(manifest.version) === LOGICAL_FIT_VERSION;
  if (!nativeFormatValid && !fitFormatValid) {
    throw new Error(`Unsupported logical ${source.toUpperCase()} workout artifact.`);
  }
  const ownerByKey = new Map(owners.map((owner) => [String(owner.key), owner]));
  const metadataEntries = [...files.values()].filter((entry) => /^workouts\/[^/]+\/W-[^/]+\.json$/u.test(entry.path));
  if (metadataEntries.length !== Number(manifest.workoutCount)) {
    throw new Error("Logical workout artifact count does not match its manifest.");
  }
  const aggregate = { imported: 0, importedSegments: 0, importedFavorites: 0 };
  for (let offset = 0; offset < selectedWorkouts.length; offset += WORKOUT_BATCH_SIZE) {
    const selectedBatch = selectedWorkouts.slice(offset, offset + WORKOUT_BATCH_SIZE);
    const batch = [];
    for (const selected of selectedBatch) {
      const metadataPath = `workouts/${selected.ownerKey}/W-${selected.sourceId}.json`;
      const metadataEntry = files.get(metadataPath);
      if (!metadataEntry) throw new Error(`Workout ${selected.sourceId} is missing from its declared chunk.`);
      const restored = source === "fit"
        ? await fitEntryToWorkout({ metadataEntry }, files, ownerByKey)
        : await nativeEntryToWorkout(metadataEntry, files, ownerByKey);
      if (restored.sourceId !== selected.sourceId || restored.owner.key !== selected.ownerKey) {
        throw new Error(`Workout ${selected.sourceId} does not match its chunk index entry.`);
      }
      batch.push(restored);
    }
    const result = await importWorkoutBatch(batch, ownerByKey);
    aggregate.imported += Number(result.imported) || 0;
    aggregate.importedSegments += Number(result.importedSegments) || 0;
    aggregate.importedFavorites += Number(result.importedFavorites) || 0;
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
      const workoutResult = await exportWorkoutFiles({
        mode: selectedMode,
        tempDirectory,
        s3,
        config,
        root,
        progress
      });

      await report(progress, 82, "uploading-s3");
      const uploadStartedAt = Date.now();
      const artifacts = {
        accounts: await uploadBuffer(s3, config, `${root}/accounts.json`, accounts, "application/json"),
        segments: await uploadBuffer(s3, config, `${root}/segments.zip`, segmentResult.archive, "application/zip"),
        workoutIndex: await uploadBuffer(s3, config, `${root}/workout-index.json`, workoutResult.previewIndex, "application/json")
      };
      if (workoutResult.nativeCollection) artifacts.workoutsNative = workoutResult.nativeCollection;
      if (workoutResult.fitCollection) artifacts.workoutsFit = workoutResult.fitCollection;
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
        implementation: {
          workoutArchiveVersion: 3,
          batchSize: WORKOUT_BATCH_SIZE,
          chunkSize: LOGICAL_WORKOUT_CHUNK_SIZE
        }
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
        uploadMs: Date.now() - uploadStartedAt + workoutResult.profile.chunkUploadMs,
        totalMs: Date.now() - startedAt,
        peakRssBytes: workoutResult.profile.peakRssBytes,
        nativeBytes: workoutResult.nativeCollection?.chunks.reduce((sum, chunk) => sum + chunk.sizeBytes, 0) || 0,
        fitBytes: workoutResult.fitCollection?.chunks.reduce((sum, chunk) => sum + chunk.sizeBytes, 0) || 0,
        nativeChunks: workoutResult.nativeCollection?.chunks.length || 0,
        fitChunks: workoutResult.fitCollection?.chunks.length || 0,
        fitProfile: workoutResult.profile.fit
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
        if (manifest.format === LOGICAL_BACKUP_FORMAT
          && Number(manifest.version) === LOGICAL_BACKUP_VERSION
          && manifest.status === "complete") {
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
    if (manifest.format !== LOGICAL_BACKUP_FORMAT
      || Number(manifest.version) !== LOGICAL_BACKUP_VERSION
      || manifest.status !== "complete") {
      throw new Error("Unsupported logical backup manifest.");
    }
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
      const collection = workoutSource === "fit"
        ? loaded.manifest.artifacts.workoutsFit
        : loaded.manifest.artifacts.workoutsNative;
      const chunks = validateLogicalWorkoutChunkCollection(collection, workoutSource);
      const index = JSON.parse((await readArtifactBuffer(
        loaded.s3,
        loaded.config,
        loaded.root,
        loaded.manifest.artifacts.workoutIndex
      )).toString("utf8"));
      validateLogicalWorkoutChunkIndex(index, chunks);
      result.workouts = await AdminWorkoutBackupService.previewMetadata(index);
    }
    return result;
  }

  static async restore(rootValue, options = {}, progress = null) {
    const restoreStartedAt = Date.now();
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
      const collection = selected.workoutSource === "fit"
        ? loaded.manifest.artifacts.workoutsFit
        : loaded.manifest.artifacts.workoutsNative;
      const chunks = validateLogicalWorkoutChunkCollection(collection, selected.workoutSource);
      const index = JSON.parse((await readArtifactBuffer(
        loaded.s3,
        loaded.config,
        loaded.root,
        loaded.manifest.artifacts.workoutIndex
      )).toString("utf8"));
      validateLogicalWorkoutChunkIndex(index, chunks);
      const plan = await planAdminWorkoutMetadataImport(index);
      if (plan.preview.totals.conflicts > 0) {
        throw Object.assign(new Error("Owner mapping contains conflicts. Import was not started."), { statusCode: 409 });
      }
      const workoutsByChunk = new Map();
      for (const workout of plan.importableWorkouts) {
        if (!workout.sourceId || !Number.isInteger(workout.chunkIndex)) {
          throw new Error("Logical workout index has no source or chunk mapping.");
        }
        const rows = workoutsByChunk.get(workout.chunkIndex) || [];
        rows.push(workout);
        workoutsByChunk.set(workout.chunkIndex, rows);
      }
      const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "cwa24-logical-restore-"));
      try {
        const aggregate = {
          imported: 0,
          importedSegments: 0,
          importedFavorites: 0,
          selectedWorkouts: plan.importableWorkouts.length,
          downloadedChunks: 0,
          downloadedBytes: 0
        };
        const startedAt = Date.now();
        let processed = 0;
        for (const [chunkIndex, selectedWorkouts] of [...workoutsByChunk.entries()].sort((a, b) => a[0] - b[0])) {
          const descriptor = chunks.get(chunkIndex);
          if (!descriptor) throw new Error(`Workout chunk ${chunkIndex} is missing from the backup manifest.`);
          await report(progress, 45 + Math.round((processed / Math.max(1, plan.importableWorkouts.length)) * 53), "downloading-workout-chunk", {
            processed,
            total: plan.importableWorkouts.length,
            chunk: aggregate.downloadedChunks + 1,
            chunks: workoutsByChunk.size,
            etaMs: estimateEtaMs(startedAt, processed, plan.importableWorkouts.length)
          });
          const filePath = path.join(tempDirectory, `${selected.workoutSource}-${chunkIndex}.zip`);
          const file = await downloadArtifactToFile(loaded.s3, loaded.config, loaded.root, descriptor, filePath);
          const imported = await restoreWorkoutChunk(
            file.filePath,
            selected.workoutSource,
            selectedWorkouts,
            index.owners
          );
          aggregate.imported += Number(imported.imported) || 0;
          aggregate.importedSegments += Number(imported.importedSegments) || 0;
          aggregate.importedFavorites += Number(imported.importedFavorites) || 0;
          aggregate.downloadedChunks += 1;
          aggregate.downloadedBytes += Number(descriptor.sizeBytes) || 0;
          processed += selectedWorkouts.length;
          await fs.rm(filePath, { force: true });
          await report(progress, 45 + Math.round((processed / Math.max(1, plan.importableWorkouts.length)) * 53), `restoring-workouts-${selected.workoutSource}`, {
            processed,
            total: plan.importableWorkouts.length,
            chunk: aggregate.downloadedChunks,
            chunks: workoutsByChunk.size,
            etaMs: estimateEtaMs(startedAt, processed, plan.importableWorkouts.length)
          });
        }
        result.workouts = aggregate;
        console.info("[logical-backup] restore.profile", {
          source: selected.workoutSource,
          selectedWorkouts: aggregate.selectedWorkouts,
          importedWorkouts: aggregate.imported,
          downloadedChunks: aggregate.downloadedChunks,
          downloadedBytes: aggregate.downloadedBytes,
          totalMs: Date.now() - restoreStartedAt
        });
      } finally {
        await fs.rm(tempDirectory, { recursive: true, force: true });
      }
    }
    await report(progress, 100, "completed", { etaMs: 0 });
    return result;
  }
}
