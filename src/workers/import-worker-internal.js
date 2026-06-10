import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";

import { Worker } from "bullmq";
import unzipper from "unzipper";
import FitParser from "fit-file-parser";

import {
  processFitRecords,
  mapAggregatedToFileRow
} from "../services/fitService.js";

import { FileDBService } from "../services/fileDBService.js";
import SegmentDBService from "../services/segmentDBService.js";
import EntitlementService from "../services/entitlementService.js";
import WorkoutSharingService from "../services/workoutSharingService.js";
import WorkoutThumbnailService from "../services/workoutThumbnailService.js";
import WorkoutSimilarityService from "../services/workoutSimilarityService.js";
import { enqueueWorkoutSimilarityClassification } from "../services/workout-similarity-job-service.js";
import { enqueueImportBatchJobs } from "../services/import-batch-job-service.js";
import { enqueueWorkoutSegmentBestEfforts } from "../services/segment-best-efforts-service.js";

import { redisConnection } from "../queue/connection.js";
import S3Service from "../services/s3Service.js";
import {
  getImportJobById,
  updateImportJob
} from "../db/import-jobs-repo.js";
import CollaborationDBService from "../services/collaborationDBService.js";

export async function createApp(options = {}) {
  const LOCAL_BATCH_FIT_CONCURRENCY = 2;
  const IMPORT_BATCH_SIZE = 10;
  const IMPORT_TIMING_DEBUG = String(process.env.IMPORT_TIMING_DEBUG || "").trim() === "1";
  const {
    enableImportWorker = true,
    enableImportBatchWorker = true,
    enableSegmentBestEffortsWorker = true,
    enableWorkoutSimilarityWorker = true
  } = options;

  function logImportEvent(type, payload = {}) {
    console.log(`[import] ${type}`, payload);
  }

  function logPostProcessEvent(type, payload = {}) {
    console.log(`[postprocess] ${type}`, payload);
  }

  function createStepLogger(scope, meta = {}) {
    const startedAt = Date.now();
    let lastAt = startedAt;
    const steps = [];

    return {
      mark(label, extra = {}) {
        const now = Date.now();
        steps.push({
          label,
          stepMs: now - lastAt,
          totalMs: now - startedAt,
          ...extra
        });
        lastAt = now;
      },
      flush(extra = {}) {
        if (!IMPORT_TIMING_DEBUG) {
          return;
        }
        console.log(`[timing] ${scope}`, {
          ...meta,
          totalMs: Date.now() - startedAt,
          steps,
          ...extra
        });
      }
    };
  }

  function createBatchTrace(scope, meta = {}) {
    const startedAt = Date.now();
    const totals = {
      entryBufferMs: 0,
      parseFitMs: 0,
      persistWorkoutMs: 0,
      updateJobMs: 0,
      renderThumbnailMs: 0,
      processFitRecordsMs: 0,
      mapAggregatedRowMs: 0,
      insertFileMs: 0,
      classifySimilarWorkoutsMs: 0,
      shareWorkoutMs: 0,
      createFeedEventsMs: 0,
      getMatchingSegmentCandidatesMs: 0,
      matchSegmentsMs: 0,
      storeSegmentBestEffortsMs: 0
    };

    return {
      add(metric, ms) {
        if (Object.hasOwn(totals, metric)) {
          totals[metric] += ms;
        }
      },
      checkpoint(extra = {}) {
        if (!IMPORT_TIMING_DEBUG) {
          return;
        }
        console.log(`[timing] ${scope}`, {
          ...meta,
          totalMs: Date.now() - startedAt,
          totals,
          ...extra
        });
      },
      flush(extra = {}) {
        if (!IMPORT_TIMING_DEBUG) {
          return;
        }
        console.log(`[timing] ${scope}`, {
          ...meta,
          totalMs: Date.now() - startedAt,
          totals,
          ...extra
        });
      }
    };
  }

  function createFileStatusKey(sourceName, entryName) {
    return `${sourceName || ""}::${entryName || ""}`;
  }

  function buildFileStatusEntry({ sourceName = null, entryName, status = "queued", message = null, workoutId = null }) {
    return {
      key: createFileStatusKey(sourceName, entryName),
      sourceName,
      entryName,
      status,
      message,
      workoutId
    };
  }

  async function persistFileStatuses(jobId, fileStatuses) {
    await updateImportJob(jobId, {
      fileStatuses
    });
  }

  async function updateSingleFileStatus(jobId, fileStatuses, matcher, patch = {}) {
    const index = fileStatuses.findIndex(matcher);
    if (index === -1) {
      return;
    }

    fileStatuses[index] = {
      ...fileStatuses[index],
      ...patch
    };

    await persistFileStatuses(jobId, fileStatuses);
  }

  async function processSegmentBestEffortsJob(uid, segmentIds) {
    await SegmentDBService.updateBestEffortsStatus(uid, segmentIds, "processing", null);

    try {
      const matchingEfforts =
        segmentIds.length === 1
          ? await (async () => {
              const segment = await SegmentDBService.getSegmentById(uid, segmentIds[0]);
              return segment
                ? SegmentDBService.scanWorkoutsForSegment(uid, segment)
                : [];
            })()
          : await SegmentDBService.scanWorkoutsForSegments(
              uid,
              segmentIds.map((id) => ({ id }))
            );

      await SegmentDBService.storeSegmentBestEffortsV2(matchingEfforts);
      await SegmentDBService.updateBestEffortsStatus(uid, segmentIds, "completed", null);
    } catch (error) {
      await SegmentDBService.updateBestEffortsStatus(
        uid,
        segmentIds,
        "failed",
        error.message || "Unknown segment best-effort error"
      );
      throw error;
    }
  }

  async function processWorkoutSimilarityRebuildJob(job) {
    const uid = job.data?.uid;
    const mode = String(job.data?.mode || "delta").trim().toLowerCase() === "full"
      ? "full"
      : "delta";
    if (!uid) {
      throw new Error("Workout similarity rebuild job is missing uid");
    }

    await job.updateProgress({
      progressPercent: 0,
      workoutCount: 0,
      processedWorkouts: 0,
      edgeCount: 0
    });

    const result = await WorkoutSimilarityService.classifySimilarGpsWorkoutsForUser(uid, {
      rebuildMode: mode,
      onProgress: async (progress) => {
        await job.updateProgress(progress);
      }
    });

    await job.updateProgress({
      progressPercent: 100,
      workoutCount: Number(result?.workoutCount || 0),
      processedWorkouts: Number(result?.processedWorkouts || 0),
      edgeCount: Number(result?.edgeCount || 0)
    });

    return {
      progressPercent: 100,
      workoutCount: Number(result?.workoutCount || 0),
      processedWorkouts: Number(result?.processedWorkouts || 0),
      edgeCount: Number(result?.edgeCount || 0)
    };
  }

  async function processWorkoutSimilarityClassificationJob(job) {
    const uid = job.data?.uid;
    const workoutId = Number(job.data?.workoutId);

    if (!uid || !Number.isInteger(workoutId)) {
      throw new Error("Workout similarity classification job is missing uid or workoutId");
    }

    await job.updateProgress({
      progressPercent: 0,
      workoutId
    });

    logPostProcessEvent("similarity.started", {
      queueJobId: job.id,
      uid,
      workoutId
    });

    const edges = await WorkoutSimilarityService.classifySimilarGpsWorkoutsForWorkout(workoutId, uid, {
      rebuildMode: "delta"
    });

    await job.updateProgress({
      progressPercent: 100,
      workoutId,
      edgeCount: Array.isArray(edges) ? edges.length : 0
    });

    logPostProcessEvent("similarity.completed", {
      queueJobId: job.id,
      uid,
      workoutId,
      edgeCount: Array.isArray(edges) ? edges.length : 0
    });

    return {
      progressPercent: 100,
      workoutId,
      edgeCount: Array.isArray(edges) ? edges.length : 0
    };
  }

  async function processWorkoutSegmentBestEffortsJob(job) {
    const uid = job.data?.uid;
    const workoutId = Number(job.data?.workoutId);

    if (!uid || !Number.isInteger(workoutId)) {
      throw new Error("Workout segment best-efforts job is missing uid or workoutId");
    }

    await job.updateProgress({
      progressPercent: 0,
      workoutId
    });

    logPostProcessEvent("segment-best-efforts.started", {
      queueJobId: job.id,
      uid,
      workoutId
    });

    const matches = await SegmentDBService.rescanSegmentBestEffortsForWorkout(uid, workoutId);

    await job.updateProgress({
      progressPercent: 100,
      workoutId,
      matchCount: Array.isArray(matches) ? matches.length : 0
    });

    logPostProcessEvent("segment-best-efforts.completed", {
      queueJobId: job.id,
      uid,
      workoutId,
      matchCount: Array.isArray(matches) ? matches.length : 0
    });

    return {
      progressPercent: 100,
      workoutId,
      matchCount: Array.isArray(matches) ? matches.length : 0
    };
  }


  async function processFitJson(fitJsonObject, uid, shareConfig = null, context = {}) {
    const timing = createStepLogger("worker.process-fit-json", {
      uid
    });
    let dbrow = null;

    try {
      const { aggregated, segments, gps_track, workoutObject, importGpsSource } = processFitRecords(fitJsonObject, {
        sourceName: context.entryName || null
      });
      timing.mark("process-fit-records", {
        segmentCount: segments?.length ?? 0,
        gpsPointCount: gps_track?.track?.length ?? 0,
        validGps: !!gps_track?.validGps
      });
      const fitFile = {
        uid: uid,
        gps_source: importGpsSource
      };
      const fileRow = mapAggregatedToFileRow(aggregated, fitFile, workoutObject.getNormalizedPower());
      timing.mark("map-aggregated-to-file-row");
      dbrow = await FileDBService.insertFile(fileRow, segments, gps_track, workoutObject);
      timing.mark("insert-file", {
        workoutId: dbrow?.id
      });

      if (dbrow?.id) {
        const thumbnailPayload = WorkoutThumbnailService.createThumbnailPayload({
          gpsTrack: gps_track?.track ?? null,
          workoutObject
        });
        if (thumbnailPayload) {
          const thumbnailStartedAt = Date.now();
          await WorkoutThumbnailService.upsertThumbnail(dbrow.id, thumbnailPayload);
          timing.mark("store-thumbnail", {
            thumbnailKind: thumbnailPayload.kind,
            renderThumbnailMs: Date.now() - thumbnailStartedAt
          });
        }
      }

      if (dbrow?.id && shareConfig?.shareMode === "groups" && Array.isArray(shareConfig.groupIds) && shareConfig.groupIds.length > 0) {
        const sharedGroupIds = await WorkoutSharingService.createSharesForWorkout({
          workoutId: dbrow.id,
          sharedByUserId: uid,
          groupIds: shareConfig.groupIds
        });
        timing.mark("share-workout", {
          shareGroupCount: sharedGroupIds.length
        });

        if (sharedGroupIds.length > 0) {
          await CollaborationDBService.createWorkoutUploadedFeedEvents({
            groupIds: sharedGroupIds,
            actorUserId: uid,
            workoutId: dbrow.id,
            payload: {
              originalFileName: context.entryName || null,
              startTime: fileRow.start_time,
              totalDistance: fileRow.total_distance,
              totalTimerTime: fileRow.total_timer_time
            }
          });
          timing.mark("create-feed-events", {
            shareGroupCount: sharedGroupIds.length
          });
        }
      }

      if (dbrow?.id && gps_track?.validGps) {
        await enqueueWorkoutSimilarityClassification({
          uid,
          workoutId: dbrow.id
        });
        logPostProcessEvent("similarity.enqueued", {
          uid,
          workoutId: dbrow.id,
          entryName: context.entryName || null
        });
        timing.mark("enqueue-similar-workouts");
      } else {
        logPostProcessEvent("similarity.skipped", {
          uid,
          workoutId: dbrow?.id ?? null,
          entryName: context.entryName || null,
          reason: !dbrow?.id ? "missing_workout_id" : "no_valid_gps"
        });
      }

      if (gps_track.validGps) {
        await enqueueWorkoutSegmentBestEfforts({
          uid,
          workoutId: dbrow.id
        });
        logPostProcessEvent("segment-best-efforts.enqueued", {
          uid,
          workoutId: dbrow.id,
          entryName: context.entryName || null
        });
        timing.mark("enqueue-segment-best-efforts");
      } else {
        logPostProcessEvent("segment-best-efforts.skipped", {
          uid,
          workoutId: dbrow?.id ?? null,
          entryName: context.entryName || null,
          reason: "no_valid_gps"
        });
      }

      timing.flush({
        status: "completed",
        workoutId: dbrow?.id
      });
    } catch (error) {
      timing.flush({
        status: "failed",
        workoutId: dbrow?.id,
        error: error.message
      });
      throw error;
    }


  }

  async function processFitJsonWithMetrics(fitJsonObject, uid, batchTrace, shareConfig = null, context = {}) {
    const processFitRecordsStartedAt = Date.now();
    const { aggregated, segments, gps_track, workoutObject, importGpsSource } = processFitRecords(fitJsonObject, {
      sourceName: context.entryName || null
    });
    batchTrace?.add("processFitRecordsMs", Date.now() - processFitRecordsStartedAt);

    const fitFile = {
      uid,
      gps_source: importGpsSource
    };

    const mapStartedAt = Date.now();
    const fileRow = mapAggregatedToFileRow(aggregated, fitFile, workoutObject.getNormalizedPower());
    batchTrace?.add("mapAggregatedRowMs", Date.now() - mapStartedAt);

    const insertStartedAt = Date.now();
    const dbrow = await FileDBService.insertFile(fileRow, segments, gps_track, workoutObject);
    batchTrace?.add("insertFileMs", Date.now() - insertStartedAt);

    if (dbrow?.id) {
      const thumbnailPayload = WorkoutThumbnailService.createThumbnailPayload({
        gpsTrack: gps_track?.track ?? null,
        workoutObject
      });
      if (thumbnailPayload) {
        const thumbnailStartedAt = Date.now();
        await WorkoutThumbnailService.upsertThumbnail(dbrow.id, thumbnailPayload);
        batchTrace?.add("renderThumbnailMs", Date.now() - thumbnailStartedAt);
      }
    }

    if (dbrow?.id && shareConfig?.shareMode === "groups" && Array.isArray(shareConfig.groupIds) && shareConfig.groupIds.length > 0) {
      const shareStartedAt = Date.now();
      const sharedGroupIds = await WorkoutSharingService.createSharesForWorkout({
        workoutId: dbrow.id,
        sharedByUserId: uid,
        groupIds: shareConfig.groupIds
      });
      batchTrace?.add("shareWorkoutMs", Date.now() - shareStartedAt);

      if (sharedGroupIds.length > 0) {
        const feedStartedAt = Date.now();
        await CollaborationDBService.createWorkoutUploadedFeedEvents({
          groupIds: sharedGroupIds,
          actorUserId: uid,
          workoutId: dbrow.id,
          payload: {
            originalFileName: context.entryName || null,
            startTime: fileRow.start_time,
            totalDistance: fileRow.total_distance,
            totalTimerTime: fileRow.total_timer_time
          }
        });
        batchTrace?.add("createFeedEventsMs", Date.now() - feedStartedAt);
      }
    }

    if (dbrow?.id && gps_track?.validGps) {
      const similarityStartedAt = Date.now();
      await enqueueWorkoutSimilarityClassification({
        uid,
        workoutId: dbrow.id
      });
      logPostProcessEvent("similarity.enqueued", {
        uid,
        workoutId: dbrow.id,
        entryName: context.entryName || null
      });
      batchTrace?.add("classifySimilarWorkoutsMs", Date.now() - similarityStartedAt);
    } else {
      logPostProcessEvent("similarity.skipped", {
        uid,
        workoutId: dbrow?.id ?? null,
        entryName: context.entryName || null,
        reason: !dbrow?.id ? "missing_workout_id" : "no_valid_gps"
      });
    }

    if (gps_track.validGps) {
      const segmentStartedAt = Date.now();
      await enqueueWorkoutSegmentBestEfforts({
        uid,
        workoutId: dbrow.id
      });
      logPostProcessEvent("segment-best-efforts.enqueued", {
        uid,
        workoutId: dbrow.id,
        entryName: context.entryName || null
      });
      batchTrace?.add("storeSegmentBestEffortsMs", Date.now() - segmentStartedAt);
    } else {
      logPostProcessEvent("segment-best-efforts.skipped", {
        uid,
        workoutId: dbrow?.id ?? null,
        entryName: context.entryName || null,
        reason: "no_valid_gps"
      });
    }

    return dbrow;
  }

  async function processFitBatchItems(job) {
    const importJobId = job.data?.importJobId;
    const uid = job.data?.uid;
    const shareConfig = job.data?.shareConfig || null;
    const batchItems = Array.isArray(job.data?.batchItems) ? job.data.batchItems : [];

    if (!importJobId || !uid || batchItems.length === 0) {
      throw new Error("Import batch job is missing importJobId, uid, or batchItems");
    }

    const results = [];

    logImportEvent("batch.started", {
      queueJobId: job.id,
      importJobId,
      batchIndex: job.data?.batchIndex,
      itemCount: batchItems.length
    });

    for (const item of batchItems) {
      const startedAt = Date.now();

      try {
        const buffer = await fs.promises.readFile(item.localPath);
        const parsed = await parseFitBuffer(buffer);
        await processFitJsonWithMetrics(parsed, uid, null, shareConfig, {
          importJobId,
          entryName: item.entryName
        });

        results.push({
          key: item.key,
          sourceName: item.sourceName || null,
          entryName: item.entryName,
          status: "completed",
          message: null,
          elapsedMs: Date.now() - startedAt
        });
      } catch (error) {
        results.push({
          key: item.key,
          sourceName: item.sourceName || null,
          entryName: item.entryName,
          status: "failed",
          message: error.message || "Unknown import error",
          elapsedMs: Date.now() - startedAt
        });
      } finally {
        await fs.promises.rm(item.localPath, { force: true }).catch(() => {});
      }
    }

    return {
      importJobId,
      results
    };
  }

  async function extractZipEntriesToBatchItems(zipPath, sourceName) {
    const tempDir = path.join(os.tmpdir(), "woa-imports");
    await fs.promises.mkdir(tempDir, { recursive: true });
    const zipDirectory = await unzipper.Open.file(zipPath);
    const fitEntries = zipDirectory.files.filter((entry) =>
      entry.type === "File" &&
      entry.path.toLowerCase().endsWith(".fit") &&
      (!entry.path.startsWith("__MACOSX/"))
    );

    const batchItems = [];

    for (const entry of fitEntries) {
      const tempFilePath = path.join(
        tempDir,
        `${crypto.randomUUID()}.fit`
      );

      await pipeline(
        entry.stream(),
        fs.createWriteStream(tempFilePath)
      );

      batchItems.push({
        key: createFileStatusKey(sourceName, entry.path),
        sourceName,
        entryName: entry.path,
        localPath: tempFilePath
      });
    }

    return batchItems;
  }

  async function runParallelImportBatches({
    jobId,
    uid,
    shareConfig,
    batchItems,
    fileStatuses,
    totalFiles,
    batchTrace,
    mode = "parallel-fit-batches"
  }) {
    let processedFiles = 0;
    let failedFiles = 0;

    const { queueEvents, jobs } = await enqueueImportBatchJobs({
      importJobId: jobId,
      uid,
      items: batchItems,
      shareConfig,
      batchSize: IMPORT_BATCH_SIZE
    });

    logImportEvent("batches.enqueued", {
      importJobId: jobId,
      batchCount: jobs.length,
      itemCount: batchItems.length,
      mode
    });

    for (const queueJob of jobs) {
      const batchResult = await queueJob.waitUntilFinished(queueEvents);
      const results = Array.isArray(batchResult?.results) ? batchResult.results : [];

      for (const result of results) {
        await updateSingleFileStatus(
          jobId,
          fileStatuses,
          (item) => item.key === result.key,
          {
            status: result.status,
            message: result.message || null
          }
        );

        if (result.status === "completed") {
          processedFiles += 1;
        } else {
          failedFiles += 1;
        }
      }

      const progressPercent =
        totalFiles === 0
          ? 100
          : Math.min(95, 15 + ((processedFiles + failedFiles) / totalFiles) * 80);

      await updateImportJob(jobId, {
        processedFiles,
        failedFiles,
        progressPercent
      });

      if ((processedFiles + failedFiles) % 25 === 0 || (processedFiles + failedFiles) === totalFiles) {
        batchTrace?.checkpoint({
          phase: "processing",
          processedFiles,
          failedFiles
        });
      }
    }

    await updateImportJob(jobId, {
      stage: "saving_results",
      fileStatuses,
      progressPercent: 98
    });

    await updateImportJob(jobId, {
      status: "completed",
      stage: "completed",
      fileStatuses,
      totalFiles,
      processedFiles,
      failedFiles,
      progressPercent: 100
    });

    batchTrace?.flush({
      phase: "completed",
      mode,
      totalFiles,
      processedFiles,
      failedFiles
    });

    logImportEvent("job.completed", {
      importJobId: jobId,
      totalFiles,
      processedFiles,
      failedFiles,
      mode
    });
  }

  function parseFitBuffer(buffer) {
    return new Promise((resolve, reject) => {
      const parser = new FitParser({
        force: true,
        speedUnit: "m/s",
        lengthUnit: "m",
        temperatureUnit: "celsius",
        elapsedRecordField: true,
        mode: "list"
      });

      parser.parse(buffer, (error, data) => {
        if (error) {
          reject(error);
        } else {
          resolve(data);
        }
      });
    });
  }

  async function persistParsedWorkout(parsedData, context) {
    // TODO:
    // Hier baust du später deine echte Persistierung ein.
    // Zum Beispiel:
    // - Workout-Datensatz speichern
    // - User zuordnen
    // - Samples / Records speichern
    // - Duplikate prüfen
    const filename = path.basename(context.entryName);

    await processFitJson(parsedData, context.uid, context.shareConfig, context);
    const hasData = !!parsedData;
    if (hasData === false) {
      console.log("Persist workout", {
        importJobId: context.importJobId,
        uid: context.uid,
        entryName: filename || null,
        hasData: !!parsedData
      })
    }

    return true;
  }



  async function processSingleLocalFitFile(jobId, filePath, uid, originalFileName, shareConfig = null) {
    const fileStatuses = [
      buildFileStatusEntry({
        entryName: originalFileName || path.basename(filePath),
        status: "processing"
      })
    ];

    await updateImportJob(jobId, {
      status: "processing",
      stage: "parsing_fit_files",
      fileStatuses,
      totalFiles: 1,
      processedFiles: 0,
      failedFiles: 0,
      progressPercent: 30
    });

    try {
      const buffer = await fs.promises.readFile(filePath);
      const parsed = await parseFitBuffer(buffer);

      await persistParsedWorkout(parsed, {
        importJobId: jobId,
        uid,
        entryName: originalFileName || path.basename(filePath),
        shareConfig
      });

      fileStatuses[0] = {
        ...fileStatuses[0],
        status: "completed"
      };

      await updateImportJob(jobId, {
        status: "completed",
        stage: "completed",
        fileStatuses,
        totalFiles: 1,
        processedFiles: 1,
        failedFiles: 0,
        progressPercent: 100
      });
    } catch (error) {
      fileStatuses[0] = {
        ...fileStatuses[0],
        status: "failed",
        message: error.message || "Unknown import error"
      };
      await updateImportJob(jobId, {
        status: "failed",
        stage: "failed",
        fileStatuses,
        totalFiles: 1,
        processedFiles: 0,
        failedFiles: 1,
        errorMessage: error.message || "Unknown import error"
      });
      throw error;
    } finally {
      await fs.promises.rm(filePath, { force: true });
    }
  }

  async function processFitFileAtPath(filePath, uid, originalFileName, shareConfig = null) {
    const buffer = await fs.promises.readFile(filePath);
    const parsed = await parseFitBuffer(buffer);

    await persistParsedWorkout(parsed, {
      uid,
      entryName: originalFileName || path.basename(filePath),
      shareConfig
    });
  }



  async function processLocalZipFile(jobId, zipPath, uid, shareConfig = null) {
    await processLocalBatch(jobId, [zipPath], uid, [path.basename(zipPath)], shareConfig);
  }

  async function countFitEntries(filePath) {
    const lowerPath = filePath.toLowerCase();

    if (lowerPath.endsWith(".fit")) {
      return 1;
    }

    if (lowerPath.endsWith(".zip")) {
      const zipDirectory = await unzipper.Open.file(filePath);
      return zipDirectory.files.filter((entry) =>
        entry.type === "File" &&
        entry.path.toLowerCase().endsWith(".fit") &&
        (!entry.path.startsWith("__MACOSX/"))
      ).length;
    }

    return 0;
  }

  async function processLocalBatch(jobId, files, uid, originalFileNames = [], shareConfig = null) {
    const batchTrace = createBatchTrace("worker.process-local-batch", {
      jobId,
      uid,
      inputCount: files.length
    });
    await updateImportJob(jobId, {
      status: "processing",
      stage: "reading_zip",
      progressPercent: 10
    });

    const totalFilesPerInput = await Promise.all(files.map((filePath) => countFitEntries(filePath)));
    const totalFiles = totalFilesPerInput.reduce((sum, count) => sum + count, 0);
    const fileStatuses = [];

    for (let i = 0; i < files.length; i += 1) {
      const filePath = files[i];
      const originalFileName = originalFileNames[i] || path.basename(filePath);
      const lowerPath = filePath.toLowerCase();

      if (lowerPath.endsWith(".fit")) {
        fileStatuses.push(buildFileStatusEntry({
          entryName: originalFileName
        }));
        continue;
      }

      if (lowerPath.endsWith(".zip")) {
        const zipDirectory = await unzipper.Open.file(filePath);
        const fitEntries = zipDirectory.files.filter((entry) =>
          entry.type === "File" &&
          entry.path.toLowerCase().endsWith(".fit") &&
          (!entry.path.startsWith("__MACOSX/"))
        );

        fitEntries.forEach((entry) => {
          fileStatuses.push(buildFileStatusEntry({
            sourceName: originalFileName,
            entryName: entry.path
          }));
        });
      }
    }

    const allowance = await EntitlementService.checkAllowance(uid, "stored_workout", totalFiles);
    if (!allowance.allowed) {
      await updateImportJob(jobId, {
        status: "failed",
        stage: "failed",
        fileStatuses,
        totalFiles,
        processedFiles: 0,
        failedFiles: 0,
        errorMessage: `Stored workout limit reached for your ${allowance.tierCode} tier. ${allowance.used}/${allowance.limitValue} already used, ${totalFiles} incoming.`
      });
      throw new Error(`Stored workout limit reached for your ${allowance.tierCode} tier.`);
    }
    batchTrace.checkpoint({
      phase: "counted-inputs",
      totalFiles
    });

    await updateImportJob(jobId, {
      stage: "parsing_fit_files",
      fileStatuses,
      totalFiles,
      processedFiles: 0,
      failedFiles: 0,
      progressPercent: totalFiles > 0 ? 15 : 100
    });

    logImportEvent("job.started", {
      importJobId: jobId,
      uid,
      inputCount: files.length,
      totalFiles
    });

    try {
      const batchItems = [];

      for (let i = 0; i < files.length; i += 1) {
        const filePath = files[i];
        const originalFileName = originalFileNames[i] || path.basename(filePath);
        const lowerPath = filePath.toLowerCase();

        if (lowerPath.endsWith(".fit")) {
          batchItems.push({
            key: createFileStatusKey(null, originalFileName),
            sourceName: null,
            entryName: originalFileName,
            localPath: filePath
          });
          continue;
        }

        if (lowerPath.endsWith(".zip")) {
          const extractedBatchItems = await extractZipEntriesToBatchItems(filePath, originalFileName);
          batchItems.push(...extractedBatchItems);
          await fs.promises.rm(filePath, { force: true });
        }
      }

      batchTrace.checkpoint({
        phase: "materialized-batch-items",
        totalBatchItems: batchItems.length
      });

      logImportEvent("batch-items.materialized", {
        importJobId: jobId,
        totalBatchItems: batchItems.length
      });

      await runParallelImportBatches({
        jobId,
        uid,
        shareConfig,
        batchItems,
        fileStatuses,
        totalFiles,
        batchTrace,
        mode: "parallel-fit-and-zip-batches"
      });
    } catch (error) {
      await Promise.all(files.map((filePath) => fs.promises.rm(filePath, { force: true }).catch(() => {})));
      batchTrace.flush({
        phase: "failed",
        totalFiles,
        error: error.message
      });
      logImportEvent("job.failed", {
        importJobId: jobId,
        totalFiles,
        error: error.message
      });
      throw error;
    }
  }

  async function processImportJob(importJobId, shareConfig = null) {
    const importJob = await getImportJobById(importJobId);

    if (!importJob) {
      throw new Error(`Import job not found: ${importJobId}`);
    }

    const localPaths = Array.isArray(importJob.localPaths) ? importJob.localPaths : null;
    const localPath = importJob.localPath;
    const originalFileNames = Array.isArray(importJob.originalFileNames) ? importJob.originalFileNames : null;
    const originalFileName = importJob.originalFileName;
    const lowerLocalPath = localPath?.toLowerCase?.();
    const uid = importJob.uid;

    try {
      if (localPaths?.length) {
        await processLocalBatch(importJobId, localPaths, uid, originalFileNames || [], shareConfig);
        return;
      }

      if (lowerLocalPath?.endsWith(".fit")) {
        await processSingleLocalFitFile(importJobId, localPath, uid, originalFileName, shareConfig);
        return;
      }

      if (lowerLocalPath?.endsWith(".zip")) {
        await processLocalZipFile(importJobId, localPath, uid, shareConfig);
        return;
      }

      throw new Error(`Unsupported file type for import job: ${importJobId}`);
    } catch (error) {
      await updateImportJob(importJobId, {
        status: "failed",
        stage: "failed",
        errorMessage: error.message || "Unknown import error"
      });

      throw error;
    }
  }

  if (enableImportWorker) {
    const worker = new Worker(
      "fit-imports",
      async (job) => {
        const {
          jobId,
          shareMode = "private",
          groupIds = []
        } = job.data ?? {};

        if (!jobId) {
          throw new Error("Queue job has no jobId");
        }

        await processImportJob(jobId, {
          shareMode,
          groupIds
        });
      },
      {
        connection: redisConnection,
        concurrency: 2
      }
    );

    worker.on("ready", () => {
      console.log("Import worker is ready");
    });

    worker.on("completed", (job) => {
      logImportEvent("queue-job.completed", {
        queueJobId: job.id,
        importJobId: job.data?.jobId
      });
    });

    worker.on("failed", (job, error) => {
      console.error("[import] queue-job.failed", {
        queueJobId: job?.id,
        importJobId: job?.data?.jobId,
        error: error.message
      });
    });

    worker.on("error", (error) => {
      console.error("Import worker error", error);
    });
  }

  if (enableImportBatchWorker) {
    const importBatchWorker = new Worker(
      "fit-import-batches",
      async (job) => {
        return await processFitBatchItems(job);
      },
      {
        connection: redisConnection,
        concurrency: 2
      }
    );

    importBatchWorker.on("ready", () => {
      console.log("Import batch worker is ready");
    });

    importBatchWorker.on("completed", (job) => {
      logImportEvent("batch.completed", {
        queueJobId: job.id,
        importJobId: job.data?.importJobId,
        batchIndex: job.data?.batchIndex,
        itemCount: Array.isArray(job.data?.batchItems) ? job.data.batchItems.length : 0
      });
    });

    importBatchWorker.on("failed", (job, error) => {
      logImportEvent("batch.failed", {
        queueJobId: job?.id,
        importJobId: job?.data?.importJobId,
        batchIndex: job?.data?.batchIndex,
        error: error.message
      });
    });

    importBatchWorker.on("error", (error) => {
      console.error("Import batch worker error", error);
    });
  }

  if (enableSegmentBestEffortsWorker) {
    const segmentBestEffortsWorker = new Worker(
      "segment-best-efforts",
      async (job) => {
        if (job.name === "process-workout-segment-best-efforts") {
          return await processWorkoutSegmentBestEffortsJob(job);
        }

        const { uid, segmentIds } = job.data ?? {};

        if (!uid || !Array.isArray(segmentIds) || segmentIds.length === 0) {
          throw new Error("Segment best-efforts queue job is missing uid or segmentIds");
        }

        await processSegmentBestEffortsJob(uid, segmentIds);
      },
      {
        connection: redisConnection,
        concurrency: 1
      }
    );

    segmentBestEffortsWorker.on("ready", () => {
      console.log("Segment best-efforts worker is ready");
    });

    segmentBestEffortsWorker.on("completed", (job) => {
      logPostProcessEvent("segment-best-efforts.queue-job.completed", {
        queueJobId: job.id,
        uid: job.data?.uid,
        workoutId: job.data?.workoutId ?? null,
        segmentIds: job.data?.segmentIds
      });
    });

    segmentBestEffortsWorker.on("failed", (job, error) => {
      logPostProcessEvent("segment-best-efforts.failed", {
        queueJobId: job?.id,
        uid: job?.data?.uid,
        workoutId: job?.data?.workoutId ?? null,
        segmentIds: job?.data?.segmentIds ?? null,
        error: error.message
      });
      console.error("[postprocess] segment-best-efforts.queue-job.failed", {
        queueJobId: job?.id,
        segmentIds: job?.data?.segmentIds,
        error: error.message
      });
    });

    segmentBestEffortsWorker.on("error", (error) => {
      console.error("Segment best-efforts worker error", error);
    });
  }

  if (enableWorkoutSimilarityWorker) {
    const workoutSimilarityWorker = new Worker(
      "workout-similarity",
      async (job) => {
        if (job.name === "classify-workout-similarity") {
          return await processWorkoutSimilarityClassificationJob(job);
        }

        return await processWorkoutSimilarityRebuildJob(job);
      },
      {
        connection: redisConnection,
        concurrency: 1
      }
    );

    workoutSimilarityWorker.on("ready", () => {
      console.log("Workout similarity worker is ready");
    });

    workoutSimilarityWorker.on("completed", (job) => {
      logPostProcessEvent("similarity.queue-job.completed", {
        queueJobId: job.id,
        uid: job.data?.uid,
        workoutId: job.data?.workoutId ?? null,
        mode: job.data?.mode ?? null
      });
    });

    workoutSimilarityWorker.on("failed", (job, error) => {
      logPostProcessEvent("similarity.failed", {
        queueJobId: job?.id,
        uid: job?.data?.uid,
        workoutId: job?.data?.workoutId ?? null,
        mode: job?.data?.mode ?? null,
        error: error.message
      });
      console.error("[postprocess] similarity.queue-job.failed", {
        queueJobId: job?.id,
        uid: job?.data?.uid,
        error: error.message
      });
    });

    workoutSimilarityWorker.on("error", (error) => {
      console.error("Workout similarity worker error", error);
    });
  }

}
