import fs from "node:fs";
import util from "node:util";

import { Worker } from "bullmq";
import Workout from "../shared/Workout.js";
import { detectWorkoutLocalSegmentsFromWorkout } from "../shared/WorkoutLocalPostprocess.js";

import { FileDBService } from "../services/fileDBService.js";
import SegmentDBService from "../services/segmentDBService.js";
import WorkoutThumbnailService from "../services/workoutThumbnailService.js";
import WorkoutDBService from "../services/workoutDBService.js";
import WorkoutSimilarityService from "../services/workoutSimilarityService.js";
import {
  WORKOUT_SIMILARITY_BATCH_SIZE
} from "../services/workout-similarity-job-service.js";
import {
  SEGMENT_BEST_EFFORTS_BATCH_SIZE,
  SEGMENT_PERSIST_BATCH_SIZE,
  SEGMENT_SCAN_BATCH_SIZE
} from "../services/segment-best-efforts-service.js";

import { redisConnection } from "../queue/connection.js";
import { getImportJobById } from "../db/import-jobs-repo.js";
import pool from "../services/database.js";
import {
  deleteWoaBundleUpload,
  listExpiredWoaBundleUploads,
  listRecoverableWoaBundleUploads
} from "../db/woa-bundle-uploads-repo.js";
import {
  enqueueWoaBundleRecovery,
  WOA_BUNDLE_RECOVERY_JOB
} from "../services/woaBundleRecoveryJobService.js";

