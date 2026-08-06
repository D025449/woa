import { createHash, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";

import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { strToU8, unzipSync, zipSync } from "fflate";

import { normalizeS3Prefix, sanitizeKeyPart } from "../../ops/postgres-backup/backup-common.mjs";
import { applyCompactEncodingOptions, parseFitBufferCompactBrowser } from "../public/js/fit-import-compact-browser.js";
import { createWoa1FileFromCompactAsync } from "../public/js/woa-format-compact.js";
import FitExportService from "../shared/FitExportService.js";
import GpsTrackBlobCodec from "../shared/GpsTrackBlobCodec.js";
import Workout from "../shared/Workout.js";
import { toPostgresBox } from "../shared/postgresSpatial.js";
import AdminSegmentBackupService from "./adminSegmentBackupService.js";
import AdminWorkoutBackupService, {
  buildAdminWorkoutBackup,
  decodeAdminWorkoutBackup
} from "./adminWorkoutBackupService.js";
import UserAccountBackupService from "./userAccountBackupService.js";
import { decodeWoa1BufferLight } from "./woa1Service.js";
import { enqueueSegmentBestEfforts } from "./segment-best-efforts-service.js";
import { FileDBService } from "./fileDBService.js";

export const LOGICAL_BACKUP_FORMAT = "cwa24-logical-backup-manifest";
export const LOGICAL_BACKUP_VERSION = 1;
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

async function bodyBuffer(body) {
  if (!body) throw new Error("S3 object has no body.");
  if (typeof body.transformToByteArray === "function") return Buffer.from(await body.transformToByteArray());
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
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

function artifact(key, bytes, contentType) {
  return { key, bytes: Buffer.from(bytes), contentType, sizeBytes: bytes.byteLength, sha256: sha256(bytes) };
}

async function workoutFromStored(entry) {
  const codec = String(entry.metadata.stream_codec || "gzip").toLowerCase();
  const raw = codec === "identity" ? entry.stream : await Workout.decompress(entry.stream, codec);
  return Workout.fromBuffer(raw);
}

async function buildFitArchive(nativeArchive) {
  const decoded = await decodeAdminWorkoutBackup(nativeArchive);
  const entries = {};
  const index = [];
  for (const entry of decoded.workouts) {
    const workout = await workoutFromStored(entry);
    const gps = entry.gpsTrackBlob
      ? await GpsTrackBlobCodec.decodeCompressed(entry.gpsTrackBlob, {
        codec: entry.metadata.gps_track_blob_codec || "identity",
        includeGeoJson: false
      })
      : null;
    const fit = FitExportService.buildFitFromWorkout(workout, {
      gpsCoordinates: gps?.track?.map((point) => [point.lat, point.lng]) || [],
      sampleRateGps: Number(entry.metadata.samplerategps || gps?.sampleRateGps || 1),
      includeGps: Boolean(entry.metadata.validgps && gps?.validGps),
      gpsSource: entry.metadata.gps_source,
      fitDeviceMetadata: entry.metadata.fit_device_metadata,
      normalizedPower: entry.metadata.avg_normalized_power,
      totalCalories: entry.metadata.total_calories,
      workoutType: entry.metadata.workout_type,
      segments: entry.segments
    });
    const path = `workouts/${entry.ownerKey}/W-${entry.sourceId}.fit`;
    entries[path] = new Uint8Array(fit);
    index.push({
      path,
      ownerKey: entry.ownerKey,
      sourceId: entry.sourceId,
      sourceMetadata: entry.metadata,
      segments: entry.segments,
      favoriteOwnerKeys: entry.favoriteOwnerKeys
    });
  }
  entries["manifest.json"] = strToU8(JSON.stringify({
    format: "cwa24-logical-fit-workouts",
    version: 1,
    owners: decoded.owners,
    workoutCount: index.length,
    workouts: index
  }));
  return Buffer.from(zipSync(entries, { level: 0 }));
}

async function nativeArchiveFromFit(fitArchive) {
  const files = unzipSync(new Uint8Array(fitArchive));
  const manifest = JSON.parse(Buffer.from(files["manifest.json"] || []).toString("utf8"));
  if (manifest?.format !== "cwa24-logical-fit-workouts" || Number(manifest?.version) !== 1) {
    throw new Error("Unsupported logical FIT workout artifact.");
  }
  const workouts = [];
  const segments = [];
  const favorites = [];
  const ownerByKey = new Map((manifest.owners || []).map((owner) => [owner.key, owner]));
  for (const source of manifest.workouts || []) {
    const fitBytes = files[source.path];
    const owner = ownerByKey.get(source.ownerKey);
    if (!fitBytes || !owner) throw new Error(`Incomplete FIT workout artifact: ${source.path}`);
    const parsed = applyCompactEncodingOptions(parseFitBufferCompactBrowser(fitBytes), {});
    const result = await createWoa1FileFromCompactAsync(parsed, {
      sourceName: source.path,
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
    const metadata = {
      ...source.sourceMetadata,
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
    const syntheticId = source.sourceId;
    workouts.push({
      ...metadata,
      id: syntheticId,
      uid: owner.sourceUid,
      owner_auth_sub: owner.authSub,
      owner_email: owner.email,
      stream: Buffer.from(decoded.workoutStreamStoredBytes),
      gps_track_blob: decoded.gpsTrackStoredBytes.byteLength ? Buffer.from(decoded.gpsTrackStoredBytes) : null
    });
    for (const segment of source.segments || []) segments.push({ ...segment, wid: syntheticId });
    for (const favoriteOwnerKey of source.favoriteOwnerKeys || []) {
      const favoriteOwner = ownerByKey.get(favoriteOwnerKey);
      if (favoriteOwner) favorites.push({
        workout_id: syntheticId,
        uid: favoriteOwner.sourceUid,
        owner_auth_sub: favoriteOwner.authSub,
        owner_email: favoriteOwner.email
      });
    }
  }
  return buildAdminWorkoutBackup({ workouts, segments, favorites });
}

async function readArtifact(s3, config, root, descriptor) {
  if (!descriptor?.key || !descriptor.key.startsWith(`${root}/`)) throw new Error("Logical backup artifact key is invalid.");
  const response = await s3.send(new GetObjectCommand({ Bucket: config.bucket, Key: descriptor.key }));
  const bytes = await bodyBuffer(response.Body);
  if (bytes.byteLength !== Number(descriptor.sizeBytes) || sha256(bytes) !== descriptor.sha256) {
    throw new Error(`Logical backup artifact failed integrity validation: ${descriptor.key}`);
  }
  return bytes;
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
    await progress?.(10, "exporting-accounts");
    const accounts = Buffer.from(`${JSON.stringify(await UserAccountBackupService.exportAll())}\n`);
    await progress?.(25, "exporting-segments");
    const segmentResult = await AdminSegmentBackupService.exportAll();
    await progress?.(40, "exporting-workouts");
    const workoutResult = await AdminWorkoutBackupService.exportAll();
    const artifacts = {
      accounts: artifact(`${root}/accounts.json`, accounts, "application/json"),
      segments: artifact(`${root}/segments.zip`, segmentResult.archive, "application/zip")
    };
    if (selectedMode === "native" || selectedMode === "both") {
      artifacts.workoutsNative = artifact(`${root}/workouts-native.zip`, workoutResult.archive, "application/zip");
    }
    if (selectedMode === "fit" || selectedMode === "both") {
      await progress?.(55, "encoding-fit");
      artifacts.workoutsFit = artifact(`${root}/workouts-fit.zip`, await buildFitArchive(workoutResult.archive), "application/zip");
    }
    await progress?.(75, "uploading-s3");
    for (const value of Object.values(artifacts)) {
      await s3.send(new PutObjectCommand({ Bucket: config.bucket, Key: value.key, Body: value.bytes, ContentType: value.contentType }));
      delete value.bytes;
      delete value.contentType;
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
        users: Number(JSON.parse(accounts.toString("utf8")).users?.length || 0),
        segments: segmentResult.segmentCount,
        workouts: workoutResult.workoutCount
      },
      artifacts
    };
    await s3.send(new PutObjectCommand({
      Bucket: config.bucket,
      Key: `${root}/manifest.json`,
      Body: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
      ContentType: "application/json"
    }));
    await progress?.(100, "completed");
    return { ...manifest, rootKey: root };
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
      .sort((a, b) => new Date(b.LastModified || 0) - new Date(a.LastModified || 0)).slice(0, limit);
    const backups = [];
    for (const item of keys) {
      try {
        const body = await bodyBuffer((await s3.send(new GetObjectCommand({ Bucket: config.bucket, Key: item.Key }))).Body);
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
    const body = await bodyBuffer((await s3.send(new GetObjectCommand({ Bucket: config.bucket, Key: `${root}/manifest.json` }))).Body);
    const manifest = JSON.parse(body.toString("utf8"));
    if (manifest.format !== LOGICAL_BACKUP_FORMAT || manifest.status !== "complete") throw new Error("Invalid logical backup manifest.");
    return { config, root, s3, manifest };
  }

  static async preview(rootValue, { accounts = true, segments = true, workouts = true, workoutSource = "native" } = {}) {
    const loaded = await this.loadManifest(rootValue);
    const result = { manifest: loaded.manifest, selections: { accounts, segments, workouts, workoutSource } };
    if (segments) result.segments = await AdminSegmentBackupService.preview(await readArtifact(loaded.s3, loaded.config, loaded.root, loaded.manifest.artifacts.segments));
    if (workouts) {
      const descriptor = workoutSource === "fit" ? loaded.manifest.artifacts.workoutsFit : loaded.manifest.artifacts.workoutsNative;
      if (!descriptor) throw Object.assign(new Error(`Backup has no ${workoutSource.toUpperCase()} workout artifact.`), { statusCode: 400 });
      let archive = await readArtifact(loaded.s3, loaded.config, loaded.root, descriptor);
      if (workoutSource === "fit") archive = await nativeArchiveFromFit(archive);
      result.workouts = await AdminWorkoutBackupService.preview(archive);
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
      await progress?.(10, "restoring-accounts");
      const bytes = await readArtifact(loaded.s3, loaded.config, loaded.root, loaded.manifest.artifacts.accounts);
      result.accounts = await UserAccountBackupService.importAll(JSON.parse(bytes.toString("utf8")));
    }
    if (selected.segments) {
      await progress?.(35, "restoring-segments");
      result.segments = await AdminSegmentBackupService.importAll(await readArtifact(loaded.s3, loaded.config, loaded.root, loaded.manifest.artifacts.segments));
      const queueResults = await Promise.allSettled(
        result.segments.queueTargets
          .filter((target) => target.segmentIds.length > 0)
          .map((target) => enqueueSegmentBestEfforts(target))
      );
      result.segments.queueFailures = queueResults.filter((entry) => entry.status === "rejected").length;
    }
    if (selected.workouts) {
      await progress?.(60, selected.workoutSource === "fit" ? "reparsing-fit" : "restoring-native-workouts");
      const descriptor = selected.workoutSource === "fit" ? loaded.manifest.artifacts.workoutsFit : loaded.manifest.artifacts.workoutsNative;
      if (!descriptor) throw Object.assign(new Error(`Backup has no ${selected.workoutSource.toUpperCase()} workout artifact.`), { statusCode: 400 });
      let archive = await readArtifact(loaded.s3, loaded.config, loaded.root, descriptor);
      if (selected.workoutSource === "fit") archive = await nativeArchiveFromFit(archive);
      result.workouts = await AdminWorkoutBackupService.importAll(archive);
    }
    await progress?.(100, "completed");
    return result;
  }
}
