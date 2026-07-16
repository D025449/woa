import fs from "node:fs/promises";
import path from "node:path";
import util from "node:util";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { Router } from "express";
import unzipper from "unzipper";

import authMiddleware from "../middleware/authMiddleware.js";
import requireActiveAccountWrite from "../middleware/requireActiveAccountWrite.js";
import uploadMiddleware from "../middleware/uploadMiddleware.js";
import { appendImportJobPostprocessTargets, createImportJob, updateImportJob } from "../db/import-jobs-repo.js";
import { FileDBService } from "../services/fileDBService.js";
import pool from "../services/database.js";
import { decodeWoa1Buffer, decodeWoa1BufferLight, inspectWoa1Header } from "../services/woa1Service.js";
import { decodeWoaTransportContainer } from "../public/js/woa-transport-container.js";
import { decodeWorkoutLocalPostprocessTransport } from "../shared/WorkoutLocalPostprocess.js";
import { decodeBrowserGpsBestEffortsTransport } from "../shared/BrowserGpsBestEffortsTransport.js";
import {
  persistWorkoutLocalPostprocess,
  WorkoutLocalPostprocessValidationError
} from "../services/workoutLocalPostprocessImportService.js";
import {
  BrowserGpsBestEffortsValidationError,
  persistBrowserGpsBestEfforts
} from "../services/browserGpsBestEffortsImportService.js";
import {
  enqueueWorkoutSegmentBestEffortsBulk,
  enqueueWorkoutSegmentPersistenceBulk
} from "../services/segment-best-efforts-service.js";
import {
  checkpointWoaBundleUpload,
  claimWoaBundleUpload,
  completeWoaBundleUpload,
  createWoaBundleUpload,
  failWoaBundleUpload,
  getWoaBundleUpload
} from "../db/woa-bundle-uploads-repo.js";
import { enqueueWoaBundleRecovery } from "../services/woaBundleRecoveryJobService.js";

const router = Router();
const IMPORT_SYNC_PROFILE_LOG = String(process.env.IMPORT_SYNC_PROFILE_LOG || "1").trim() !== "0";
const IMPORT_DB_BULK_INSERT_SIZE = Math.max(1, Number(process.env.IMPORT_DB_BULK_INSERT_SIZE) || 200);
const IMPORT_POSTPROCESS_ENQUEUE_BULK_SIZE = 500;
const BROWSER_POSTPROCESS_MAX_COMPRESSED_BYTES = 5 * 1024 * 1024;
const BROWSER_POSTPROCESS_MAX_RAW_BYTES = 20 * 1024 * 1024;
const BROWSER_POSTPROCESS_DB_BATCH_WORKOUTS = Math.max(
  1,
  Number(process.env.BROWSER_POSTPROCESS_DB_BATCH_WORKOUTS) || 100
);
const WOA_BUNDLE_RECOVERY_ENABLED = String(process.env.WOA_BUNDLE_RECOVERY_ENABLED || "0").trim() === "1";

class WoaBundleHttpError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = "WoaBundleHttpError";
    this.statusCode = statusCode;
  }
}

function normalizeBundleUploadId(value) {
  const uploadId = String(value || "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{7,127}$/.test(uploadId)) {
    throw new WoaBundleHttpError("Invalid WOA bundle uploadId", 400);
  }
  return uploadId;
}

function resolveUploadContainerCompression(req) {
  const explicit = String(
    req.headers["x-upload-compression"]
      || req.headers["content-encoding"]
      || ""
  ).trim().toLowerCase();
  if (explicit === "br" || explicit === "brotli") return "brotli";
  if (explicit === "gzip" || explicit === "x-gzip") return "gzip";

  const fileName = String(req.headers["x-upload-filename"] || "").trim().toLowerCase();
  if (fileName.endsWith(".br")) return "brotli";
  return "gzip";
}

function decompressUploadContainer(bytes, compression) {
  return compression === "brotli"
    ? brotliDecompressSync(bytes)
    : gunzipSync(bytes);
}

function decodeWoaBundleArtifacts({ compressedWorkouts, compressedPostprocess, compressedGpsBestEfforts, workoutsCodec }) {
  if (compressedPostprocess.length > BROWSER_POSTPROCESS_MAX_COMPRESSED_BYTES
    || compressedGpsBestEfforts.length > BROWSER_POSTPROCESS_MAX_COMPRESSED_BYTES) {
    throw new WoaBundleHttpError("Browser-Postprocessing-Container ist zu groß", 413);
  }

  const inflatedWorkouts = decompressUploadContainer(compressedWorkouts, workoutsCodec);
  const decodedContainer = decodeWoaTransportContainer(inflatedWorkouts);
  const woaEntries = decodedContainer.entries.filter((entry) =>
    String(entry?.name || "").toLowerCase().endsWith(".woa1")
  );
  if (woaEntries.length === 0) {
    throw new WoaBundleHttpError("Container enthält keine .woa1 Dateien", 400);
  }

  try {
    const rawPostprocess = gunzipSync(compressedPostprocess, { maxOutputLength: BROWSER_POSTPROCESS_MAX_RAW_BYTES });
    const rawGpsBestEfforts = gunzipSync(compressedGpsBestEfforts, { maxOutputLength: BROWSER_POSTPROCESS_MAX_RAW_BYTES });
    return {
      woaEntries,
      decodedPostprocess: {
        rawBytes: rawPostprocess.byteLength,
        value: decodeWorkoutLocalPostprocessTransport(rawPostprocess)
      },
      decodedGpsBestEfforts: {
        rawBytes: rawGpsBestEfforts.byteLength,
        value: decodeBrowserGpsBestEffortsTransport(rawGpsBestEfforts)
      }
    };
  } catch (error) {
    throw new WoaBundleHttpError(
      error?.code === "ERR_BUFFER_TOO_LARGE"
        ? "Entpackter Browser-Postprocessing-Container ist zu groß"
        : "Ungültiger WPP1- oder GBE1-Container",
      error?.code === "ERR_BUFFER_TOO_LARGE" ? 413 : 400
    );
  }
}

