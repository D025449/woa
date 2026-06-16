import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import util from "node:util";

import { Worker } from "bullmq";
import unzipper from "unzipper";
import {
  processFitRecords,
  mapAggregatedToFileRow
} from "../services/fitService.js";
import { getFitParserVariant, parseFitBuffer } from "../services/fit-parser-dispatch-service.js";
import Workout from "../shared/Workout.js";
import IntervalDetector from "../shared/IntervalDetector.js";
import BestEffortDetector from "../shared/BestEffortDetector.js";
import SegmentService from "../shared/SegmentService.js";

import { FileDBService } from "../services/fileDBService.js";
import SegmentDBService from "../services/segmentDBService.js";
import EntitlementService from "../services/entitlementService.js";
import WorkoutSharingService from "../services/workoutSharingService.js";
import WorkoutThumbnailService from "../services/workoutThumbnailService.js";
import WorkoutSimilarityService from "../services/workoutSimilarityService.js";
import { enqueueWorkoutSimilarityClassification } from "../services/workout-similarity-job-service.js";
import { enqueueImportBatchJobs } from "../services/import-batch-job-service.js";
import {
  enqueueWorkoutSegmentBestEfforts,
  enqueueWorkoutSegmentPersistence,
  enqueueWorkoutThumbnailGeneration
} from "../services/segment-best-efforts-service.js";

import { redisConnection } from "../queue/connection.js";
import {
  appendImportJobPostprocessTarget,
  getImportJobById,
  updateImportJob
} from "../db/import-jobs-repo.js";
import CollaborationDBService from "../services/collaborationDBService.js";
import {
  getFilesystemCapacitySnapshot,
  getImportUploadDir,
  getSegmentPersistTempDir,
  getThumbnailTempDir
} from "../config/storagePaths.js";
import pool from "../services/database.js";