export async function createApp(options = {}) {
  const IMPORT_QUEUE_CONCURRENCY = Math.max(1, Number(process.env.IMPORT_QUEUE_CONCURRENCY) || 2);
  const IMPORT_POSTPROCESS_LOGS = String(process.env.IMPORT_POSTPROCESS_LOGS || "").trim() !== "0";
  const IMPORT_POSTPROCESS_PROFILE_LOG = String(process.env.IMPORT_POSTPROCESS_PROFILE_LOG || "1").trim() !== "0";
  const IMPORT_POSTPROCESS_PROFILE_EVERY = Math.max(1, Number(process.env.IMPORT_POSTPROCESS_PROFILE_EVERY) || 25);
  const SEGMENTS_RECOMPUTE_FROM_DB = String(process.env.SEGMENTS_RECOMPUTE_FROM_DB || "").trim() === "1";
  const WOA_BUNDLE_RECOVERY_ENABLED = String(process.env.WOA_BUNDLE_RECOVERY_ENABLED || "0").trim() === "1";
  const WOA_BUNDLE_RECOVERY_SWEEP_MS = Math.max(
    30_000,
    Number(process.env.WOA_BUNDLE_RECOVERY_SWEEP_MS) || 60_000
  );
  const WOA_BUNDLE_RECOVERY_RETENTION_HOURS = Math.max(
    1,
    Number(process.env.WOA_BUNDLE_RECOVERY_RETENTION_HOURS) || 24
  );
  const {
    enableImportWorker = true,
    enableSegmentBestEffortsWorker = true,
    enableWorkoutSimilarityWorker = true
  } = options;

  console.log("[import] bootstrap.config", {
    enableImportWorker,
    enableSegmentBestEffortsWorker,
    enableWorkoutSimilarityWorker,
    IMPORT_POSTPROCESS_LOGS,
    IMPORT_POSTPROCESS_PROFILE_LOG,
    IMPORT_POSTPROCESS_PROFILE_EVERY,
    SEGMENTS_RECOMPUTE_FROM_DB,
    WOA_BUNDLE_RECOVERY_ENABLED,
    WOA_BUNDLE_RECOVERY_SWEEP_MS,
    WOA_BUNDLE_RECOVERY_RETENTION_HOURS,
    IMPORT_QUEUE_CONCURRENCY,
    SEGMENT_PERSIST_BATCH_SIZE,
    SEGMENT_BEST_EFFORTS_BATCH_SIZE,
    SEGMENT_SCAN_BATCH_SIZE,
    WORKOUT_SIMILARITY_BATCH_SIZE,
    GPS_IMPORT_DEBUG: String(process.env.GPS_IMPORT_DEBUG || "").trim() === "1",
    ALTITUDE_IMPORT_DEBUG: String(process.env.ALTITUDE_IMPORT_DEBUG || "").trim() === "1",
    SIMILARITY_DEBUG: String(process.env.SIMILARITY_DEBUG || "").trim() === "1"
  });

  if (enableWorkoutSimilarityWorker) {
    const similarityIndexStartedAt = Date.now();
    await WorkoutDBService.ensureSimilarityPerformanceIndexes();
    console.log("[postprocess] similarity.indexes.ready", {
      elapsedMs: Date.now() - similarityIndexStartedAt
    });
  }

  function formatLogPayload(payload = {}) {
    return util.inspect(payload, {
      depth: null,
      colors: false,
      compact: false,
      breakLength: 120
    });
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

  function computeImportPostprocessExpectedCounts(targets = []) {
    const expected = {
      "segment-persist": 0,
      similarity: 0,
      "segment-best-efforts": 0
    };

    for (const target of Array.isArray(targets) ? targets : []) {
      const shouldPersistSegments = !!target?.recomputeSegmentsFromDb || (!!target?.hasSegments && !!target?.segmentPayloadPath);
      if (shouldPersistSegments) {
        expected["segment-persist"] += 1;
      }
      if (target?.validGps) {
        if (!target?.skipSimilarity) {
          expected.similarity += 1;
        }
        if (!target?.skipSegmentBestEfforts) {
          expected["segment-best-efforts"] += 1;
        }
      }
    }

    return expected;
  }

  function syncImportPostprocessRunExpectations(run, targets = []) {
    if (!run) {
      return null;
    }

    const normalizedTargets = Array.isArray(targets) ? targets : [];
    const expected = computeImportPostprocessExpectedCounts(normalizedTargets);
    run.targetCount = Math.max(Number(run.targetCount || 0), normalizedTargets.length);

    for (const [phaseType, expectedCount] of Object.entries(expected)) {
      const phaseState = run.phases?.[phaseType];
      if (!phaseState) {
        continue;
      }

      if (expectedCount > Number(phaseState.expected || 0)) {
        phaseState.expected = expectedCount;
        if (!phaseState.completionResolved && (phaseState.completed + phaseState.failed) >= phaseState.expected) {
          phaseState.completionResolved = true;
          phaseState.wallCompletedAt = phaseState.wallCompletedAt || Date.now();
          phaseState.resolveCompletion?.();
        }
      }
    }

    return run;
  }

  async function ensureImportPostprocessRun(importJobId, phaseType = null) {
    if (!importJobId) {
      return null;
    }

    const existingRun = getImportPostprocessRun(importJobId);
    const shouldRefreshExisting = !!(
      existingRun
      && phaseType
      && Number(existingRun?.phases?.[phaseType]?.expected || 0) === 0
    );

    if (existingRun && !shouldRefreshExisting) {
      return existingRun;
    }

    const importJob = await getImportJobById(importJobId);
    const targets = Array.isArray(importJob?.postprocessTargets)
      ? importJob.postprocessTargets
      : [];

    if (existingRun) {
      return syncImportPostprocessRunExpectations(existingRun, targets);
    }

    return registerImportPostprocessRun(importJobId, targets);
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
    logPostProcessProfileEvent("import.wall.completed", {
      importJobId: String(importJobId),
      targetCount: run.targetCount,
      totalWallMs: Date.now() - run.startedAt
    });

    importPostprocessRuns.delete(String(importJobId));
  }

  async function recordImportPostprocessOutcome(importJobId, type, elapsedMs, metrics = {}, failed = false) {
    const run = await ensureImportPostprocessRun(importJobId, type);
    if (!run) {
      return;
    }

    const phaseState = run.phases[type];
    if (!phaseState) {
      return;
    }

    if (failed) {
      if (!phaseState.wallStartedAt) {
        phaseState.wallStartedAt = Date.now();
      }
      phaseState.failed += 1;
    } else {
      if (!phaseState.wallStartedAt) {
        phaseState.wallStartedAt = Date.now();
      }
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
      phaseState.wallCompletedAt = Date.now();
      phaseState.resolveCompletion?.();
    }

    if (phaseState.completionResolved && !phaseState.completedLogged) {
      phaseState.completedLogged = true;
      logImportPostprocessPhaseSummary(importJobId, type);
      finalizeImportPostprocessRun(importJobId);
    }

  }

  function registerImportPostprocessRun(importJobId, targets = []) {
    if (!importJobId) {
      return null;
    }

    const normalizedImportJobId = String(importJobId);
    const expected = computeImportPostprocessExpectedCounts(targets);

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
    const phaseState = getImportPostprocessRun(importJobId)?.phases?.[type];
    if (!phaseState || phaseState.wallStartedAt) {
      return;
    }
    phaseState.wallStartedAt = Date.now();
    if (phaseState.expected === 0) {
      phaseState.wallCompletedAt = phaseState.wallStartedAt;
    }
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

  async function processSegmentBestEffortsJob(uid, segmentIds) {
    if (segmentIds.length > 1) {
      const startedAt = Date.now();
      const updateProcessingStatusStartedAt = Date.now();
      await SegmentDBService.updateBestEffortsStatus(uid, segmentIds, "processing", null);
      const updateProcessingStatusMs = Date.now() - updateProcessingStatusStartedAt;

      try {
        const scanWorkoutsStartedAt = Date.now();
        /** @type {{ matches: any[], profile: any }} */
        const scanResult = /** @type {any} */ (await SegmentDBService.scanWorkoutsForSegments(
          uid,
          segmentIds,
          { includeProfile: true }
        ));
        const scanWorkoutsMs = Date.now() - scanWorkoutsStartedAt;

        const storeBestEffortsStartedAt = Date.now();
        await SegmentDBService.storeSegmentBestEffortsV2(scanResult.matches);
        const storeBestEffortsMs = Date.now() - storeBestEffortsStartedAt;

        const updateCompletedStatusStartedAt = Date.now();
        await SegmentDBService.updateBestEffortsStatus(uid, segmentIds, "completed", null);
        const updateCompletedStatusMs = Date.now() - updateCompletedStatusStartedAt;

        console.log("[postprocess] new-segment-best-efforts.profile", {
          uid,
          segmentIds,
          mode: "workout-first",
          totalMs: Date.now() - startedAt,
          matchCount: scanResult.matches.length,
          updateProcessingStatusMs,
          loadSegmentMs: scanResult.profile.loadSegmentDefinitionsMs,
          scanWorkoutsMs,
          storeBestEffortsMs,
          updateCompletedStatusMs,
          scan: scanResult.profile
        });
      } catch (error) {
        await SegmentDBService.updateBestEffortsStatus(
          uid,
          segmentIds,
          "failed",
          error.message || "Unknown segment best-effort error"
        );
        throw error;
      }
      return;
    }

    const startedAt = Date.now();
    const profile = {
      updateProcessingStatusMs: 0,
      loadSegmentMs: 0,
      scanWorkoutsMs: 0,
      storeBestEffortsMs: 0,
      updateCompletedStatusMs: 0
    };

    const updateProcessingStatusStartedAt = Date.now();
    await SegmentDBService.updateBestEffortsStatus(uid, segmentIds, "processing", null);
    profile.updateProcessingStatusMs = Date.now() - updateProcessingStatusStartedAt;

    try {
      const loadSegmentStartedAt = Date.now();
      const segment = await SegmentDBService.getSegmentById(uid, segmentIds[0]);
      profile.loadSegmentMs = Date.now() - loadSegmentStartedAt;

      const scanWorkoutsStartedAt = Date.now();
      /** @type {{ matches: any[], profile: any }} */
      const scanResult = /** @type {any} */ (segment
        ? await SegmentDBService.scanWorkoutsForSegment(uid, segment, { includeProfile: true })
        : { matches: [], profile: {} });
      profile.scanWorkoutsMs = Date.now() - scanWorkoutsStartedAt;
      const matchingEfforts = scanResult.matches;
      const scanProfile = scanResult.profile;

      const storeBestEffortsStartedAt = Date.now();
      await SegmentDBService.storeSegmentBestEffortsV2(matchingEfforts);
      profile.storeBestEffortsMs = Date.now() - storeBestEffortsStartedAt;

      const updateCompletedStatusStartedAt = Date.now();
      await SegmentDBService.updateBestEffortsStatus(uid, segmentIds, "completed", null);
      profile.updateCompletedStatusMs = Date.now() - updateCompletedStatusStartedAt;

      console.log("[postprocess] new-segment-best-efforts.profile", {
        uid,
        segmentIds,
        totalMs: Date.now() - startedAt,
        matchCount: matchingEfforts.length,
        ...profile,
        scan: scanProfile
      });
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
      await recordImportPostprocessOutcome(importJobId, "similarity", elapsedMs, {
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
      await recordImportPostprocessOutcome(importJobId, "similarity", 0, {}, true);
      throw error;
    }
  }

  function buildSimilarityProfileMetrics(similarityProfile = {}, edgeCount = 0) {
    return {
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
      rejectedByScore: Number(similarityProfile.rejectedByScore || 0),
      batchSize: Number(similarityProfile.batchSize || 1),
      candidateMetadataMs: Number(similarityProfile.candidateMetadataMs || 0),
      loadTrackRowsMs: Number(similarityProfile.loadTrackRowsMs || 0),
      decodeTrackMs: Number(similarityProfile.decodeTrackMs || 0),
      trackCacheEntriesPerWorkout: Number(similarityProfile.trackCacheEntriesPerWorkout || 0),
      trackCacheBytesPerWorkout: Number(similarityProfile.trackCacheBytesPerWorkout || 0),
      trackCacheReuseRatio: Number(similarityProfile.trackCacheReuseRatio || 0),
      edgeInsertBatchCount: Number(similarityProfile.edgeInsertBatchCount || 0)
    };
  }

  async function processWorkoutSimilarityClassificationBatchJob(job) {
    const uid = job.data?.uid;
    const importJobId = job.data?.importJobId ? String(job.data.importJobId) : null;
    const workoutIds = [...new Set((Array.isArray(job.data?.workoutIds) ? job.data.workoutIds : [])
      .map(Number)
      .filter(Number.isInteger))];
    if (!uid || workoutIds.length === 0) {
      throw new Error("Workout similarity batch is missing uid or workoutIds");
    }

    await ensureImportPostprocessRun(importJobId, "similarity");
    markImportPostprocessPhaseStarted(importJobId, "similarity");
    await job.updateProgress({ progressPercent: 0, batchSize: workoutIds.length });
    try {
      const results = await WorkoutSimilarityService.classifySimilarGpsWorkoutsBatch(workoutIds, uid);
      let edgeCount = 0;
      for (const result of results) {
        const resultEdgeCount = Array.isArray(result?.edges) ? result.edges.length : 0;
        const profile = result?.profile || {};
        const elapsedMs = Number(result?.profile?.elapsedMs || 0);
        const metrics = buildSimilarityProfileMetrics(profile, resultEdgeCount);
        edgeCount += resultEdgeCount;
        recordPostprocessProfile("similarity", elapsedMs, metrics);
        await recordImportPostprocessOutcome(importJobId, "similarity", elapsedMs, metrics);
      }

      await job.updateProgress({
        progressPercent: 100,
        batchSize: workoutIds.length,
        edgeCount
      });
      return { progressPercent: 100, batchSize: workoutIds.length, edgeCount };
    } catch (error) {
      for (let index = 0; index < workoutIds.length; index += 1) {
        await recordImportPostprocessOutcome(importJobId, "similarity", 0, {}, true);
      }
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
      const segmentBestEffortsResult = await SegmentDBService.rescanSegmentBestEffortsForWorkout(uid, workoutId, {
        includeProfile: true
      });
      const matches = Array.isArray(segmentBestEffortsResult?.matches)
        ? segmentBestEffortsResult.matches
        : [];
      const segmentBestEffortsProfile = segmentBestEffortsResult?.profile || {};
      const matchCount = matches.length;
      const elapsedMs = Date.now() - startedAt;

      await job.updateProgress({
        progressPercent: 100,
        workoutId,
        matchCount
      });

      recordPostprocessProfile("segment-best-efforts", elapsedMs, {
        matchCount,
        loadWorkoutTrackMs: Number(segmentBestEffortsProfile.loadWorkoutTrackMs || 0),
        buildBoundsMs: Number(segmentBestEffortsProfile.buildBoundsMs || 0),
        loadSegmentCandidatesMs: Number(segmentBestEffortsProfile.loadSegmentCandidatesMs || 0),
        matchSegmentsMs: Number(segmentBestEffortsProfile.matchSegmentsMs || 0),
        loadWorkoutObjectMs: Number(segmentBestEffortsProfile.loadWorkoutObjectMs || 0),
        persistBestEffortsMs: Number(segmentBestEffortsProfile.persistBestEffortsMs || 0),
        candidateCount: Number(segmentBestEffortsProfile.candidateCount || 0),
        rawMatchCount: Number(segmentBestEffortsProfile.rawMatchCount || 0)
      });
      await recordImportPostprocessOutcome(importJobId, "segment-best-efforts", elapsedMs, {
        matchCount,
        loadWorkoutTrackMs: Number(segmentBestEffortsProfile.loadWorkoutTrackMs || 0),
        buildBoundsMs: Number(segmentBestEffortsProfile.buildBoundsMs || 0),
        loadSegmentCandidatesMs: Number(segmentBestEffortsProfile.loadSegmentCandidatesMs || 0),
        matchSegmentsMs: Number(segmentBestEffortsProfile.matchSegmentsMs || 0),
        loadWorkoutObjectMs: Number(segmentBestEffortsProfile.loadWorkoutObjectMs || 0),
        persistBestEffortsMs: Number(segmentBestEffortsProfile.persistBestEffortsMs || 0),
        candidateCount: Number(segmentBestEffortsProfile.candidateCount || 0),
        rawMatchCount: Number(segmentBestEffortsProfile.rawMatchCount || 0)
      });

      return {
        progressPercent: 100,
        workoutId,
        matchCount
      };
    } catch (error) {
      await recordImportPostprocessOutcome(importJobId, "segment-best-efforts", 0, {}, true);
      throw error;
    }
  }

  function buildSegmentBestEffortsProfileMetrics(profile = {}, matchCount = 0) {
    return {
      matchCount,
      loadWorkoutTrackMs: Number(profile.loadWorkoutTrackMs || 0),
      buildBoundsMs: Number(profile.buildBoundsMs || 0),
      loadSegmentCandidatesMs: Number(profile.loadSegmentCandidatesMs || 0),
      matchSegmentsMs: Number(profile.matchSegmentsMs || 0),
      loadWorkoutObjectMs: Number(profile.loadWorkoutObjectMs || 0),
      persistBestEffortsMs: Number(profile.persistBestEffortsMs || 0),
      candidateCount: Number(profile.candidateCount || 0),
      rawMatchCount: Number(profile.rawMatchCount || 0),
      batchSize: Number(profile.batchSize || 1),
      loadWorkoutTrackRowsMs: Number(profile.loadWorkoutTrackRowsMs || 0),
      loadSegmentCandidateIdsMs: Number(profile.loadSegmentCandidateIdsMs || 0),
      loadSegmentDefinitionsMs: Number(profile.loadSegmentDefinitionsMs || 0),
      segmentCacheEntriesPerWorkout: Number(profile.segmentCacheEntriesPerWorkout || 0),
      segmentCacheReuseRatio: Number(profile.segmentCacheReuseRatio || 0),
      matchedWorkoutRatio: Number(profile.matchedWorkoutRatio || 0),
      insertedBestEffortsPerWorkout: Number(profile.insertedBestEffortsPerWorkout || 0)
    };
  }

  async function processWorkoutSegmentBestEffortsBatchJob(job) {
    const uid = job.data?.uid;
    const importJobId = job.data?.importJobId ? String(job.data.importJobId) : null;
    const workoutIds = [...new Set((Array.isArray(job.data?.workoutIds) ? job.data.workoutIds : [])
      .map(Number)
      .filter(Number.isInteger))];
    if (!uid || workoutIds.length === 0) {
      throw new Error("Workout segment best-efforts batch is missing uid or workoutIds");
    }

    await ensureImportPostprocessRun(importJobId, "segment-best-efforts");
    markImportPostprocessPhaseStarted(importJobId, "segment-best-efforts");
    await job.updateProgress({ progressPercent: 0, batchSize: workoutIds.length });
    try {
      const results = await SegmentDBService.rescanSegmentBestEffortsForWorkoutsBatch(uid, workoutIds);
      let matchCount = 0;
      for (const result of results) {
        const resultMatchCount = Array.isArray(result?.matches) ? result.matches.length : 0;
        const elapsedMs = Number(result?.elapsedMs || 0);
        const metrics = buildSegmentBestEffortsProfileMetrics(result?.profile || {}, resultMatchCount);
        matchCount += resultMatchCount;
        recordPostprocessProfile("segment-best-efforts", elapsedMs, metrics);
        await recordImportPostprocessOutcome(importJobId, "segment-best-efforts", elapsedMs, metrics);
      }
      await job.updateProgress({ progressPercent: 100, batchSize: workoutIds.length, matchCount });
      return { progressPercent: 100, batchSize: workoutIds.length, matchCount };
    } catch (error) {
      for (let index = 0; index < workoutIds.length; index += 1) {
        await recordImportPostprocessOutcome(importJobId, "segment-best-efforts", 0, {}, true);
      }
      throw error;
    }
  }

  async function detectStoredWorkoutSegments(row) {
    const decompressStartedAt = Date.now();
    const workout = await Workout.fromCompressedWithCodec(
      row.stream,
      row.stream_codec || "brotli"
    );
    const decompressMs = Date.now() - decompressStartedAt;

    const bestEffortsStartedAt = Date.now();
    const segments = detectWorkoutLocalSegmentsFromWorkout(workout);
    const detectBestEffortsMs = Date.now() - bestEffortsStartedAt;

    return {
      segments,
      metrics: {
        decompressMs,
        recordRebuildMs: 0,
        detectAutoMs: 0,
        detectBestEffortsMs,
        mapSegmentsMs: 0
      }
    };
  }

  async function processWorkoutSegmentPersistenceBatchJob(job) {
    const uid = job.data?.uid;
    const importJobId = job.data?.importJobId ? String(job.data.importJobId) : null;
    const batchItems = (Array.isArray(job.data?.batchItems) ? job.data.batchItems : [])
      .map((item) => ({
        workoutId: Number(item?.workoutId),
        entryName: item?.entryName ?? null
      }))
      .filter((item) => Number.isInteger(item.workoutId));

    if (!uid || batchItems.length === 0) {
      throw new Error("Workout segment persistence batch is missing uid or workoutIds");
    }

    const workoutIds = batchItems.map((item) => item.workoutId);
    const startedAt = Date.now();
    await ensureImportPostprocessRun(importJobId, "segment-persist");
    markImportPostprocessPhaseStarted(importJobId, "segment-persist");
    await job.updateProgress({
      progressPercent: 0,
      batchSize: batchItems.length
    });

    try {
      const dbReadStartedAt = Date.now();
      const rowsByWorkoutId = await FileDBService.loadWorkoutStreamsBulk(uid, workoutIds);
      const dbReadMs = Date.now() - dbReadStartedAt;
      const missingWorkoutIds = workoutIds.filter((workoutId) => !rowsByWorkoutId.has(workoutId));
      if (missingWorkoutIds.length > 0) {
        throw new Error(`Workout streams not found for segment batch: ${missingWorkoutIds.join(",")}`);
      }

      const results = [];
      for (const item of batchItems) {
        const detected = await detectStoredWorkoutSegments(rowsByWorkoutId.get(item.workoutId));
        results.push({
          ...item,
          ...detected
        });
      }

      let persistSegmentsMs = 0;
      const statusUpdateMs = 0;
      let insertStatementCount = 0;
      let prepareSegmentArraysMs = 0;
      let insertSegmentRowsMs = 0;
      const persistSegmentsStartedAt = Date.now();
      const persistResult = await FileDBService.persistSegmentsForWorkoutsBulk(
        uid,
        results,
        "completed",
        null
      );
      persistSegmentsMs = Date.now() - persistSegmentsStartedAt;
      insertStatementCount = Number(persistResult.statementCount || 0);
      prepareSegmentArraysMs = Number(persistResult.prepareArraysMs || 0);
      insertSegmentRowsMs = Number(persistResult.queryMs || 0);

      const elapsedMs = Date.now() - startedAt;
      const batchSize = results.length;
      const dbReadShareMs = dbReadMs / batchSize;
      const persistShareMs = persistSegmentsMs / batchSize;
      const prepareSegmentArraysShareMs = prepareSegmentArraysMs / batchSize;
      const insertSegmentRowsShareMs = insertSegmentRowsMs / batchSize;
      const statusShareMs = statusUpdateMs / batchSize;
      const dataStatementCount = 1 + insertStatementCount;
      const measuredCpuMs = results.reduce((total, result) => total
        + Number(result.metrics.decompressMs || 0)
        + Number(result.metrics.recordRebuildMs || 0)
        + Number(result.metrics.detectAutoMs || 0)
        + Number(result.metrics.detectBestEffortsMs || 0)
        + Number(result.metrics.mapSegmentsMs || 0), 0);
      const overheadShareMs = Math.max(
        0,
        elapsedMs - measuredCpuMs - dbReadMs - persistSegmentsMs - statusUpdateMs
      ) / batchSize;

      for (const result of results) {
        const metrics = {
          segmentCount: result.segments.length,
          dbReadMs: dbReadShareMs,
          ...result.metrics,
          persistSegmentsMs: persistShareMs,
          prepareSegmentArraysMs: prepareSegmentArraysShareMs,
          insertSegmentRowsMs: insertSegmentRowsShareMs,
          statusUpdateMs: statusShareMs,
          cleanupMs: 0,
          batchSize,
          dbStatementsPerWorkout: dataStatementCount / batchSize
        };
        const itemElapsedMs = dbReadShareMs
          + persistShareMs
          + statusShareMs
          + overheadShareMs
          + Number(result.metrics.decompressMs || 0)
          + Number(result.metrics.recordRebuildMs || 0)
          + Number(result.metrics.detectAutoMs || 0)
          + Number(result.metrics.detectBestEffortsMs || 0)
          + Number(result.metrics.mapSegmentsMs || 0);
        recordPostprocessProfile("segment-persist", itemElapsedMs, metrics);
        await recordImportPostprocessOutcome(importJobId, "segment-persist", itemElapsedMs, metrics);
      }

      await job.updateProgress({
        progressPercent: 100,
        batchSize,
        segmentCount: results.reduce((total, result) => total + result.segments.length, 0),
        dataStatementCount
      });

      return {
        progressPercent: 100,
        batchSize,
        dataStatementCount
      };
    } catch (error) {
      await FileDBService.updateWorkoutSegmentProcessingStatusBulk(
        uid,
        workoutIds,
        "failed",
        error.message || "Unknown segment persistence batch error"
      );
      for (let index = 0; index < batchItems.length; index += 1) {
        await recordImportPostprocessOutcome(importJobId, "segment-persist", 0, {}, true);
      }
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
          `SELECT stream, stream_codec FROM workouts WHERE id = $1 AND uid = $2`,
          [workoutId, uid]
        );
        dbReadMs = Date.now() - dbReadStartedAt;
        if (rowResult.rowCount === 0) {
          throw new Error("Workout stream not found for segment recompute");
        }

        const detected = await detectStoredWorkoutSegments(rowResult.rows[0]);
        segments = detected.segments;
        ({
          decompressMs,
          recordRebuildMs,
          detectAutoMs,
          detectBestEffortsMs,
          mapSegmentsMs
        } = detected.metrics);
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
      await recordImportPostprocessOutcome(importJobId, "segment-persist", elapsedMs, {
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
      await recordImportPostprocessOutcome(importJobId, "segment-persist", 0, {}, true);
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

    await WorkoutThumbnailService.upsertThumbnail(workoutId, thumbnailPayload);
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


  if (enableImportWorker) {
    const enqueueRecoverableWoaBundles = async () => {
      if (!WOA_BUNDLE_RECOVERY_ENABLED) return;
      const recoverable = await listRecoverableWoaBundleUploads(100);
      await Promise.all(recoverable.map((bundle) => enqueueWoaBundleRecovery({
        uid: bundle.uid,
        uploadId: bundle.uploadId
      })));
      if (recoverable.length > 0) {
        console.log("[import] woa-bundle.recovery.enqueued", { count: recoverable.length });
      }

      const expired = await listExpiredWoaBundleUploads(WOA_BUNDLE_RECOVERY_RETENTION_HOURS, 100);
      for (const bundle of expired) {
        await Promise.all([
          bundle.workoutsPath,
          bundle.workoutPostprocessPath,
          bundle.gpsBestEffortsPath
        ].filter(Boolean).map((filePath) => fs.promises.rm(filePath, { force: true }).catch(() => {})));
        await deleteWoaBundleUpload(bundle.uid, bundle.uploadId);
      }
      if (expired.length > 0) {
        console.log("[import] woa-bundle.recovery.cleaned", { count: expired.length });
      }
    };

    const worker = new Worker(
      "fit-imports",
      async (job) => {
        if (job.data?.type !== WOA_BUNDLE_RECOVERY_JOB) {
          throw new Error(`Unsupported import queue job: ${job.data?.type ?? job.name}`);
        }

        const { uid, uploadId } = job.data;
        if (!uid || !uploadId) {
          throw new Error("WOA bundle recovery job is missing uid or uploadId");
        }
        const { recoverWoaBundleUpload } = await import("../routes/woaUploads.js");
        return recoverWoaBundleUpload({ uid, uploadId });
      },
      {
        connection: redisConnection,
        concurrency: IMPORT_QUEUE_CONCURRENCY
      }
    );

    worker.on("ready", () => {
      console.log("Import worker is ready");
      enqueueRecoverableWoaBundles().catch((error) => {
        console.error("[import] woa-bundle.recovery.sweep-failed", { error: error.message });
      });
    });

    worker.on("completed", (job) => {
      console.log("[import] woa-bundle.recovery.queue-job.completed", {
        queueJobId: job.id,
        uploadId: job.data?.uploadId
      });
    });

    worker.on("failed", (job, error) => {
      console.error("[import] woa-bundle.recovery.queue-job.failed", {
        queueJobId: job?.id,
        uploadId: job?.data?.uploadId,
        error: error.message
      });
    });

    worker.on("error", (error) => {
      console.error("Import worker error", error);
    });

    if (WOA_BUNDLE_RECOVERY_ENABLED) {
      const recoverySweep = setInterval(() => {
        enqueueRecoverableWoaBundles().catch((error) => {
          console.error("[import] woa-bundle.recovery.sweep-failed", { error: error.message });
        });
      }, WOA_BUNDLE_RECOVERY_SWEEP_MS);
      recoverySweep.unref();
    }
  }

  if (enableSegmentBestEffortsWorker) {
    const segmentBestEffortsWorker = new Worker(
      "segment-best-efforts",
      async (job) => {
        if (job.name === "persist-workout-segments-batch") {
          return await processWorkoutSegmentPersistenceBatchJob(job);
        }

        if (job.name === "persist-workout-segments") {
          return await processWorkoutSegmentPersistenceJob(job);
        }

        if (job.name === "generate-workout-thumbnail") {
          return await processWorkoutThumbnailGenerationJob(job);
        }

        if (job.name === "process-workout-segment-best-efforts") {
          return await processWorkoutSegmentBestEffortsJob(job);
        }

        if (job.name === "process-workout-segment-best-efforts-batch") {
          return await processWorkoutSegmentBestEffortsBatchJob(job);
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
      if (job?.name === "persist-workout-segments" || job?.name === "persist-workout-segments-batch") {
        logPostProcessEvent("segment-persist.failed", {
          queueJobId: job?.id,
          uid: job?.data?.uid,
          workoutId: job?.data?.workoutId ?? null,
          batchSize: Array.isArray(job?.data?.batchItems) ? job.data.batchItems.length : null,
          payloadPath: job?.data?.payloadPath ?? null,
          error: error.message
        });
        console.error("[postprocess] segment-persist.queue-job.failed", {
          queueJobId: job?.id,
          batchSize: Array.isArray(job?.data?.batchItems) ? job.data.batchItems.length : null,
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
        queueJobName: job?.name ?? null,
        uid: job?.data?.uid,
        workoutId: job?.data?.workoutId ?? null,
        batchSize: Array.isArray(job?.data?.workoutIds) ? job.data.workoutIds.length : null,
        segmentIds: Array.isArray(job?.data?.segmentIds) ? job.data.segmentIds : null,
        error: error.message
      });
      console.error("[postprocess] segment-best-efforts.queue-job.failed", {
        queueJobId: job?.id,
        queueJobName: job?.name,
        workoutId: job?.data?.workoutId ?? null,
        batchSize: Array.isArray(job?.data?.workoutIds) ? job.data.workoutIds.length : null,
        segmentIds: Array.isArray(job?.data?.segmentIds) ? job.data.segmentIds : null,
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

        if (job.name === "classify-workout-similarity-batch") {
          return await processWorkoutSimilarityClassificationBatchJob(job);
        }

        throw new Error(`Unsupported workout similarity job: ${job.name}`);
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
        batchSize: Array.isArray(job?.data?.workoutIds) ? job.data.workoutIds.length : null,
        mode: job?.data?.mode ?? null,
        error: error.message
      });
      console.error("[postprocess] similarity.queue-job.failed", {
        queueJobId: job?.id,
        uid: job?.data?.uid,
        batchSize: Array.isArray(job?.data?.workoutIds) ? job.data.workoutIds.length : null,
        error: error.message
      });
    });

    workoutSimilarityWorker.on("error", (error) => {
      console.error("Workout similarity worker error", error);
    });
  }

}