function formatLogPayload(payload = {}) {
  return util.inspect(payload, {
    depth: null,
    colors: false,
    compact: false,
    breakLength: 120
  });
}

function logImportEvent(type, payload = {}) {
  console.log(`[import] ${type} ${formatLogPayload(payload)}`);
}

function createImportProfile() {
  return {
    openZipMs: 0,
    filterEntriesMs: 0,
    readEntryMs: 0,
    decodeWoaMs: 0,
    prepareInsertMs: 0,
    prepareInsertPrepareWorkoutBufferMs: 0,
    prepareInsertWorkoutRawBytes: 0,
    prepareInsertCompressWorkoutBufferMs: 0,
    prepareInsertWorkoutCompressedBytes: 0,
    prepareInsertToCompressedBufferMs: 0,
    prepareInsertBuildGeometryWktMs: 0,
    prepareInsertEncodeGpsTrackBlobMs: 0,
    prepareInsertGpsTrackBlobCompressedBytes: 0,
    deleteExistingRowsMs: 0,
    insertWorkoutMs: 0,
    insertWorkoutBatchCount: 0,
    insertWorkoutRowsMs: 0,
    insertWorkoutLoadExistingRowsMs: 0,
    schedulePostprocessMs: 0,
    scheduleAppendTargetsMs: 0,
    scheduleSegmentPersistenceMs: 0,
    scheduleSimilarityMs: 0,
    scheduleSegmentBestEffortsMs: 0
  };
}

