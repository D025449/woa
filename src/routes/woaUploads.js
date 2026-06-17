import fs from "node:fs/promises";
import path from "node:path";
import util from "node:util";
import { Router } from "express";
import unzipper from "unzipper";

import authMiddleware from "../middleware/authMiddleware.js";
import requireActiveAccountWrite from "../middleware/requireActiveAccountWrite.js";
import uploadMiddleware from "../middleware/uploadMiddleware.js";
import { FileDBService } from "../services/fileDBService.js";
import { decodeWoa1Buffer } from "../services/woa1Service.js";
import { enqueueWorkoutSegmentBestEfforts, enqueueWorkoutSegmentPersistence } from "../services/segment-best-efforts-service.js";
import { enqueueWorkoutSimilarityClassification } from "../services/workout-similarity-job-service.js";

const router = Router();
const IMPORT_SYNC_PROFILE_LOG = String(process.env.IMPORT_SYNC_PROFILE_LOG || "1").trim() !== "0";
const IMPORT_DB_BULK_INSERT_SIZE = Math.max(1, Number(process.env.IMPORT_DB_BULK_INSERT_SIZE) || 20);

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

      const inserted = [];
      const skipped = [];
      const startedAt = Date.now();
      const pendingItems = [];
      const profile = {
        openZipMs: 0,
        filterEntriesMs: 0,
        readEntryMs: 0,
        decodeWoaMs: 0,
        prepareInsertMs: 0,
        prepareInsertToCompressedBufferMs: 0,
        prepareInsertBuildGeometryWktMs: 0,
        prepareInsertEncodeGpsTrackBlobMs: 0,
        insertWorkoutMs: 0,
        schedulePostprocessMs: 0
      };

      const openZipStartedAt = Date.now();
      const zipDirectory = await unzipper.Open.file(uploadedFile.path);
      profile.openZipMs += Date.now() - openZipStartedAt;

      const filterEntriesStartedAt = Date.now();
      const woaEntries = zipDirectory.files.filter((entry) =>
        entry.type === "File"
        && entry.path.toLowerCase().endsWith(".woa1")
        && !entry.path.startsWith("__MACOSX/")
        && !path.basename(entry.path).startsWith("._")
      );
      profile.filterEntriesMs += Date.now() - filterEntriesStartedAt;

      if (woaEntries.length === 0) {
        await fs.rm(uploadedFile.path, { force: true }).catch(() => {});
        return res.status(400).json({ error: "ZIP enthält keine .woa1 Dateien" });
      }

      logImportEvent("woa-sync-import.started", {
        uid: req.user.id,
        sourceName: uploadedFile.originalname,
        totalEntries: woaEntries.length
      });

      for (const entry of woaEntries) {
        try {
          const readEntryStartedAt = Date.now();
          const entryBuffer = await entry.buffer();
          profile.readEntryMs += Date.now() - readEntryStartedAt;

          const decodeStartedAt = Date.now();
          const decoded = decodeWoa1Buffer(entryBuffer);
          profile.decodeWoaMs += Date.now() - decodeStartedAt;
          const fileRow = {
            ...decoded.fileRow,
            uid: req.user.id,
            gps_source: decoded.meta?.gpsSource === "manual_lookup" ? "manual_lookup" : null
          };
          const prepareStartedAt = Date.now();
          const preparedInsert = await FileDBService.prepareInsertFilePayload(fileRow, decoded.gpsTrack, decoded.workoutObject);
          profile.prepareInsertMs += Date.now() - prepareStartedAt;
          for (const step of Array.isArray(preparedInsert?.timingSteps) ? preparedInsert.timingSteps : []) {
            if (step?.label === "to-compressed-buffer") {
              profile.prepareInsertToCompressedBufferMs += Number(step.stepMs || 0);
            }
            if (step?.label === "build-geometry-wkt") {
              profile.prepareInsertBuildGeometryWktMs += Number(step.stepMs || 0);
            }
            if (step?.label === "encode-gps-track-blob") {
              profile.prepareInsertEncodeGpsTrackBlobMs += Number(step.stepMs || 0);
            }
          }

          pendingItems.push({
            entryName: entry.path,
            preparedInsert,
            validGps: !!decoded.gpsTrack?.validGps
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
            chunk.map((item) => item.preparedInsert)
          );
          profile.insertWorkoutMs += Date.now() - insertStartedAt;

          const existingByKey = bulkResult?.existingRowsByKey instanceof Map
            ? bulkResult.existingRowsByKey
            : new Map();

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

            const scheduleStartedAt = Date.now();
            await enqueueWorkoutSegmentPersistence({
              uid: item.preparedInsert.fileRow.uid,
              workoutId: Number(dbrow.id),
              entryName: item.entryName,
              recomputeFromDb: true,
              importJobId: null
            });

            if (item.validGps) {
              await enqueueWorkoutSimilarityClassification({
                uid: item.preparedInsert.fileRow.uid,
                workoutId: Number(dbrow.id),
                importJobId: null
              });
              await enqueueWorkoutSegmentBestEfforts({
                uid: item.preparedInsert.fileRow.uid,
                workoutId: Number(dbrow.id),
                importJobId: null
              });
            }
            profile.schedulePostprocessMs += Date.now() - scheduleStartedAt;
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

      await fs.rm(uploadedFile.path, { force: true }).catch(() => {});

      const elapsedMs = Date.now() - startedAt;
      if (IMPORT_SYNC_PROFILE_LOG) {
        logImportEvent("woa-sync-import.profile", {
          sourceName: uploadedFile.originalname,
          totalEntries: woaEntries.length,
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
              toCompressedBufferMs: profile.prepareInsertToCompressedBufferMs,
              buildGeometryWktMs: profile.prepareInsertBuildGeometryWktMs,
              encodeGpsTrackBlobMs: profile.prepareInsertEncodeGpsTrackBlobMs
            },
            insertWorkoutMs: profile.insertWorkoutMs,
            schedulePostprocessMs: profile.schedulePostprocessMs
          }
        });
      }

      logImportEvent("woa-sync-import.completed", {
        sourceName: uploadedFile.originalname,
        totalEntries: woaEntries.length,
        importedEntries: inserted.length,
        skippedEntries: skipped.length,
        elapsedMs
      });

      res.status(200).json({
        importedCount: inserted.length,
        skippedCount: skipped.length,
        totalEntries: woaEntries.length,
        elapsedMs,
        inserted,
        skipped
      });
    } catch (error) {
      if (uploadedFile?.path) {
        await fs.rm(uploadedFile.path, { force: true }).catch(() => {});
      }
      next(error);
    }
  }
);

export default router;