export async function createApp(options = {}) {
  const IMPORT_BATCH_SIZE = 10;
  const SEGMENT_PERSIST_TEMP_DIR = getSegmentPersistTempDir();
  const THUMBNAIL_TEMP_DIR = getThumbnailTempDir();
  const IMPORT_UPLOAD_TEMP_DIR = getImportUploadDir();
  const IMPORT_QUEUE_CONCURRENCY = Math.max(1, Number(process.env.IMPORT_QUEUE_CONCURRENCY) || 2);
  const IMPORT_BATCH_WORKER_CONCURRENCY = Math.max(1, Number(process.env.IMPORT_BATCH_WORKER_CONCURRENCY) || 2);
  const IMPORT_DB_BULK_INSERT_SIZE = Math.max(1, Number(process.env.IMPORT_DB_BULK_INSERT_SIZE) || 20);
  const IMPORT_POSTPROCESS_MODE = String(process.env.IMPORT_POSTPROCESS_MODE || "immediate").trim().toLowerCase() === "phased"
    ? "phased"
    : "immediate";
  const FEATURE_THUMBNAILS_ON_DEMAND = String(process.env.FEATURE_THUMBNAILS_ON_DEMAND || "1").trim() !== "0";
  const IMPORT_TIMING_DEBUG = String(process.env.IMPORT_TIMING_DEBUG || "").trim() === "1";
  const IMPORT_VERBOSE_LOGS = String(process.env.IMPORT_VERBOSE_LOGS || "").trim() === "1";
  const IMPORT_POSTPROCESS_LOGS = String(process.env.IMPORT_POSTPROCESS_LOGS || "").trim() !== "0";
  const IMPORT_POSTPROCESS_PROFILE_LOG = String(process.env.IMPORT_POSTPROCESS_PROFILE_LOG || "1").trim() !== "0";
  const IMPORT_POSTPROCESS_PROFILE_EVERY = Math.max(1, Number(process.env.IMPORT_POSTPROCESS_PROFILE_EVERY) || 25);
  const IMPORT_SYNC_PROFILE_LOG = String(process.env.IMPORT_SYNC_PROFILE_LOG || "1").trim() !== "0";
  const SEGMENTS_RECOMPUTE_FROM_DB = String(process.env.SEGMENTS_RECOMPUTE_FROM_DB || "").trim() === "1";
  const {
    enableImportWorker = true,
    enableImportBatchWorker = true,
    enableSegmentBestEffortsWorker = true,
    enableWorkoutSimilarityWorker = true
  } = options;

  console.log("[import] bootstrap.config", {
    enableImportWorker,
    enableImportBatchWorker,
    enableSegmentBestEffortsWorker,
    enableWorkoutSimilarityWorker,
    IMPORT_POSTPROCESS_MODE,
    IMPORT_TIMING_DEBUG,
    IMPORT_VERBOSE_LOGS,
    IMPORT_POSTPROCESS_LOGS,
    IMPORT_POSTPROCESS_PROFILE_LOG,
    IMPORT_POSTPROCESS_PROFILE_EVERY,
    IMPORT_SYNC_PROFILE_LOG,
    SEGMENTS_RECOMPUTE_FROM_DB,
    IMPORT_QUEUE_CONCURRENCY,
    IMPORT_BATCH_WORKER_CONCURRENCY,
    IMPORT_DB_BULK_INSERT_SIZE,
    FIT_PARSER_VARIANT: getFitParserVariant(),
    IMPORT_UPLOAD_TEMP_DIR,
    SEGMENT_PERSIST_TEMP_DIR,
    THUMBNAIL_TEMP_DIR,
    GPS_IMPORT_DEBUG: String(process.env.GPS_IMPORT_DEBUG || "").trim() === "1",
    ALTITUDE_IMPORT_DEBUG: String(process.env.ALTITUDE_IMPORT_DEBUG || "").trim() === "1",
    SIMILARITY_DEBUG: String(process.env.SIMILARITY_DEBUG || "").trim() === "1"
  });

  getFilesystemCapacitySnapshot(IMPORT_UPLOAD_TEMP_DIR).then((snapshot) => {
    console.log("[import] storage.temp-dir", snapshot);
  });

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

  function logPostProcessEvent(type, payload = {}) {
    if (!IMPORT_POSTPROCESS_LOGS) {
      return;
    }
    console.log(`[postprocess] ${type} ${formatLogPayload(payload)}`);
  }

  function logPostProcessProfileEvent(type, payload = {}) {
    if (!IMPORT_POSTPROCESS_PROFILE_LOG) {
      return;
    }
    console.log(`[postprocess] ${type} ${formatLogPayload(payload)}`);
  }

  function logVerboseImportEvent(type, payload = {}) {
    if (!IMPORT_VERBOSE_LOGS) {
      return;
    }
    logImportEvent(type, payload);
  }

  const postprocessProfiles = new Map();
  const importPostprocessRuns = new Map();

  function getPostprocessProfile(type) {
    if (!postprocessProfiles.has(type)) {
      postprocessProfiles.set(type, {
        count: 0,
        totalMs: 0,
        durationsMs: [],
        metricsTotals: {}
      });
    }
    return postprocessProfiles.get(type);
  }

  function computePercentile(sortedValues, ratio) {
    if (!Array.isArray(sortedValues) || sortedValues.length === 0) {
      return 0;
    }
    const index = Math.min(sortedValues.length - 1, Math.max(0, Math.floor(sortedValues.length * ratio)));
    return sortedValues[index] ?? 0;
  }

  function recordPostprocessProfile(type, elapsedMs, metrics = {}) {
    const profile = getPostprocessProfile(type);
    profile.count += 1;
    profile.totalMs += Number(elapsedMs || 0);
    profile.durationsMs.push(Number(elapsedMs || 0));
    if (profile.durationsMs.length > 200) {
      profile.durationsMs.shift();
    }

    for (const [metricName, metricValue] of Object.entries(metrics || {})) {
      const numericValue = Number(metricValue || 0);
      profile.metricsTotals[metricName] = Number(profile.metricsTotals[metricName] || 0) + numericValue;
    }
  }

  function createImportPostprocessPhaseState(expected = 0) {
    let resolveCompletion;
    const completionPromise = new Promise((resolve) => {
      resolveCompletion = resolve;
    });
    if (Number(expected || 0) === 0) {
      resolveCompletion();
    }
    return {
      expected: Number(expected || 0),
      completed: 0,
      failed: 0,
      totalMs: 0,
      metricsTotals: {},
      durationsMs: [],
      wallStartedAt: null,
      wallCompletedAt: null,
      completionPromise,
      resolveCompletion,
      completionResolved: Number(expected || 0) === 0,
      completedLogged: expected === 0
    };
  }

  function getImportPostprocessRun(importJobId) {
    if (!importJobId) {
      return null;
    }
    return importPostprocessRuns.get(String(importJobId)) || null;
  }

  function summarizeImportPostprocessPhase(phaseState) {
    const durations = [...phaseState.durationsMs].sort((a, b) => a - b);
    const successfulCount = Math.max(0, phaseState.completed);
    const avgMs = successfulCount > 0 ? phaseState.totalMs / successfulCount : 0;
    const avgMetrics = {};

    for (const [metricName, totalValue] of Object.entries(phaseState.metricsTotals || {})) {
      avgMetrics[metricName] = successfulCount > 0
        ? Math.round((Number(totalValue || 0) / successfulCount) * 1000) / 1000
        : 0;
    }

    return {
      expected: phaseState.expected,
      completed: phaseState.completed,
      failed: phaseState.failed,
      wallMs: phaseState.wallStartedAt && phaseState.wallCompletedAt
        ? phaseState.wallCompletedAt - phaseState.wallStartedAt
        : 0,
      totalMs: Math.round(phaseState.totalMs * 1000) / 1000,
      avgMs: Math.round(avgMs * 1000) / 1000,
      minMs: durations[0] ?? 0,
      p50Ms: computePercentile(durations, 0.5),
      p95Ms: computePercentile(durations, 0.95),
      maxMs: durations[durations.length - 1] ?? 0,
      avgMetrics
    };
  }

  function finalizeImportPostprocessRun(importJobId) {
    const run = getImportPostprocessRun(importJobId);
    if (!run) {
      return;
    }

    const phaseEntries = Object.entries(run.phases);
    const allDone = phaseEntries.every(([, phaseState]) => {
      const finishedCount = phaseState.completed + phaseState.failed;
      const expectedDone = finishedCount >= phaseState.expected;
      const wallDone = phaseState.expected === 0 || !!phaseState.wallCompletedAt;
      return expectedDone && wallDone;
    });

    if (!allDone) {
      return;
    }

    const phases = {};
    for (const [phaseType, phaseState] of phaseEntries) {
      phases[phaseType] = summarizeImportPostprocessPhase(phaseState);
    }

    logPostProcessProfileEvent("import.profile.completed", {
      importJobId: String(importJobId),
      targetCount: run.targetCount,
      totalWallMs: Date.now() - run.startedAt,
      phases
    });

    importPostprocessRuns.delete(String(importJobId));
  }

  function recordImportPostprocessOutcome(importJobId, type, elapsedMs, metrics = {}, failed = false) {
    const run = getImportPostprocessRun(importJobId);
    if (!run) {
      return;
    }

    const phaseState = run.phases[type];
    if (!phaseState) {
      return;
    }

    if (failed) {
      phaseState.failed += 1;
    } else {
      phaseState.completed += 1;
      phaseState.totalMs += Number(elapsedMs || 0);
      phaseState.durationsMs.push(Number(elapsedMs || 0));
      if (phaseState.durationsMs.length > 200) {
        phaseState.durationsMs.shift();
      }
      for (const [metricName, metricValue] of Object.entries(metrics || {})) {
        phaseState.metricsTotals[metricName] = Number(phaseState.metricsTotals[metricName] || 0) + Number(metricValue || 0);
      }
    }

    const finishedCount = phaseState.completed + phaseState.failed;
    if (!phaseState.completionResolved && finishedCount >= phaseState.expected) {
      phaseState.completionResolved = true;
      phaseState.resolveCompletion?.();
    }

  }

  function registerImportPostprocessRun(importJobId, targets = []) {
    if (!importJobId) {
      return null;
    }

    const normalizedImportJobId = String(importJobId);
    const expected = {
      "segment-persist": 0,
      "similarity": 0,
      "segment-best-efforts": 0
    };

    for (const target of Array.isArray(targets) ? targets : []) {
      const shouldPersistSegments = !!target?.recomputeSegmentsFromDb || (!!target?.hasSegments && !!target?.segmentPayloadPath);
      if (shouldPersistSegments) {
        expected["segment-persist"] += 1;
      }
      if (target?.validGps) {
        expected.similarity += 1;
        expected["segment-best-efforts"] += 1;
      }
    }

    const run = {
      importJobId: normalizedImportJobId,
      targetCount: Array.isArray(targets) ? targets.length : 0,
      startedAt: Date.now(),
      phases: {
        "segment-persist": createImportPostprocessPhaseState(expected["segment-persist"]),
        similarity: createImportPostprocessPhaseState(expected.similarity),
        "segment-best-efforts": createImportPostprocessPhaseState(expected["segment-best-efforts"])
      }
    };

    importPostprocessRuns.set(normalizedImportJobId, run);
    return run;
  }

  function markImportPostprocessPhaseStarted(importJobId, type) {
    const run = getImportPostprocessRun(importJobId);
    const phaseState = run?.phases?.[type];
    if (!phaseState || phaseState.wallStartedAt) {
      return;
    }
    phaseState.wallStartedAt = Date.now();
    if (phaseState.expected === 0) {
      phaseState.wallCompletedAt = phaseState.wallStartedAt;
    }
  }

  function markImportPostprocessPhaseCompleted(importJobId, type) {
    const run = getImportPostprocessRun(importJobId);
    const phaseState = run?.phases?.[type];
    if (!phaseState) {
      return;
    }
    if (!phaseState.wallStartedAt) {
      phaseState.wallStartedAt = Date.now();
    }
    phaseState.wallCompletedAt = Date.now();
  }

  function logImportPostprocessPhaseSummary(importJobId, type) {
    const run = getImportPostprocessRun(importJobId);
    const phaseState = run?.phases?.[type];
    if (!run || !phaseState) {
      return;
    }

    logPostProcessProfileEvent(`${type}.profile.completed`, {
      importJobId: String(importJobId),
      targetCount: run.targetCount,
      ...summarizeImportPostprocessPhase(phaseState)
    });
  }

  async function waitForImportPostprocessPhaseCompletion(importJobId, type) {
    const run = getImportPostprocessRun(importJobId);
    const phaseState = run?.phases?.[type];
    if (!phaseState) {
      return;
    }
    await phaseState.completionPromise;
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
      processFitAggregateSessionsMs: 0,
      processFitSortRecordsMs: 0,
      processFitFillGapsMs: 0,
      processFitCleanAltitudeMs: 0,
      processFitCleanGpsBuildTrackMs: 0,
      processFitCleanGpsCopySourceArraysMs: 0,
      processFitCleanGpsCleanPassMs: 0,
      processFitCleanGpsNeighborIndexMs: 0,
      processFitCleanGpsInterpolatePassMs: 0,
      processFitCleanGpsBuildTrackSubstepMs: 0,
      processFitCleanGpsTrackHashMs: 0,
      processFitWorkoutFromRecordsMs: 0,
      processFitDetectAutoSegmentsMs: 0,
      processFitDetectBestEffortsMs: 0,
      processFitMergeSegmentsMs: 0,
      mapAggregatedRowMs: 0,
      insertFileMs: 0,
      insertToCompressedBufferMs: 0,
      insertBuildGeometryWktMs: 0,
      insertBeginTransactionMs: 0,
      insertInsertWorkoutRowMs: 0,
      insertCommitMs: 0,
      insertRollbackMs: 0,
      enqueueSegmentPersistenceMs: 0,
      enqueueSegmentPersistenceStatusUpdateMs: 0,
      enqueueSegmentPersistenceSerializeMs: 0,
      enqueueSegmentPersistenceWriteFileMs: 0,
      enqueueSegmentPersistenceQueueMs: 0,
      classifySimilarWorkoutsMs: 0,
      shareWorkoutMs: 0,
      createFeedEventsMs: 0,
      getMatchingSegmentCandidatesMs: 0,
      matchSegmentsMs: 0,
      storeSegmentBestEffortsMs: 0
    };

    return {
      totals,
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

  function summarizeSyncProfile(totals = {}, extra = {}) {
    const safe = (key) => Number(totals?.[key] || 0);
    const syncTotalMs =
      safe("entryBufferMs") +
      safe("parseFitMs") +
      safe("processFitRecordsMs") +
      safe("mapAggregatedRowMs") +
      safe("insertFileMs") +
      safe("renderThumbnailMs") +
      safe("shareWorkoutMs") +
      safe("createFeedEventsMs") +
      safe("enqueueSegmentPersistenceMs");

    const processedFiles = Number(extra?.processedFiles || 0);

    return {
      totalFiles: Number(extra?.totalFiles || 0),
      processedFiles,
      failedFiles: Number(extra?.failedFiles || 0),
      syncTotalMs,
      avgPerProcessedFileMs: processedFiles > 0
        ? Math.round(syncTotalMs / processedFiles)
        : 0,
      breakdownMs: {
        readFileMs: safe("entryBufferMs"),
        parseFitMs: safe("parseFitMs"),
        processFitRecordsMs: safe("processFitRecordsMs"),
        processFitStepsMs: {
          aggregateSessionsMs: safe("processFitAggregateSessionsMs"),
          sortRecordsMs: safe("processFitSortRecordsMs"),
          fillGapsMs: safe("processFitFillGapsMs"),
          cleanAltitudeMs: safe("processFitCleanAltitudeMs"),
          cleanGpsBuildTrackMs: safe("processFitCleanGpsBuildTrackMs"),
          cleanGpsBuildTrackSubstepsMs: {
            copySourceArraysMs: safe("processFitCleanGpsCopySourceArraysMs"),
            cleanPassMs: safe("processFitCleanGpsCleanPassMs"),
            neighborIndexMs: safe("processFitCleanGpsNeighborIndexMs"),
            interpolatePassMs: safe("processFitCleanGpsInterpolatePassMs"),
            buildTrackMs: safe("processFitCleanGpsBuildTrackSubstepMs"),
            trackHashMs: safe("processFitCleanGpsTrackHashMs")
          },
          workoutFromRecordsMs: safe("processFitWorkoutFromRecordsMs"),
          detectAutoSegmentsMs: safe("processFitDetectAutoSegmentsMs"),
          detectBestEffortsMs: safe("processFitDetectBestEffortsMs"),
          mergeSegmentsMs: safe("processFitMergeSegmentsMs")
        },
        mapAggregatedRowMs: safe("mapAggregatedRowMs"),
        insertWorkoutMs: safe("insertFileMs"),
        insertWorkoutStepsMs: {
          toCompressedBufferMs: safe("insertToCompressedBufferMs"),
          buildGeometryWktMs: safe("insertBuildGeometryWktMs"),
          beginTransactionMs: safe("insertBeginTransactionMs"),
          insertWorkoutRowMs: safe("insertInsertWorkoutRowMs"),
          commitMs: safe("insertCommitMs"),
          rollbackMs: safe("insertRollbackMs")
        },
        thumbnailMs: safe("renderThumbnailMs"),
        shareWorkoutMs: safe("shareWorkoutMs"),
        createFeedEventsMs: safe("createFeedEventsMs"),
        enqueueSegmentPersistenceMs: safe("enqueueSegmentPersistenceMs"),
        enqueueSegmentPersistenceStepsMs: {
          statusUpdateMs: safe("enqueueSegmentPersistenceStatusUpdateMs"),
          serializeMs: safe("enqueueSegmentPersistenceSerializeMs"),
          writeFileMs: safe("enqueueSegmentPersistenceWriteFileMs"),
          queueMs: safe("enqueueSegmentPersistenceQueueMs")
        }
      }
    };
  }

  function createFileStatusKey(sourceName, entryName) {
    return `${sourceName || ""}::${entryName || ""}`;
  }

  async function writeSegmentPersistencePayload({ uid, workoutId, entryName = null, segments = [] }) {
    await fs.promises.mkdir(SEGMENT_PERSIST_TEMP_DIR, { recursive: true });
    const payloadPath = path.join(
      SEGMENT_PERSIST_TEMP_DIR,
      `${uid}-${workoutId}-${crypto.randomUUID()}.json`
    );

    const serializeStartedAt = Date.now();
    const payload = JSON.stringify({
      uid,
      workoutId,
      entryName,
      segments
    });
    const serializeMs = Date.now() - serializeStartedAt;

    const writeStartedAt = Date.now();
    await fs.promises.writeFile(payloadPath, payload);
    const writeFileMs = Date.now() - writeStartedAt;

    return {
      payloadPath,
      serializeMs,
      writeFileMs
    };
  }

  async function writeThumbnailPayload({ uid, workoutId, entryName = null, gpsTrack = null, workoutObject = null }) {
    await fs.promises.mkdir(THUMBNAIL_TEMP_DIR, { recursive: true });
    const payloadPath = path.join(
      THUMBNAIL_TEMP_DIR,
      `${uid}-${workoutId}-${crypto.randomUUID()}.json`
    );

    const extractedSeries = !Array.isArray(gpsTrack) || gpsTrack.length < 2
      ? WorkoutThumbnailService.extractThumbnailSeries(workoutObject)
      : { altitudes: [], powers: [] };

    await fs.promises.writeFile(payloadPath, JSON.stringify({
      uid,
      workoutId,
      entryName,
      gpsTrack: Array.isArray(gpsTrack) ? gpsTrack : null,
      altitudes: extractedSeries.altitudes,
      powers: extractedSeries.powers
    }));

    return payloadPath;
  }

  async function readSegmentPersistencePayload(payloadPath) {
    const raw = await fs.promises.readFile(payloadPath, "utf8");
    return JSON.parse(raw);
  }

  async function cleanupSegmentPersistencePayload(payloadPath) {
    if (!payloadPath) {
      return;
    }

    await fs.promises.rm(payloadPath, { force: true }).catch(() => {});
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

  function createPostprocessTarget({
    uid,
    workoutId,
    entryName = null,
    validGps = false,
    hasSegments = false,
    segmentPayloadPath = null,
    recomputeSegmentsFromDb = false
  }) {
    return {
      uid,
      workoutId,
      entryName,
      validGps: !!validGps,
      hasSegments: !!hasSegments,
      segmentPayloadPath,
      recomputeSegmentsFromDb: !!recomputeSegmentsFromDb
    };
  }

  async function appendDeferredPostprocessTarget(importJobId, target) {
    await appendImportJobPostprocessTarget(importJobId, target);
    logVerboseImportEvent("postprocess-target.collected", {
      importJobId,
      workoutId: target.workoutId,
      entryName: target.entryName || null,
      validGps: !!target.validGps,
      hasSegments: !!target.hasSegments
    });
  }

  async function enqueueImmediatePostprocessTarget(target, importJobId = null) {
    const { uid, workoutId, entryName, validGps, hasSegments, segmentPayloadPath, recomputeSegmentsFromDb } = target;

    if (recomputeSegmentsFromDb) {
      await enqueueWorkoutSegmentPersistence({
        uid,
        workoutId,
        entryName: entryName || null,
        recomputeFromDb: true,
        importJobId
      });
    } else if (hasSegments && segmentPayloadPath) {
      await enqueueWorkoutSegmentPersistence({
        uid,
        workoutId,
        payloadPath: segmentPayloadPath,
        entryName: entryName || null,
        importJobId
      });
    } else {
      await FileDBService.updateWorkoutSegmentProcessingStatus(uid, workoutId, "completed", null);
    }

    if (validGps) {
      await enqueueWorkoutSimilarityClassification({
        uid,
        workoutId,
        importJobId
      });

      await enqueueWorkoutSegmentBestEfforts({
        uid,
        workoutId,
        importJobId
      });
    }
  }

  async function runDeferredPostprocessPhase(importJobId, phaseType, targets = []) {
    const normalizedTargets = Array.isArray(targets) ? targets.filter(Boolean) : [];
    markImportPostprocessPhaseStarted(importJobId, phaseType);

    if (phaseType === "segment-persist") {
      for (const target of normalizedTargets) {
        const { uid, workoutId, entryName, hasSegments, segmentPayloadPath, recomputeSegmentsFromDb } = target;
        if (recomputeSegmentsFromDb) {
          await enqueueWorkoutSegmentPersistence({
            uid,
            workoutId,
            entryName: entryName || null,
            recomputeFromDb: true,
            importJobId
          });
          continue;
        }

        if (hasSegments && segmentPayloadPath) {
          await enqueueWorkoutSegmentPersistence({
            uid,
            workoutId,
            payloadPath: segmentPayloadPath,
            entryName: entryName || null,
            importJobId
          });
          continue;
        }

        await FileDBService.updateWorkoutSegmentProcessingStatus(uid, workoutId, "completed", null);
      }

      await waitForImportPostprocessPhaseCompletion(importJobId, phaseType);
      markImportPostprocessPhaseCompleted(importJobId, phaseType);
      logImportPostprocessPhaseSummary(importJobId, phaseType);
      return;
    }

    if (phaseType === "segment-best-efforts") {
      for (const target of normalizedTargets) {
        const { uid, workoutId, validGps } = target;
        if (!validGps) {
          continue;
        }
        await enqueueWorkoutSegmentBestEfforts({
          uid,
          workoutId,
          importJobId
        });
      }

      await waitForImportPostprocessPhaseCompletion(importJobId, phaseType);
      markImportPostprocessPhaseCompleted(importJobId, phaseType);
      logImportPostprocessPhaseSummary(importJobId, phaseType);
      return;
    }

    if (phaseType === "similarity") {
      for (const target of normalizedTargets) {
        const { uid, workoutId, validGps } = target;
        if (!validGps) {
          continue;
        }
        await enqueueWorkoutSimilarityClassification({
          uid,
          workoutId,
          importJobId
        });
      }

      await waitForImportPostprocessPhaseCompletion(importJobId, phaseType);
      markImportPostprocessPhaseCompleted(importJobId, phaseType);
      logImportPostprocessPhaseSummary(importJobId, phaseType);
    }
  }

  async function handlePostprocessScheduling(importJobId, target) {
    if (IMPORT_POSTPROCESS_MODE === "phased" && importJobId) {
      await appendDeferredPostprocessTarget(importJobId, target);
      return;
    }

    await enqueueImmediatePostprocessTarget(target, importJobId || null);
  }

  async function flushDeferredPostprocessTargets(importJobId, explicitTargets = null) {
    let resolvedTargets = Array.isArray(explicitTargets) ? explicitTargets : null;
    if (!resolvedTargets) {
      const importJob = await getImportJobById(importJobId);
      resolvedTargets = Array.isArray(importJob?.postprocessTargets)
        ? importJob.postprocessTargets
        : [];
    }

    logImportEvent("phase.sync-import.completed", {
      importJobId,
      targetCount: resolvedTargets.length,
      mode: IMPORT_POSTPROCESS_MODE
    });

    registerImportPostprocessRun(importJobId, resolvedTargets);
    await runDeferredPostprocessPhase(importJobId, "segment-persist", resolvedTargets);
    await runDeferredPostprocessPhase(importJobId, "segment-best-efforts", resolvedTargets);
    await runDeferredPostprocessPhase(importJobId, "similarity", resolvedTargets);
    finalizeImportPostprocessRun(importJobId);

    if (!Array.isArray(explicitTargets)) {
      await updateImportJob(importJobId, {
        postprocessTargets: []
      });
    }
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
    const importJobId = job.data?.importJobId ? String(job.data.importJobId) : null;

    if (!uid || !Number.isInteger(workoutId)) {
      throw new Error("Workout similarity classification job is missing uid or workoutId");
    }

    const startedAt = Date.now();
    await job.updateProgress({
      progressPercent: 0,
      workoutId
    });

    try {
      const similarityResult = await WorkoutSimilarityService.classifySimilarGpsWorkoutsForWorkout(workoutId, uid, {
        rebuildMode: "delta"
        ,
        includeProfile: true
      });
      const edges = Array.isArray(similarityResult?.edges) ? similarityResult.edges : [];
      const similarityProfile = similarityResult?.profile || {};
      const edgeCount = edges.length;
      const elapsedMs = Date.now() - startedAt;

      await job.updateProgress({
        progressPercent: 100,
        workoutId,
        edgeCount
      });

      recordPostprocessProfile("similarity", elapsedMs, {
        edgeCount,
        candidateCount: Number(similarityProfile.candidateCount || 0),
        comparedCandidates: Number(similarityProfile.comparedCandidates || 0),
        precheckRejectedCandidates: Number(similarityProfile.precheckRejectedCandidates || 0),
        matchedCandidates: Number(similarityProfile.matchedCandidates || 0),
        loadSourceTrackMs: Number(similarityProfile.loadSourceTrackMs || 0),
        loadCandidatesMs: Number(similarityProfile.loadCandidatesMs || 0),
        deleteExistingEdgesMs: Number(similarityProfile.deleteExistingEdgesMs || 0),
        sampleSourceTrackMs: Number(similarityProfile.sampleSourceTrackMs || 0),
        candidateTrackNormalizeMs: Number(similarityProfile.candidateTrackNormalizeMs || 0),
        cheapPrecheckMs: Number(similarityProfile.cheapPrecheckMs || 0),
        sampleCandidateTrackMs: Number(similarityProfile.sampleCandidateTrackMs || 0),
        compareRouteMs: Number(similarityProfile.compareRouteMs || 0),
        compareRouteABMs: Number(similarityProfile.compareRouteABMs || 0),
        compareRouteBAMs: Number(similarityProfile.compareRouteBAMs || 0),
        scoreMs: Number(similarityProfile.scoreMs || 0),
        persistEdgeMs: Number(similarityProfile.persistEdgeMs || 0),
        rejectedByRouteAB: Number(similarityProfile.rejectedByRouteAB || 0),
        rejectedByRouteBA: Number(similarityProfile.rejectedByRouteBA || 0),
        rejectedByScore: Number(similarityProfile.rejectedByScore || 0)
      });
      recordImportPostprocessOutcome(importJobId, "similarity", elapsedMs, {
        edgeCount,
        candidateCount: Number(similarityProfile.candidateCount || 0),
        comparedCandidates: Number(similarityProfile.comparedCandidates || 0),
        precheckRejectedCandidates: Number(similarityProfile.precheckRejectedCandidates || 0),
        matchedCandidates: Number(similarityProfile.matchedCandidates || 0),
        loadSourceTrackMs: Number(similarityProfile.loadSourceTrackMs || 0),
        loadCandidatesMs: Number(similarityProfile.loadCandidatesMs || 0),
        deleteExistingEdgesMs: Number(similarityProfile.deleteExistingEdgesMs || 0),
        sampleSourceTrackMs: Number(similarityProfile.sampleSourceTrackMs || 0),
        candidateTrackNormalizeMs: Number(similarityProfile.candidateTrackNormalizeMs || 0),
        cheapPrecheckMs: Number(similarityProfile.cheapPrecheckMs || 0),
        sampleCandidateTrackMs: Number(similarityProfile.sampleCandidateTrackMs || 0),
        compareRouteMs: Number(similarityProfile.compareRouteMs || 0),
        compareRouteABMs: Number(similarityProfile.compareRouteABMs || 0),
        compareRouteBAMs: Number(similarityProfile.compareRouteBAMs || 0),
        scoreMs: Number(similarityProfile.scoreMs || 0),
        persistEdgeMs: Number(similarityProfile.persistEdgeMs || 0),
        rejectedByRouteAB: Number(similarityProfile.rejectedByRouteAB || 0),
        rejectedByRouteBA: Number(similarityProfile.rejectedByRouteBA || 0),
        rejectedByScore: Number(similarityProfile.rejectedByScore || 0)
      });

      return {
        progressPercent: 100,
        workoutId,
        edgeCount
      };
    } catch (error) {
      recordImportPostprocessOutcome(importJobId, "similarity", 0, {}, true);
      throw error;
    }
  }

  async function processWorkoutSegmentBestEffortsJob(job) {
    const uid = job.data?.uid;
    const workoutId = Number(job.data?.workoutId);
    const importJobId = job.data?.importJobId ? String(job.data.importJobId) : null;

    if (!uid || !Number.isInteger(workoutId)) {
      throw new Error("Workout segment best-efforts job is missing uid or workoutId");
    }

    const startedAt = Date.now();
    await job.updateProgress({
      progressPercent: 0,
      workoutId
    });

    try {
      const matches = await SegmentDBService.rescanSegmentBestEffortsForWorkout(uid, workoutId);
      const matchCount = Array.isArray(matches) ? matches.length : 0;
      const elapsedMs = Date.now() - startedAt;

      await job.updateProgress({
        progressPercent: 100,
        workoutId,
        matchCount
      });

      recordPostprocessProfile("segment-best-efforts", elapsedMs, {
        matchCount
      });
      recordImportPostprocessOutcome(importJobId, "segment-best-efforts", elapsedMs, {
        matchCount
      });

      return {
        progressPercent: 100,
        workoutId,
        matchCount
      };
    } catch (error) {
      recordImportPostprocessOutcome(importJobId, "segment-best-efforts", 0, {}, true);
      throw error;
    }
  }

  async function processWorkoutSegmentPersistenceJob(job) {
    const uid = job.data?.uid;
    const workoutId = Number(job.data?.workoutId);
    const payloadPath = job.data?.payloadPath;
    const recomputeFromDb = job.data?.recomputeFromDb === true;
    const importJobId = job.data?.importJobId ? String(job.data.importJobId) : null;

    if (!uid || !Number.isInteger(workoutId) || (!payloadPath && !recomputeFromDb)) {
      throw new Error("Workout segment persistence job is missing uid, workoutId, or payload source");
    }

    const startedAt = Date.now();
    await job.updateProgress({
      progressPercent: 0,
      workoutId
    });

    await FileDBService.updateWorkoutSegmentProcessingStatus(uid, workoutId, "processing", null);

    try {
      let segments = [];
      let dbReadMs = 0;
      let decompressMs = 0;
      let recordRebuildMs = 0;
      let detectAutoMs = 0;
      let detectBestEffortsMs = 0;
      let mapSegmentsMs = 0;
      let persistSegmentsMs = 0;
      let statusUpdateMs = 0;
      let cleanupMs = 0;

      if (recomputeFromDb) {
        const dbReadStartedAt = Date.now();
        const rowResult = await pool.query(
          `SELECT stream FROM workouts WHERE id = $1 AND uid = $2`,
          [workoutId, uid]
        );
        dbReadMs = Date.now() - dbReadStartedAt;
        if (rowResult.rowCount === 0) {
          throw new Error("Workout stream not found for segment recompute");
        }

        const decompressStartedAt = Date.now();
        const workout = await Workout.fromCompressed(rowResult.rows[0].stream);
        decompressMs = Date.now() - decompressStartedAt;
        const startTime = Number(workout.getStartTime());
        const rebuildStartedAt = Date.now();
        const records = new Array(workout.length);
        for (let index = 0; index < workout.length; index += 1) {
          records[index] = {
            timestamp: new Date(startTime + (index * 1000)),
            power: workout.getPowerAt(index),
            heart_rate: workout.getHrAt(index),
            cadence: workout.getCadenceAt(index),
            speed: workout.getSpeedAt(index) / 3.6,
            altitude: workout.getAltitudeAt(index),
            distance: workout.getDistanceAt(index)
          };
        }
        recordRebuildMs = Date.now() - rebuildStartedAt;

        const autoStartedAt = Date.now();
        const autoIntervals = IntervalDetector.detect(records);
        detectAutoMs = Date.now() - autoStartedAt;
        const bestEffortsStartedAt = Date.now();
        const bestEffortIntervals = BestEffortDetector.detect(records);
        detectBestEffortsMs = Date.now() - bestEffortsStartedAt;
        const mapSegmentsStartedAt = Date.now();
        segments = [
          ...SegmentService.createSgmentsFromIntervals(autoIntervals, "auto"),
          ...SegmentService.createSgmentsFromIntervals(bestEffortIntervals, "crit")
        ];
        mapSegmentsMs = Date.now() - mapSegmentsStartedAt;
      } else {
        const payload = await readSegmentPersistencePayload(payloadPath);
        segments = Array.isArray(payload?.segments) ? payload.segments : [];
      }

      const persistSegmentsStartedAt = Date.now();
      await FileDBService.upsertSegmentsBulk(uid, workoutId, segments);
      persistSegmentsMs = Date.now() - persistSegmentsStartedAt;
      const statusUpdateStartedAt = Date.now();
      await FileDBService.updateWorkoutSegmentProcessingStatus(uid, workoutId, "completed", null);
      statusUpdateMs = Date.now() - statusUpdateStartedAt;
      if (payloadPath) {
        const cleanupStartedAt = Date.now();
        await cleanupSegmentPersistencePayload(payloadPath);
        cleanupMs = Date.now() - cleanupStartedAt;
      }

      await job.updateProgress({
        progressPercent: 100,
        workoutId,
        segmentCount: segments.length
      });

      const elapsedMs = Date.now() - startedAt;
      recordPostprocessProfile("segment-persist", elapsedMs, {
        segmentCount: segments.length,
        dbReadMs,
        decompressMs,
        recordRebuildMs,
        detectAutoMs,
        detectBestEffortsMs,
        mapSegmentsMs,
        persistSegmentsMs,
        statusUpdateMs,
        cleanupMs
      });
      recordImportPostprocessOutcome(importJobId, "segment-persist", elapsedMs, {
        segmentCount: segments.length,
        dbReadMs,
        decompressMs,
        recordRebuildMs,
        detectAutoMs,
        detectBestEffortsMs,
        mapSegmentsMs,
        persistSegmentsMs,
        statusUpdateMs,
        cleanupMs
      });

      return {
        progressPercent: 100,
        workoutId,
        segmentCount: segments.length
      };
    } catch (error) {
      recordImportPostprocessOutcome(importJobId, "segment-persist", 0, {}, true);
      await FileDBService.updateWorkoutSegmentProcessingStatus(
        uid,
        workoutId,
        "failed",
        error.message || "Unknown segment persistence error"
      );
      throw error;
    }
  }

  async function processWorkoutThumbnailGenerationJob(job) {
    const uid = job.data?.uid;
    const workoutId = Number(job.data?.workoutId);
    const payloadPath = job.data?.payloadPath;

    if (!uid || !Number.isInteger(workoutId) || !payloadPath) {
      throw new Error("Workout thumbnail generation job is missing uid, workoutId, or payloadPath");
    }

    const startedAt = Date.now();
    const payload = await readSegmentPersistencePayload(payloadPath);
    const thumbnailPayload = WorkoutThumbnailService.createThumbnailPayload({
      gpsTrack: payload?.gpsTrack ?? null,
      altitudes: Array.isArray(payload?.altitudes) ? payload.altitudes : [],
      powers: Array.isArray(payload?.powers) ? payload.powers : []
    });

    if (!thumbnailPayload) {
      await cleanupSegmentPersistencePayload(payloadPath);
      return {
        progressPercent: 100,
        workoutId,
        generated: false
      };
    }

    const thumbnail = await WorkoutThumbnailService.upsertThumbnail(workoutId, thumbnailPayload);
    await cleanupSegmentPersistencePayload(payloadPath);

    recordPostprocessProfile("thumbnail", Date.now() - startedAt, {
      generated: 1
    });

    return {
      progressPercent: 100,
      workoutId,
      generated: true
    };
  }


  async function processFitJson(fitJsonObject, uid, shareConfig = null, context = {}) {
    const timing = createStepLogger("worker.process-fit-json", {
      uid
    });
    let dbrow = null;

    try {
      const { aggregated, segments, gps_track, workoutObject, importGpsSource } = processFitRecords(fitJsonObject, {
        sourceName: context.entryName || null,
        computeSegments: !SEGMENTS_RECOMPUTE_FROM_DB
      });
      timing.mark("process-fit-records", {
        segmentCount: segments?.length ?? 0,
        gpsPointCount: gps_track?.pointCount ?? gps_track?.track?.length ?? 0,
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
        const hasSegments = Array.isArray(segments) && segments.length > 0;
        const shouldRecomputeSegments = SEGMENTS_RECOMPUTE_FROM_DB;

        if (shouldRecomputeSegments) {
          try {
            await handlePostprocessScheduling(context.importJobId || null, createPostprocessTarget({
              uid,
              workoutId: dbrow.id,
              entryName: context.entryName || null,
              validGps: !!gps_track?.validGps,
              hasSegments: true,
              segmentPayloadPath: null,
              recomputeSegmentsFromDb: true
            }));
          } catch (error) {
            await FileDBService.updateWorkoutSegmentProcessingStatus(
              uid,
              dbrow.id,
              "failed",
              error.message || "Failed to schedule segment recompute"
            );
            throw error;
          }
        } else if (hasSegments) {
          try {
            const segmentPayloadPath = await writeSegmentPersistencePayload({
              uid,
              workoutId: dbrow.id,
              entryName: context.entryName || null,
              segments
            });
            await handlePostprocessScheduling(context.importJobId || null, createPostprocessTarget({
              uid,
              workoutId: dbrow.id,
              entryName: context.entryName || null,
              validGps: !!gps_track?.validGps,
              hasSegments: true,
              segmentPayloadPath
            }));
          } catch (error) {
            await FileDBService.updateWorkoutSegmentProcessingStatus(
              uid,
              dbrow.id,
              "failed",
              error.message || "Failed to schedule postprocessing"
            );
            throw error;
          }
        } else {
          try {
            await handlePostprocessScheduling(context.importJobId || null, createPostprocessTarget({
              uid,
              workoutId: dbrow.id,
              entryName: context.entryName || null,
              validGps: !!gps_track?.validGps,
              hasSegments: false,
              segmentPayloadPath: null
            }));
          } catch (error) {
            await FileDBService.updateWorkoutSegmentProcessingStatus(
              uid,
              dbrow.id,
              "failed",
              error.message || "Failed to schedule postprocessing"
            );
            throw error;
          }
        }
      }

      if (dbrow?.id && !FEATURE_THUMBNAILS_ON_DEMAND) {
        const thumbnailStartedAt = Date.now();
        const thumbnailPayloadPath = await writeThumbnailPayload({
          uid,
          workoutId: dbrow.id,
          entryName: context.entryName || null,
          gpsTrack: gps_track?.track ?? null,
          workoutObject
        });
        await enqueueWorkoutThumbnailGeneration({
          uid,
          workoutId: dbrow.id,
          payloadPath: thumbnailPayloadPath,
          entryName: context.entryName || null
        });
        timing.mark("store-thumbnail", {
          mode: "async",
          renderThumbnailMs: Date.now() - thumbnailStartedAt
        });
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

      timing.mark("schedule-postprocess", {
        mode: IMPORT_POSTPROCESS_MODE
      });

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

  async function finalizePersistedWorkoutItem(item, dbrow, batchTrace, shareConfig = null, context = {}) {
    const { uid, segments, gps_track, workoutObject, fileRow } = item;

    let deferredPostprocessTarget = null;

    if (dbrow?.id) {
      const shouldScheduleSegmentPersistence = SEGMENTS_RECOMPUTE_FROM_DB || (Array.isArray(segments) && segments.length > 0);

      if (shouldScheduleSegmentPersistence) {
        const segmentPersistStartedAt = Date.now();
        try {
          let target;
          if (SEGMENTS_RECOMPUTE_FROM_DB) {
            target = createPostprocessTarget({
              uid,
              workoutId: dbrow.id,
              entryName: context.entryName || null,
              validGps: !!gps_track?.validGps,
              hasSegments: true,
              segmentPayloadPath: null,
              recomputeSegmentsFromDb: true
            });
          } else {
            const payloadResult = await writeSegmentPersistencePayload({
              uid,
              workoutId: dbrow.id,
              entryName: context.entryName || null,
              segments
            });
            const segmentPayloadPath = payloadResult.payloadPath;
            batchTrace?.add("enqueueSegmentPersistenceSerializeMs", payloadResult.serializeMs);
            batchTrace?.add("enqueueSegmentPersistenceWriteFileMs", payloadResult.writeFileMs);
            target = createPostprocessTarget({
              uid,
              workoutId: dbrow.id,
              entryName: context.entryName || null,
              validGps: !!gps_track?.validGps,
              hasSegments: true,
              segmentPayloadPath,
              recomputeSegmentsFromDb: false
            });
          }
          if (IMPORT_POSTPROCESS_MODE === "phased") {
            deferredPostprocessTarget = target;
          } else {
            const queueStartedAt = Date.now();
            await handlePostprocessScheduling(context.importJobId || null, target);
            batchTrace?.add("enqueueSegmentPersistenceQueueMs", Date.now() - queueStartedAt);
          }
          batchTrace?.add("enqueueSegmentPersistenceMs", Date.now() - segmentPersistStartedAt);
        } catch (error) {
          await FileDBService.updateWorkoutSegmentProcessingStatus(
            uid,
            dbrow.id,
            "failed",
            error.message || "Failed to schedule postprocessing"
          );
          throw error;
        }
      } else {
        try {
          const target = createPostprocessTarget({
            uid,
            workoutId: dbrow.id,
            entryName: context.entryName || null,
            validGps: !!gps_track?.validGps,
            hasSegments: false,
            segmentPayloadPath: null
          });
          if (IMPORT_POSTPROCESS_MODE === "phased") {
            deferredPostprocessTarget = target;
          } else {
            await handlePostprocessScheduling(context.importJobId || null, target);
          }
        } catch (error) {
          await FileDBService.updateWorkoutSegmentProcessingStatus(
            uid,
            dbrow.id,
            "failed",
            error.message || "Failed to schedule postprocessing"
          );
          throw error;
        }
      }
    }

    if (dbrow?.id && !FEATURE_THUMBNAILS_ON_DEMAND) {
      const thumbnailStartedAt = Date.now();
      const thumbnailPayloadPath = await writeThumbnailPayload({
        uid,
        workoutId: dbrow.id,
        entryName: context.entryName || null,
        gpsTrack: gps_track?.track ?? null,
        workoutObject
      });
      await enqueueWorkoutThumbnailGeneration({
        uid,
        workoutId: dbrow.id,
        payloadPath: thumbnailPayloadPath,
        entryName: context.entryName || null
      });
      batchTrace?.add("renderThumbnailMs", Date.now() - thumbnailStartedAt);
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

    batchTrace?.add("classifySimilarWorkoutsMs", 0);
    batchTrace?.add("storeSegmentBestEffortsMs", 0);

    return {
      dbrow,
      deferredPostprocessTarget
    };
  }

  async function buildPendingPersistItem(fitJsonObject, uid, batchTrace, context = {}) {
    const processFitRecordsStartedAt = Date.now();
    const { aggregated, segments, gps_track, workoutObject, importGpsSource, timingSteps = [] } = processFitRecords(fitJsonObject, {
      sourceName: context.entryName || null,
      computeSegments: !SEGMENTS_RECOMPUTE_FROM_DB
    });
    batchTrace?.add("processFitRecordsMs", Date.now() - processFitRecordsStartedAt);
    const processFitStepMetricMap = {
      "aggregate-sessions": "processFitAggregateSessionsMs",
      "sort-records": "processFitSortRecordsMs",
      "fill-gaps": "processFitFillGapsMs",
      "clean-altitude": "processFitCleanAltitudeMs",
      "clean-gps-build-track": "processFitCleanGpsBuildTrackMs",
      "workout-from-records": "processFitWorkoutFromRecordsMs",
      "detect-auto-segments": "processFitDetectAutoSegmentsMs",
      "detect-best-efforts": "processFitDetectBestEffortsMs",
      "merge-segments": "processFitMergeSegmentsMs"
    };
    for (const step of timingSteps) {
      const metric = processFitStepMetricMap[step?.label];
      if (metric) {
        batchTrace?.add(metric, Number(step?.stepMs || 0));
      }
      if (step?.label === "clean-gps-build-track" && step?.phases) {
        batchTrace?.add("processFitCleanGpsCopySourceArraysMs", Number(step.phases.copySourceArraysMs || 0));
        batchTrace?.add("processFitCleanGpsCleanPassMs", Number(step.phases.cleanPassMs || 0));
        batchTrace?.add("processFitCleanGpsNeighborIndexMs", Number(step.phases.neighborIndexMs || 0));
        batchTrace?.add("processFitCleanGpsInterpolatePassMs", Number(step.phases.interpolatePassMs || 0));
        batchTrace?.add("processFitCleanGpsBuildTrackSubstepMs", Number(step.phases.buildTrackMs || 0));
        batchTrace?.add("processFitCleanGpsTrackHashMs", Number(step.phases.trackHashMs || 0));
      }
    }

    const fitFile = {
      uid,
      gps_source: importGpsSource
    };

    const mapStartedAt = Date.now();
    const fileRow = mapAggregatedToFileRow(aggregated, fitFile, workoutObject.getNormalizedPower());
    batchTrace?.add("mapAggregatedRowMs", Date.now() - mapStartedAt);

    const prepareStartedAt = Date.now();
    const preparedInsert = await FileDBService.prepareInsertFilePayload(fileRow, gps_track, workoutObject);
    batchTrace?.add("insertFileMs", Date.now() - prepareStartedAt);
    const insertStepMetricMap = {
      "to-compressed-buffer": "insertToCompressedBufferMs",
      "build-geometry-wkt": "insertBuildGeometryWktMs"
    };
    for (const step of Array.isArray(preparedInsert?.timingSteps) ? preparedInsert.timingSteps : []) {
      const metric = insertStepMetricMap[step?.label];
      if (metric) {
        batchTrace?.add(metric, Number(step?.stepMs || 0));
      }
    }

    return {
      uid,
      fileRow,
      segments,
      gps_track,
      workoutObject,
      preparedInsert
    };
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
    const insertBuffer = [];

    async function flushInsertBuffer() {
      if (insertBuffer.length === 0) {
        return;
      }

      const itemsToFlush = insertBuffer.splice(0, insertBuffer.length);
      const bulkInsertStartedAt = Date.now();
      try {
        const bulkResult = await FileDBService.insertPreparedFilesBulk(
          itemsToFlush.map((item) => item.pendingItem.preparedInsert)
        );
        const bulkInsertElapsedMs = Date.now() - bulkInsertStartedAt;
        const insertedByKey = new Map(
          (Array.isArray(bulkResult?.insertedRows) ? bulkResult.insertedRows : []).map((row) => [
            `${row.uid}:${new Date(row.start_time).toISOString()}`,
            row
          ])
        );
        const existingByKey = bulkResult?.existingRowsByKey instanceof Map
          ? bulkResult.existingRowsByKey
          : new Map();

        const bulkTimingTotals = Array.isArray(bulkResult?.timingSteps) ? bulkResult.timingSteps : [];
        const insertRowsStepMs = Number(bulkTimingTotals.find((step) => step.label === "insert-workout-rows")?.stepMs || 0);
        const loadExistingRowsStepMs = Number(bulkTimingTotals.find((step) => step.label === "load-existing-rows")?.stepMs || 0);
        const perItemInsertMs = itemsToFlush.length > 0 ? insertRowsStepMs / itemsToFlush.length : 0;
        const perItemLookupMs = itemsToFlush.length > 0 ? loadExistingRowsStepMs / itemsToFlush.length : 0;

        for (const buffered of itemsToFlush) {
          if (perItemLookupMs > 0) {
            buffered.localTrace.add("insertFileMs", perItemLookupMs);
          }
        }

        for (const buffered of itemsToFlush) {
          const { item, localTrace, startedAt, pendingItem } = buffered;
          const key = `${pendingItem.uid}:${new Date(pendingItem.fileRow.start_time).toISOString()}`;
          const dbrow = insertedByKey.get(key) || null;

          if (!dbrow) {
            const existingRow = existingByKey.get(key) || null;
            results.push({
              key: item.key,
              sourceName: item.sourceName || null,
              entryName: item.entryName,
              status: "failed",
              message: existingRow
                ? FileDBService.createDuplicateWorkoutMessage(pendingItem.fileRow.start_time)
                : "Bulk insert did not return a row for this workout",
              elapsedMs: Date.now() - startedAt,
              traceTotals: {
                ...localTrace.totals,
                insertFileMs: Number(localTrace.totals.insertFileMs || 0) + perItemInsertMs
              },
              deferredPostprocessTarget: null
            });
            continue;
          }

          try {
            localTrace.add("insertInsertWorkoutRowMs", perItemInsertMs);
            localTrace.add("insertFileMs", perItemInsertMs);

            const outcome = await finalizePersistedWorkoutItem(
              pendingItem,
              { id: dbrow.id, uid: dbrow.uid },
              localTrace,
              shareConfig,
              {
                importJobId,
                entryName: item.entryName
              }
            );

            results.push({
              key: item.key,
              sourceName: item.sourceName || null,
              entryName: item.entryName,
              status: "completed",
              message: null,
              elapsedMs: Date.now() - startedAt,
              traceTotals: localTrace.totals,
              deferredPostprocessTarget: outcome?.deferredPostprocessTarget || null
            });
          } catch (error) {
            results.push({
              key: item.key,
              sourceName: item.sourceName || null,
              entryName: item.entryName,
              status: "failed",
              message: error.message || "Unknown import error",
              elapsedMs: Date.now() - startedAt,
              traceTotals: localTrace.totals,
              deferredPostprocessTarget: null
            });
          }
        }

        logVerboseImportEvent("batch.flush.completed", {
          queueJobId: job.id,
          importJobId,
          itemCount: itemsToFlush.length,
          insertedCount: insertedByKey.size,
          resolvedCount: existingByKey.size,
          elapsedMs: bulkInsertElapsedMs
        });
      } catch (error) {
        for (const buffered of itemsToFlush) {
          results.push({
            key: buffered.item.key,
            sourceName: buffered.item.sourceName || null,
            entryName: buffered.item.entryName,
            status: "failed",
            message: error.message || "Bulk insert failed",
            elapsedMs: Date.now() - buffered.startedAt,
            traceTotals: buffered.localTrace.totals,
            deferredPostprocessTarget: null
          });
        }
      }
    }

    logVerboseImportEvent("batch.started", {
      queueJobId: job.id,
      importJobId,
      batchIndex: job.data?.batchIndex,
      itemCount: batchItems.length
    });

    for (const item of batchItems) {
      const startedAt = Date.now();

      try {
        const readStartedAt = Date.now();
        const buffer = await fs.promises.readFile(item.localPath);
        const readMs = Date.now() - readStartedAt;
        const parseStartedAt = Date.now();
        const parsed = await parseFitBuffer(buffer);
        const parseMs = Date.now() - parseStartedAt;
        const localTrace = createBatchTrace("worker.process-fit-batch-item", {
          importJobId,
          entryName: item.entryName
        });
        localTrace.add("entryBufferMs", readMs);
        localTrace.add("parseFitMs", parseMs);
        const pendingItem = await buildPendingPersistItem(parsed, uid, localTrace, {
          importJobId,
          entryName: item.entryName
        });
        insertBuffer.push({
          item,
          startedAt,
          localTrace,
          pendingItem
        });
        if (insertBuffer.length >= IMPORT_DB_BULK_INSERT_SIZE) {
          await flushInsertBuffer();
        }
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

    await flushInsertBuffer();

    return {
      importJobId,
      results
    };
  }

  async function extractZipEntriesToBatchItems(zipPath, sourceName) {
    const startedAt = Date.now();
    const tempDir = IMPORT_UPLOAD_TEMP_DIR;
    await fs.promises.mkdir(tempDir, { recursive: true });
    const openStartedAt = Date.now();
    const zipDirectory = await unzipper.Open.file(zipPath);
    const openMs = Date.now() - openStartedAt;
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

    logImportEvent("zip.materialized", {
      sourceName,
      fitEntryCount: fitEntries.length,
      tempDir,
      openMs,
      materializeMs: Date.now() - startedAt
    });

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
    const deferredPostprocessTargets = [];

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

    const pendingBatchResults = jobs.map((queueJob, index) => {
      const entry = {
        index,
        promise: null
      };

      entry.promise = queueJob.waitUntilFinished(queueEvents).then((batchResult) => ({
        index,
        batchResult,
        entry
      }));

      return entry;
    });

    while (pendingBatchResults.length > 0) {
      const settled = await Promise.race(pendingBatchResults.map((entry) => entry.promise));
      const pendingIndex = pendingBatchResults.findIndex((entry) => entry === settled.entry);
      if (pendingIndex >= 0) {
        pendingBatchResults.splice(pendingIndex, 1);
      }

      const batchResult = settled.batchResult;
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

        const traceTotals = result?.traceTotals;
        if (traceTotals && typeof traceTotals === "object") {
          for (const [metric, ms] of Object.entries(traceTotals)) {
            batchTrace?.add(metric, Number(ms) || 0);
          }
        }

        if (result?.deferredPostprocessTarget && IMPORT_POSTPROCESS_MODE === "phased") {
          deferredPostprocessTargets.push(result.deferredPostprocessTarget);
        }
      }

      const progressPercent =
        totalFiles === 0
          ? 100
          : Math.min(99, 10 + ((processedFiles + failedFiles) / totalFiles) * 89);

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
      progressPercent: 99
    });

    if (IMPORT_POSTPROCESS_MODE !== "phased") {
      logImportEvent("phase.sync-import.completed", {
        importJobId: jobId,
        targetCount: 0,
        mode: IMPORT_POSTPROCESS_MODE
      });
    }

    if (IMPORT_SYNC_PROFILE_LOG) {
      logImportEvent("phase.sync-import.profile", summarizeSyncProfile(batchTrace?.totals, {
        totalFiles,
        processedFiles,
        failedFiles
      }));
    }

    logImportEvent("job.completed", {
      importJobId: jobId,
      totalFiles,
      processedFiles,
      failedFiles,
      mode
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

    if (IMPORT_POSTPROCESS_MODE === "phased") {
      await flushDeferredPostprocessTargets(jobId, deferredPostprocessTargets);
    }

    batchTrace?.flush({
      phase: "completed",
      mode,
      totalFiles,
      processedFiles,
      failedFiles
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
    const totalStartedAt = Date.now();
    await updateImportJob(jobId, {
      status: "processing",
      stage: "reading_zip",
      progressPercent: 10
    });

    const countStartedAt = Date.now();
    const totalFilesPerInput = await Promise.all(files.map((filePath) => countFitEntries(filePath)));
    const countMs = Date.now() - countStartedAt;
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

    logImportEvent("zip.scan.completed", {
      importJobId: jobId,
      inputCount: files.length,
      totalFiles,
      elapsedMs: countMs
    });

    await updateImportJob(jobId, {
      stage: "parsing_fit_files",
      fileStatuses,
      totalFiles,
      processedFiles: 0,
      failedFiles: 0,
      progressPercent: totalFiles > 0 ? 10 : 100
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

      logImportEvent("phase.sync-import.started", {
        importJobId: jobId,
        totalBatchItems: batchItems.length,
        batchWorkerMode: true,
        postprocessMode: IMPORT_POSTPROCESS_MODE,
        preBatchElapsedMs: Date.now() - totalStartedAt
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
        concurrency: IMPORT_QUEUE_CONCURRENCY
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
        concurrency: IMPORT_BATCH_WORKER_CONCURRENCY
      }
    );

    importBatchWorker.on("ready", () => {
      console.log("Import batch worker is ready");
    });

    importBatchWorker.on("completed", (job) => {
      logVerboseImportEvent("batch.completed", {
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
        if (job.name === "persist-workout-segments") {
          return await processWorkoutSegmentPersistenceJob(job);
        }

        if (job.name === "generate-workout-thumbnail") {
          return await processWorkoutThumbnailGenerationJob(job);
        }

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
      void job;
    });

    segmentBestEffortsWorker.on("failed", (job, error) => {
      if (job?.name === "persist-workout-segments") {
        logPostProcessEvent("segment-persist.failed", {
          queueJobId: job?.id,
          uid: job?.data?.uid,
          workoutId: job?.data?.workoutId ?? null,
          payloadPath: job?.data?.payloadPath ?? null,
          error: error.message
        });
        console.error("[postprocess] segment-persist.queue-job.failed", {
          queueJobId: job?.id,
          payloadPath: job?.data?.payloadPath,
          error: error.message
        });
        return;
      }

      if (job?.name === "generate-workout-thumbnail") {
        logPostProcessEvent("thumbnail.failed", {
          queueJobId: job?.id,
          uid: job?.data?.uid,
          workoutId: job?.data?.workoutId ?? null,
          payloadPath: job?.data?.payloadPath ?? null,
          error: error.message
        });
        return;
      }

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
      void job;
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
