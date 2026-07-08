import fs from "node:fs/promises";
import path from "node:path";
import util from "node:util";
import { gunzipSync } from "node:zlib";
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
import {
  enqueueWorkoutSegmentBestEffortsBulk,
  enqueueWorkoutSegmentPersistenceBulk
} from "../services/segment-best-efforts-service.js";
import { enqueueWorkoutSimilarityClassificationBulk } from "../services/workout-similarity-job-service.js";

const router = Router();
const IMPORT_SYNC_PROFILE_LOG = String(process.env.IMPORT_SYNC_PROFILE_LOG || "1").trim() !== "0";
const IMPORT_DB_BULK_INSERT_SIZE = Math.max(1, Number(process.env.IMPORT_DB_BULK_INSERT_SIZE) || 20);
const IMPORT_POSTPROCESS_ENQUEUE_BULK_SIZE = 500;

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
  overwriteExisting = false
}) {
  const inserted = [];
  const skipped = [];
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
  const allSimilarityItems = [];
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
    try {
      const insertStartedAt = Date.now();
      const bulkResult = await FileDBService.insertPreparedFilesBulk(
        chunk.map((item) => item.preparedInsert),
        { overwriteExisting }
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

      const segmentPersistItems = resolvedChunkItems.map((item) => ({
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
        recomputeSegmentsFromDb: true,
        hasSegments: false,
        segmentPayloadPath: null
      }));
      allPostprocessTargets.push(...chunkTargets);
      allSegmentPersistItems.push(...segmentPersistItems);
      allSimilarityItems.push(...validGpsItems);
      allSegmentBestEffortsItems.push(...validGpsItems);
    } catch (error) {
      for (const item of chunk) {
        skipped.push({
          entryName: item.entryName,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
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
    for (const item of allSegmentPersistItems) {
      skipped.push({
        entryName: item.entryName,
        error: `Postprocess enqueue failed: segment-persist: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  } finally {
    profile.scheduleSegmentPersistenceMs += Date.now() - persistStartedAt;
  }

  const similarityStartedAt = Date.now();
  try {
    await enqueueInLargeBulks(
      allSimilarityItems,
      IMPORT_POSTPROCESS_ENQUEUE_BULK_SIZE,
      enqueueWorkoutSimilarityClassificationBulk
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const item of allSimilarityItems) {
      skipped.push({
        entryName: `workout:${item.workoutId}`,
        error: `Postprocess enqueue failed: similarity: ${message}`
      });
    }
  } finally {
    profile.scheduleSimilarityMs += Date.now() - similarityStartedAt;
  }

  const segmentBestEffortsStartedAt = Date.now();
  try {
    await enqueueInLargeBulks(
      allSegmentBestEffortsItems,
      IMPORT_POSTPROCESS_ENQUEUE_BULK_SIZE,
      enqueueWorkoutSegmentBestEffortsBulk
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const item of allSegmentBestEffortsItems) {
      skipped.push({
        entryName: `workout:${item.workoutId}`,
        error: `Postprocess enqueue failed: segment-best-efforts: ${message}`
      });
    }
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
    elapsedMs
  });

  return {
    importJobId,
    importedCount: inserted.length,
    skippedCount: skipped.length,
    totalEntries: entryReaders.length,
    elapsedMs,
    inserted,
    skipped
  };
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

      const inflatedBytes = gunzipSync(compressedBytes);
      const decoded = decodeWoaTransportContainer(inflatedBytes);
      const woaEntries = decoded.entries.filter((entry) =>
        String(entry?.name || "").toLowerCase().endsWith(".woa1")
      );

      if (woaEntries.length === 0) {
        return res.status(400).json({ error: "Container enthält keine .woa1 Dateien" });
      }

      const result = await importWoaEntryReaders({
        userId: req.user.id,
        sourceName: String(req.headers["x-upload-filename"] || "upload.woat.gz"),
        uploadedSizeBytes: compressedBytes.length,
        overwriteExisting: String(req.headers["x-overwrite-existing"] || "0") === "1",
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