async function importWoaEntryReaders({
  userId,
  sourceName,
  uploadedSizeBytes,
  entryReaders,
  overwriteExisting = false,
  browserLocalPostprocess = false,
  browserGpsSegmentBestEfforts = false,
  transactionalOverwrite = false
}) {
  const inserted = [];
  const skipped = [];
  const postprocessErrors = [];
  const startedAt = Date.now();
  const pendingItems = [];
  const importJob = await createImportJob({
    localPaths: null,
    originalFileNames: [sourceName],
    sizeBytes: Number(uploadedSizeBytes || 0),
    uid: userId
  });
  const importJobId = String(importJob.id);
  const profile = createImportProfile();
  const allPostprocessTargets = [];
  const allSegmentPersistItems = [];
  const allSegmentBestEffortsItems = [];

  const enqueueInLargeBulks = async (items, bulkSize, enqueueFn) => {
    for (let index = 0; index < items.length; index += bulkSize) {
      const chunk = items.slice(index, index + bulkSize);
      await enqueueFn(chunk);
    }
  };

  await updateImportJob(importJobId, {
    status: "processing",
    stage: "saving_results",
    totalFiles: entryReaders.length,
    processedFiles: 0,
    failedFiles: 0,
    fileStatuses: []
  });

  logImportEvent("woa-sync-import.started", {
    importJobId,
    uid: userId,
    sourceName,
    totalEntries: entryReaders.length
  });

  for (const entry of entryReaders) {
    try {
      const readEntryStartedAt = Date.now();
      const entryBuffer = await entry.buffer();
      profile.readEntryMs += Date.now() - readEntryStartedAt;

      const decodeStartedAt = Date.now();
      const header = inspectWoa1Header(entryBuffer);
      const decoded = header.majorVersion >= 2
        ? decodeWoa1BufferLight(entryBuffer)
        : await decodeWoa1Buffer(entryBuffer);
      profile.decodeWoaMs += Date.now() - decodeStartedAt;

      const prepareStartedAt = Date.now();
      const preparedInsert = decoded.majorVersion >= 2
        ? FileDBService.preparePersistedWoaInsertPayload(decoded.meta, {
            uid: userId,
            workoutStreamStoredBytes: decoded.workoutStreamStoredBytes,
            gpsTrackStoredBytes: decoded.gpsTrackStoredBytes
          })
        : await FileDBService.prepareInsertFilePayload(
            {
              ...decoded.fileRow,
              uid: userId,
              gps_source: decoded.meta?.gpsSource === "manual_lookup" ? "manual_lookup" : null
            },
            decoded.gpsTrack,
            decoded.workoutObject
          );
      profile.prepareInsertMs += Date.now() - prepareStartedAt;

      for (const step of Array.isArray(preparedInsert?.timingSteps) ? preparedInsert.timingSteps : []) {
        if (step?.label === "prepare-workout-buffer") {
          profile.prepareInsertPrepareWorkoutBufferMs += Number(step.stepMs || 0);
          profile.prepareInsertWorkoutRawBytes += Number(step.rawBytes || 0);
        }
        if (step?.label === "compress-workout-buffer") {
          profile.prepareInsertCompressWorkoutBufferMs += Number(step.stepMs || 0);
          profile.prepareInsertWorkoutCompressedBytes += Number(step.compressedBytes || 0);
        }
        if (step?.label === "to-compressed-buffer") {
          profile.prepareInsertToCompressedBufferMs += Number(step.stepMs || 0);
        }
        if (step?.label === "build-geometry-wkt") {
          profile.prepareInsertBuildGeometryWktMs += Number(step.stepMs || 0);
        }
        if (step?.label === "encode-gps-track-blob") {
          profile.prepareInsertEncodeGpsTrackBlobMs += Number(step.stepMs || 0);
          profile.prepareInsertGpsTrackBlobCompressedBytes += Number(step.compressedBytes || 0);
        }
      }

      pendingItems.push({
        entryName: entry.path,
        preparedInsert,
        validGps: !!(
          preparedInsert?.gps_track?.validGps
          ?? preparedInsert?.fileRow?.validGps
          ?? decoded?.gpsTrack?.validGps
          ?? decoded?.meta?.persistedRow?.validGps
        )
      });
    } catch (error) {
      skipped.push({
        entryName: entry.path,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  for (let start = 0; start < pendingItems.length; start += IMPORT_DB_BULK_INSERT_SIZE) {
    const chunk = pendingItems.slice(start, start + IMPORT_DB_BULK_INSERT_SIZE);
    profile.insertWorkoutBatchCount += 1;
    try {
      const insertStartedAt = Date.now();
      const bulkResult = await FileDBService.insertPreparedFilesBulk(
        chunk.map((item) => item.preparedInsert),
        { overwriteExisting, transactionalOverwrite }
      );
      profile.insertWorkoutMs += Date.now() - insertStartedAt;
      for (const step of Array.isArray(bulkResult?.timingSteps) ? bulkResult.timingSteps : []) {
        if (step?.label === "delete-existing-workout-rows") {
          profile.deleteExistingRowsMs += Number(step.stepMs || 0);
        }
        if (step?.label === "insert-workout-rows") {
          profile.insertWorkoutRowsMs += Number(step.stepMs || 0);
        }
        if (step?.label === "load-existing-rows") {
          profile.insertWorkoutLoadExistingRowsMs += Number(step.stepMs || 0);
        }
      }

      const existingByKey = bulkResult?.existingRowsByKey instanceof Map
        ? bulkResult.existingRowsByKey
        : new Map();

      const resolvedChunkItems = [];

      for (const item of chunk) {
        const key = `${item.preparedInsert.fileRow.uid}:${new Date(item.preparedInsert.fileRow.start_time).toISOString()}`;
        const dbrow = existingByKey.get(key);
        if (!dbrow?.id) {
          skipped.push({
            entryName: item.entryName,
            error: "Workout could not be resolved after bulk insert"
          });
          continue;
        }
        inserted.push({
          entryName: item.entryName,
          workoutId: dbrow.id
        });
        resolvedChunkItems.push({
          ...item,
          workoutId: Number(dbrow.id)
        });
      }

      const segmentPersistItems = browserLocalPostprocess ? [] : resolvedChunkItems.map((item) => ({
        uid: item.preparedInsert.fileRow.uid,
        workoutId: item.workoutId,
        entryName: item.entryName,
        recomputeFromDb: true,
        importJobId
      }));
      const validGpsItems = resolvedChunkItems
        .filter((item) => item.validGps)
        .map((item) => ({
          uid: item.preparedInsert.fileRow.uid,
          workoutId: item.workoutId,
          importJobId
        }));
      const chunkTargets = resolvedChunkItems.map((item) => ({
        uid: item.preparedInsert.fileRow.uid,
        workoutId: item.workoutId,
        entryName: item.entryName,
        validGps: !!item.validGps,
        recomputeSegmentsFromDb: !browserLocalPostprocess,
        hasSegments: false,
        segmentPayloadPath: null,
        skipSegmentBestEfforts: browserGpsSegmentBestEfforts,
        skipSimilarity: true
      }));
      allPostprocessTargets.push(...chunkTargets);
      allSegmentPersistItems.push(...segmentPersistItems);
      if (!browserGpsSegmentBestEfforts) {
        allSegmentBestEffortsItems.push(...validGpsItems);
      }
    } catch (error) {
      for (const item of chunk) {
        skipped.push({
          entryName: item.entryName,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  if (browserLocalPostprocess && inserted.length > 0) {
    await pool.query(`
      UPDATE workouts
      SET
        segment_processing_status = 'processing',
        segment_processing_error = NULL,
        segment_processing_updated_at = NOW()
      WHERE uid = $1
        AND id = ANY($2::bigint[])
    `, [userId, inserted.map((item) => item.workoutId)]);
  }

  const scheduleStartedAt = Date.now();
  const appendTargetsStartedAt = Date.now();
  await appendImportJobPostprocessTargets(importJobId, allPostprocessTargets);
  profile.scheduleAppendTargetsMs += Date.now() - appendTargetsStartedAt;

  const persistStartedAt = Date.now();
  try {
    await enqueueInLargeBulks(
      allSegmentPersistItems,
      IMPORT_POSTPROCESS_ENQUEUE_BULK_SIZE,
      enqueueWorkoutSegmentPersistenceBulk
    );
  } catch (error) {
    postprocessErrors.push({
      phase: "segment-persist",
      affectedCount: allSegmentPersistItems.length,
      error: error instanceof Error ? error.message : String(error)
    });
  } finally {
    profile.scheduleSegmentPersistenceMs += Date.now() - persistStartedAt;
  }

  const segmentBestEffortsStartedAt = Date.now();
  try {
    await enqueueInLargeBulks(
      allSegmentBestEffortsItems,
      IMPORT_POSTPROCESS_ENQUEUE_BULK_SIZE,
      enqueueWorkoutSegmentBestEffortsBulk
    );
  } catch (error) {
    postprocessErrors.push({
      phase: "segment-best-efforts",
      affectedCount: allSegmentBestEffortsItems.length,
      error: error instanceof Error ? error.message : String(error)
    });
  } finally {
    profile.scheduleSegmentBestEffortsMs += Date.now() - segmentBestEffortsStartedAt;
  }
  profile.schedulePostprocessMs += Date.now() - scheduleStartedAt;
  const elapsedMs = Date.now() - startedAt;
  await updateImportJob(importJobId, {
    status: "completed",
    stage: "completed",
    processedFiles: inserted.length,
    failedFiles: skipped.length
  });

  if (IMPORT_SYNC_PROFILE_LOG) {
    logImportEvent("woa-sync-import.profile", {
      importJobId,
      sourceName,
      totalEntries: entryReaders.length,
      importedEntries: inserted.length,
      skippedEntries: skipped.length,
      browserLocalPostprocess,
      browserGpsSegmentBestEfforts,
      postprocessErrors,
      syncTotalMs: elapsedMs,
      avgPerImportedEntryMs: inserted.length > 0
        ? Number((elapsedMs / inserted.length).toFixed(3))
        : 0,
      breakdownMs: {
        openZipMs: profile.openZipMs,
        filterEntriesMs: profile.filterEntriesMs,
        readEntryMs: profile.readEntryMs,
        decodeWoaMs: profile.decodeWoaMs,
        prepareInsertMs: profile.prepareInsertMs,
        prepareInsertStepsMs: {
          prepareWorkoutBufferMs: profile.prepareInsertPrepareWorkoutBufferMs,
          compressWorkoutBufferMs: profile.prepareInsertCompressWorkoutBufferMs,
          toCompressedBufferMs: profile.prepareInsertToCompressedBufferMs,
          buildGeometryWktMs: profile.prepareInsertBuildGeometryWktMs,
          encodeGpsTrackBlobMs: profile.prepareInsertEncodeGpsTrackBlobMs
        },
        prepareInsertBytes: {
          workoutRawBytes: profile.prepareInsertWorkoutRawBytes,
          workoutCompressedBytes: profile.prepareInsertWorkoutCompressedBytes,
          gpsTrackBlobCompressedBytes: profile.prepareInsertGpsTrackBlobCompressedBytes
        },
        insertWorkoutMs: profile.insertWorkoutMs,
        insertWorkoutBatches: {
          configuredBatchSize: IMPORT_DB_BULK_INSERT_SIZE,
          batchCount: profile.insertWorkoutBatchCount
        },
        insertWorkoutStepsMs: {
          deleteExistingRowsMs: profile.deleteExistingRowsMs,
          insertWorkoutRowsMs: profile.insertWorkoutRowsMs,
          loadExistingRowsMs: profile.insertWorkoutLoadExistingRowsMs
        },
        schedulePostprocessMs: profile.schedulePostprocessMs,
        schedulePostprocessStepsMs: {
          appendImportJobTargetsMs: profile.scheduleAppendTargetsMs,
          enqueueSegmentPersistenceMs: profile.scheduleSegmentPersistenceMs,
          enqueueSimilarityMs: profile.scheduleSimilarityMs,
          enqueueSegmentBestEffortsMs: profile.scheduleSegmentBestEffortsMs,
          residualMs: Math.max(
            0,
            profile.schedulePostprocessMs
              - profile.scheduleAppendTargetsMs
              - profile.scheduleSegmentPersistenceMs
              - profile.scheduleSimilarityMs
              - profile.scheduleSegmentBestEffortsMs
          )
        }
      }
    });
  }

  logImportEvent("woa-sync-import.completed", {
    importJobId,
    sourceName,
    totalEntries: entryReaders.length,
    importedEntries: inserted.length,
    skippedEntries: skipped.length,
    browserLocalPostprocess,
    browserGpsSegmentBestEfforts,
    postprocessErrors,
    elapsedMs
  });

  return {
    importJobId,
    importedCount: inserted.length,
    skippedCount: skipped.length,
    postprocessErrorCount: postprocessErrors.length,
    totalEntries: entryReaders.length,
    elapsedMs,
    browserLocalPostprocess,
    browserGpsSegmentBestEfforts,
    inserted,
    skipped,
    postprocessErrors
  };
}

const WOA_BUNDLE_PHASE_RANK = new Map([
  ["received", 0],
  ["workouts_completed", 1],
  ["wpp_completed", 2],
  ["gbe_completed", 3],
  ["completed", 4]
]);

async function processDecodedWoaBundle({ bundle, artifacts, safeMode }) {
  let phase = bundle.phase || "received";
  let checkpointMs = 0;
  let importResult = bundle.importResult || null;
  let postprocessResult = bundle.workoutPostprocessResult || null;
  let gpsBestEffortsResult = bundle.gpsBestEffortsResult || null;

  if ((WOA_BUNDLE_PHASE_RANK.get(phase) ?? 0) < 1) {
    const importStartedAt = performance.now();
    importResult = await importWoaEntryReaders({
      userId: bundle.uid,
      sourceName: bundle.workoutsOriginalName,
      uploadedSizeBytes: bundle.workoutsBytes,
      overwriteExisting: bundle.overwriteExisting,
      browserLocalPostprocess: true,
      browserGpsSegmentBestEfforts: true,
      transactionalOverwrite: safeMode,
      entryReaders: artifacts.woaEntries.map((entry) => ({
        path: entry.name,
        buffer: async () => entry.bytes
      }))
    });
    importResult.bundlePhaseMs = performance.now() - importStartedAt;
    if (safeMode && Number(importResult.skippedCount || 0) > 0) {
      throw new Error(`WOA bundle workout phase skipped ${importResult.skippedCount} entries`);
    }
    if (safeMode) {
      const checkpointStartedAt = performance.now();
      await checkpointWoaBundleUpload(bundle.uid, bundle.uploadId, "workouts_completed", "importResult", importResult);
      checkpointMs += performance.now() - checkpointStartedAt;
    }
    phase = "workouts_completed";
  }

  if ((WOA_BUNDLE_PHASE_RANK.get(phase) ?? 0) < 2) {
    const postprocessStartedAt = performance.now();
    const persistedPostprocess = await persistWorkoutLocalPostprocess({
      uid: bundle.uid,
      decoded: artifacts.decodedPostprocess.value,
      pool,
      batchWorkoutCount: BROWSER_POSTPROCESS_DB_BATCH_WORKOUTS
    });
    postprocessResult = {
      format: "WPP1",
      compressedBytes: bundle.workoutPostprocessBytes,
      rawBytes: artifacts.decodedPostprocess.rawBytes,
      totalMs: performance.now() - postprocessStartedAt,
      ...persistedPostprocess
    };
    console.log(`[postprocess] browser-local-import.profile ${formatLogPayload({ uid: bundle.uid, ...postprocessResult })}`);
    if (safeMode) {
      const checkpointStartedAt = performance.now();
      await checkpointWoaBundleUpload(bundle.uid, bundle.uploadId, "wpp_completed", "workoutPostprocessResult", postprocessResult);
      checkpointMs += performance.now() - checkpointStartedAt;
    }
    phase = "wpp_completed";
  }

  if ((WOA_BUNDLE_PHASE_RANK.get(phase) ?? 0) < 3) {
    const gpsBestEffortsStartedAt = performance.now();
    const persistedGpsBestEfforts = await persistBrowserGpsBestEfforts({
      uid: bundle.uid,
      decoded: artifacts.decodedGpsBestEfforts.value,
      pool
    });
    gpsBestEffortsResult = {
      format: "GBE1",
      compressedBytes: bundle.gpsBestEffortsBytes,
      rawBytes: artifacts.decodedGpsBestEfforts.rawBytes,
      totalMs: performance.now() - gpsBestEffortsStartedAt,
      ...persistedGpsBestEfforts
    };
    console.log(`[postprocess] browser-gps-best-efforts.profile ${formatLogPayload({ uid: bundle.uid, ...gpsBestEffortsResult })}`);
    if (safeMode) {
      const checkpointStartedAt = performance.now();
      await checkpointWoaBundleUpload(bundle.uid, bundle.uploadId, "gbe_completed", "gpsBestEffortsResult", gpsBestEffortsResult);
      checkpointMs += performance.now() - checkpointStartedAt;
    }
  }

  if (safeMode) {
    const checkpointStartedAt = performance.now();
    await completeWoaBundleUpload(bundle.uid, bundle.uploadId);
    checkpointMs += performance.now() - checkpointStartedAt;
  }

  return { importResult, postprocessResult, gpsBestEffortsResult, checkpointMs };
}

async function removeWoaBundleFiles(bundle) {
  await Promise.all([
    bundle.workoutsPath,
    bundle.workoutPostprocessPath,
    bundle.gpsBestEffortsPath
  ].filter(Boolean).map((filePath) => fs.rm(filePath, { force: true }).catch(() => {})));
}

export async function recoverWoaBundleUpload({ uid, uploadId }) {
  if (!WOA_BUNDLE_RECOVERY_ENABLED) throw new Error("WOA bundle recovery is disabled");
  const claimed = await claimWoaBundleUpload(uid, uploadId);
  if (!claimed) {
    const existing = await getWoaBundleUpload(uid, uploadId);
    if (existing?.status === "completed") return existing;
    throw new Error(`WOA bundle ${uploadId} is already being processed or does not exist`);
  }

  const startedAt = performance.now();
  try {
    const [compressedWorkouts, compressedPostprocess, compressedGpsBestEfforts] = await Promise.all([
      fs.readFile(claimed.workoutsPath),
      fs.readFile(claimed.workoutPostprocessPath),
      fs.readFile(claimed.gpsBestEffortsPath)
    ]);
    const artifacts = decodeWoaBundleArtifacts({
      compressedWorkouts,
      compressedPostprocess,
      compressedGpsBestEfforts,
      workoutsCodec: claimed.workoutsCodec
    });
    const result = await processDecodedWoaBundle({ bundle: claimed, artifacts, safeMode: true });
    await removeWoaBundleFiles(claimed);
    console.log(`[import] woa-bundle.recovery.completed ${formatLogPayload({
      uid,
      uploadId,
      resumedFromPhase: claimed.phase,
      attemptCount: claimed.attemptCount,
      checkpointMs: result.checkpointMs,
      totalMs: performance.now() - startedAt
    })}`);
    return result;
  } catch (error) {
    await failWoaBundleUpload(uid, uploadId, error);
    throw error;
  }
}

router.get(
  "/existing-start-times",
  authMiddleware,
  async (req, res, next) => {
    try {
      if (!req.user?.id) {
        return res.status(401).json({ error: "Nicht angemeldet" });
      }

      const result = await pool.query(
        `
          SELECT start_time
          FROM workouts
          WHERE uid = $1
            AND start_time IS NOT NULL
          ORDER BY start_time DESC
        `,
        [req.user.id]
      );

      return res.json({
        startTimes: result.rows.map((row) => new Date(row.start_time).toISOString())
      });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/browser-gps-segment-definitions",
  authMiddleware,
  async (req, res, next) => {
    try {
      if (!req.user?.id) return res.status(401).json({ error: "Nicht angemeldet" });
      const result = await pool.query(`
        SELECT
          id,
          distance,
          ST_YMin(bounds) AS min_lat,
          ST_YMax(bounds) AS max_lat,
          ST_XMin(bounds) AS min_lng,
          ST_XMax(bounds) AS max_lng,
          ST_AsGeoJSON(geom)::json AS geom
        FROM gps_segments
        WHERE uid = $1
          AND bounds IS NOT NULL
          AND geom IS NOT NULL
        ORDER BY id
      `, [req.user.id]);
      return res.json({
        segments: result.rows.map((row) => ({
          id: Number(row.id),
          distance: Number(row.distance) || 0,
          bounds: {
            minLat: Number(row.min_lat),
            maxLat: Number(row.max_lat),
            minLng: Number(row.min_lng),
            maxLng: Number(row.max_lng)
          },
          track: (Array.isArray(row.geom?.coordinates) ? row.geom.coordinates : [])
            .map(([lng, lat]) => ({ lat: Number(lat), lng: Number(lng) }))
        }))
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/woa-bundle/:uploadId/status",
  authMiddleware,
  async (req, res, next) => {
    try {
      if (!req.user?.id) return res.status(401).json({ error: "Nicht angemeldet" });
      const uploadId = normalizeBundleUploadId(req.params.uploadId);
      const bundle = await getWoaBundleUpload(req.user.id, uploadId);
      if (!bundle) return res.status(404).json({ error: "WOA bundle not found" });
      const completed = bundle.status === "completed";
      return res.json({
        uploadId,
        recoveryEnabled: true,
        status: bundle.status,
        phase: bundle.phase,
        attemptCount: bundle.attemptCount,
        lastError: bundle.lastError,
        ...(completed ? {
          ...bundle.importResult,
          browserPostprocess: bundle.workoutPostprocessResult,
          browserGpsBestEfforts: bundle.gpsBestEffortsResult
        } : {})
      });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  "/woa-bundle",
  authMiddleware,
  requireActiveAccountWrite,
  uploadMiddleware.fields([
    { name: "workouts", maxCount: 1 },
    { name: "workoutPostprocess", maxCount: 1 },
    { name: "gpsBestEfforts", maxCount: 1 }
  ]),
  async (req, res, next) => {
    const startedAt = performance.now();
    const uploadedFiles = Object.values(req.files || {}).flat().filter(Boolean);
    let retainFilesForRecovery = false;
    const cleanup = async () => {
      await Promise.all(uploadedFiles.map((file) => fs.rm(file.path, { force: true }).catch(() => {})));
    };

    try {
      if (!req.user?.id) return res.status(401).json({ error: "Nicht angemeldet" });
      const workoutsFile = req.files?.workouts?.[0];
      const postprocessFile = req.files?.workoutPostprocess?.[0];
      const gpsBestEffortsFile = req.files?.gpsBestEfforts?.[0];
      if (!workoutsFile || !postprocessFile || !gpsBestEffortsFile) {
        return res.status(400).json({ error: "WOA-Bundle benötigt Workouts, WPP1 und GBE1" });
      }

      const [compressedWorkouts, compressedPostprocess, compressedGpsBestEfforts] = await Promise.all([
        fs.readFile(workoutsFile.path),
        fs.readFile(postprocessFile.path),
        fs.readFile(gpsBestEffortsFile.path)
      ]);
      const workoutCompression = String(req.body?.workoutsCodec || "gzip").trim().toLowerCase() === "brotli"
        ? "brotli"
        : "gzip";
      const artifacts = decodeWoaBundleArtifacts({
        compressedWorkouts,
        compressedPostprocess,
        compressedGpsBestEfforts,
        workoutsCodec: workoutCompression
      });
      const uploadId = normalizeBundleUploadId(req.body?.uploadId);
      const bundleBase = {
        uid: String(req.user.id),
        uploadId,
        phase: "received",
        workoutsPath: workoutsFile.path,
        workoutPostprocessPath: postprocessFile.path,
        gpsBestEffortsPath: gpsBestEffortsFile.path,
        workoutsOriginalName: workoutsFile.originalname,
        workoutsCodec: workoutCompression,
        overwriteExisting: String(req.body?.overwriteExisting || "0") === "1",
        workoutsBytes: compressedWorkouts.length,
        workoutPostprocessBytes: compressedPostprocess.length,
        gpsBestEffortsBytes: compressedGpsBestEfforts.length
      };

      let bundle = bundleBase;
      let safeSetupMs = 0;
      if (WOA_BUNDLE_RECOVERY_ENABLED) {
        const safeSetupStartedAt = performance.now();
        const created = await createWoaBundleUpload(bundleBase);
        if (!created) {
          const existing = await getWoaBundleUpload(req.user.id, uploadId);
          if (existing?.status === "completed") {
            return res.status(200).json({
              ...existing.importResult,
              uploadId,
              recoveryEnabled: true,
              alreadyCompleted: true,
              browserPostprocess: existing.workoutPostprocessResult,
              browserGpsBestEfforts: existing.gpsBestEffortsResult
            });
          }
          if (existing) await enqueueWoaBundleRecovery({ uid: req.user.id, uploadId });
          return res.status(202).json({ uploadId, recoveryEnabled: true, recoveryQueued: true });
        }
        retainFilesForRecovery = true;
        bundle = await claimWoaBundleUpload(req.user.id, uploadId, { allowActive: true });
        if (!bundle) throw new Error("WOA bundle could not be claimed for processing");
        safeSetupMs = performance.now() - safeSetupStartedAt;
      }

      let processed;
      try {
        processed = await processDecodedWoaBundle({
          bundle,
          artifacts,
          safeMode: WOA_BUNDLE_RECOVERY_ENABLED
        });
      } catch (error) {
        if (!WOA_BUNDLE_RECOVERY_ENABLED) throw error;
        await failWoaBundleUpload(req.user.id, uploadId, error, "retry_queued");
        await enqueueWoaBundleRecovery({ uid: req.user.id, uploadId });
        return res.status(202).json({
          uploadId,
          recoveryEnabled: true,
          recoveryQueued: true,
          error: error instanceof Error ? error.message : String(error)
        });
      }

      const { importResult, postprocessResult, gpsBestEffortsResult, checkpointMs } = processed;
      if (WOA_BUNDLE_RECOVERY_ENABLED) {
        await removeWoaBundleFiles(bundle);
        retainFilesForRecovery = false;
      }

      const bundleElapsedMs = performance.now() - startedAt;
      console.log(`[import] woa-bundle.profile ${formatLogPayload({
        uploadId,
        uid: req.user.id,
        recoveryEnabled: WOA_BUNDLE_RECOVERY_ENABLED,
        workoutsBytes: compressedWorkouts.length,
        workoutPostprocessBytes: compressedPostprocess.length,
        gpsBestEffortsBytes: compressedGpsBestEfforts.length,
        safeSetupMs,
        checkpointMs,
        recoveryOverheadMs: safeSetupMs + checkpointMs,
        importMs: importResult.bundlePhaseMs ?? importResult.elapsedMs,
        workoutPostprocessMs: postprocessResult.totalMs,
        gpsBestEffortsMs: gpsBestEffortsResult.totalMs,
        totalMs: bundleElapsedMs
      })}`);

      return res.status(200).json({
        ...importResult,
        uploadId,
        bundleElapsedMs,
        recoveryEnabled: WOA_BUNDLE_RECOVERY_ENABLED,
        recoveryOverheadMs: safeSetupMs + checkpointMs,
        browserPostprocess: postprocessResult,
        browserGpsBestEfforts: gpsBestEffortsResult
      });
    } catch (error) {
      if (error instanceof WorkoutLocalPostprocessValidationError
        || error instanceof BrowserGpsBestEffortsValidationError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      if (error instanceof WoaBundleHttpError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      next(error);
    } finally {
      if (!retainFilesForRecovery) await cleanup();
    }
  }
);

router.post(
  "/woa-zip",
  authMiddleware,
  requireActiveAccountWrite,
  uploadMiddleware.single("file"),
  async (req, res, next) => {
    const uploadedFile = req.file;

    try {
      if (!req.user?.id) {
        if (uploadedFile?.path) {
          await fs.rm(uploadedFile.path, { force: true }).catch(() => {});
        }
        return res.status(401).json({ error: "Nicht angemeldet" });
      }

      if (!uploadedFile) {
        return res.status(400).json({ error: "Keine Datei hochgeladen" });
      }

      if (path.extname(uploadedFile.originalname).toLowerCase() !== ".zip") {
        await fs.rm(uploadedFile.path, { force: true }).catch(() => {});
        return res.status(400).json({ error: "Nur ein .zip Upload ist erlaubt" });
      }

      const zipDirectory = await unzipper.Open.file(uploadedFile.path);
      const woaEntries = zipDirectory.files.filter((entry) =>
        entry.type === "File"
        && entry.path.toLowerCase().endsWith(".woa1")
        && !entry.path.startsWith("__MACOSX/")
        && !path.basename(entry.path).startsWith("._")
      );

      if (woaEntries.length === 0) {
        await fs.rm(uploadedFile.path, { force: true }).catch(() => {});
        return res.status(400).json({ error: "ZIP enthält keine .woa1 Dateien" });
      }
      const result = await importWoaEntryReaders({
        userId: req.user.id,
        sourceName: uploadedFile.originalname,
        uploadedSizeBytes: uploadedFile.size,
        overwriteExisting: String(req.body?.overwriteExisting || "0") === "1",
        browserLocalPostprocess: String(req.body?.browserLocalPostprocess || "0") === "1",
        browserGpsSegmentBestEfforts: String(req.body?.browserGpsSegmentBestEfforts || "0") === "1",
        entryReaders: woaEntries.map((entry) => ({
          path: entry.path,
          buffer: () => entry.buffer()
        }))
      });

      await fs.rm(uploadedFile.path, { force: true }).catch(() => {});
      res.status(200).json(result);
    } catch (error) {
      if (uploadedFile?.path) {
        await fs.rm(uploadedFile.path, { force: true }).catch(() => {});
      }
      next(error);
    }
  }
);

router.post(
  "/workout-local-postprocess",
  authMiddleware,
  requireActiveAccountWrite,
  async (req, res, next) => {
    const startedAt = performance.now();
    try {
      if (!req.user?.id) return res.status(401).json({ error: "Nicht angemeldet" });
      const chunks = [];
      let compressedByteLength = 0;
      for await (const chunk of req) {
        compressedByteLength += chunk.length;
        if (compressedByteLength > BROWSER_POSTPROCESS_MAX_COMPRESSED_BYTES) {
          return res.status(413).json({ error: "Postprocessing-Container ist zu groß" });
        }
        chunks.push(chunk);
      }
      if (compressedByteLength === 0) return res.status(400).json({ error: "Kein Postprocessing-Container hochgeladen" });

      const compressedBytes = Buffer.concat(chunks);
      const decompressStartedAt = performance.now();
      let rawBytes;
      try {
        rawBytes = gunzipSync(compressedBytes, { maxOutputLength: BROWSER_POSTPROCESS_MAX_RAW_BYTES });
      } catch (error) {
        if (error?.code === "ERR_BUFFER_TOO_LARGE") {
          return res.status(413).json({ error: "Entpackter Postprocessing-Container ist zu groß" });
        }
        return res.status(400).json({ error: "Ungültiger Gzip-Postprocessing-Container" });
      }
      const decompressMs = performance.now() - decompressStartedAt;
      const decodeStartedAt = performance.now();
      let decoded;
      try {
        decoded = decodeWorkoutLocalPostprocessTransport(rawBytes);
      } catch {
        return res.status(400).json({ error: "Ungültiger WPP1-Postprocessing-Container" });
      }
      const decodeMs = performance.now() - decodeStartedAt;
      const persisted = await persistWorkoutLocalPostprocess({
        uid: req.user.id,
        decoded,
        pool,
        batchWorkoutCount: BROWSER_POSTPROCESS_DB_BATCH_WORKOUTS
      });
      const totalMs = performance.now() - startedAt;
      const result = {
        format: "WPP1",
        compressedBytes: compressedByteLength,
        rawBytes: rawBytes.byteLength,
        decompressMs,
        decodeMs,
        totalMs,
        ...persisted
      };
      console.log(`[postprocess] browser-local-import.profile ${formatLogPayload({ uid: req.user.id, ...result })}`);
      return res.status(200).json(result);
    } catch (error) {
      if (error instanceof WorkoutLocalPostprocessValidationError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      next(error);
    }
  }
);

router.post(
  "/workout-gps-segment-best-efforts",
  authMiddleware,
  requireActiveAccountWrite,
  async (req, res, next) => {
    const startedAt = performance.now();
    try {
      if (!req.user?.id) return res.status(401).json({ error: "Nicht angemeldet" });
      const chunks = [];
      let compressedByteLength = 0;
      for await (const chunk of req) {
        compressedByteLength += chunk.length;
        if (compressedByteLength > BROWSER_POSTPROCESS_MAX_COMPRESSED_BYTES) {
          return res.status(413).json({ error: "GPS-Best-Efforts-Container ist zu groß" });
        }
        chunks.push(chunk);
      }
      if (!compressedByteLength) return res.status(400).json({ error: "Kein GPS-Best-Efforts-Container hochgeladen" });

      const decompressStartedAt = performance.now();
      let rawBytes;
      try {
        rawBytes = gunzipSync(Buffer.concat(chunks), { maxOutputLength: BROWSER_POSTPROCESS_MAX_RAW_BYTES });
      } catch (error) {
        if (error?.code === "ERR_BUFFER_TOO_LARGE") return res.status(413).json({ error: "Entpackter GPS-Best-Efforts-Container ist zu groß" });
        return res.status(400).json({ error: "Ungültiger Gzip-GPS-Best-Efforts-Container" });
      }
      const decompressMs = performance.now() - decompressStartedAt;
      const decodeStartedAt = performance.now();
      let decoded;
      try {
        decoded = decodeBrowserGpsBestEffortsTransport(rawBytes);
      } catch {
        return res.status(400).json({ error: "Ungültiger GBE1-GPS-Best-Efforts-Container" });
      }
      const decodeMs = performance.now() - decodeStartedAt;
      const persisted = await persistBrowserGpsBestEfforts({ uid: req.user.id, decoded, pool });
      const result = {
        format: "GBE1",
        compressedBytes: compressedByteLength,
        rawBytes: rawBytes.byteLength,
        decompressMs,
        decodeMs,
        totalMs: performance.now() - startedAt,
        ...persisted
      };
      console.log(`[postprocess] browser-gps-best-efforts.profile ${formatLogPayload({ uid: req.user.id, ...result })}`);
      return res.status(200).json(result);
    } catch (error) {
      if (error instanceof BrowserGpsBestEffortsValidationError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      next(error);
    }
  }
);

router.post(
  "/woa-container",
  authMiddleware,
  requireActiveAccountWrite,
  async (req, res, next) => {
    try {
      if (!req.user?.id) {
        return res.status(401).json({ error: "Nicht angemeldet" });
      }

      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }

      const compressedBytes = Buffer.concat(chunks);
      if (compressedBytes.length === 0) {
        return res.status(400).json({ error: "Keine Datei hochgeladen" });
      }

      const containerCompression = resolveUploadContainerCompression(req);
      const inflatedBytes = decompressUploadContainer(compressedBytes, containerCompression);
      const decoded = decodeWoaTransportContainer(inflatedBytes);
      const woaEntries = decoded.entries.filter((entry) =>
        String(entry?.name || "").toLowerCase().endsWith(".woa1")
      );

      if (woaEntries.length === 0) {
        return res.status(400).json({ error: "Container enthält keine .woa1 Dateien" });
      }

      const result = await importWoaEntryReaders({
        userId: req.user.id,
        sourceName: String(req.headers["x-upload-filename"] || (containerCompression === "brotli" ? "upload.woat.br" : "upload.woat.gz")),
        uploadedSizeBytes: compressedBytes.length,
        overwriteExisting: String(req.headers["x-overwrite-existing"] || "0") === "1",
        browserLocalPostprocess: String(req.headers["x-browser-local-postprocess"] || "0") === "1",
        browserGpsSegmentBestEfforts: String(req.headers["x-browser-gps-segment-best-efforts"] || "0") === "1",
        entryReaders: woaEntries.map((entry) => ({
          path: entry.name,
          buffer: async () => entry.bytes
        }))
      });

      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }
);

export default router;
