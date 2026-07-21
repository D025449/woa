import { segmentBestEffortsQueue } from "../queue/segment-best-efforts-queue.js";
import { buildImportScopedJobId } from "./import-scoped-job-id.js";
import { groupSegmentPersistenceItems } from "./segment-persistence-batches.js";
import { groupWorkoutSegmentBestEffortItems } from "./segment-best-efforts-batches.js";

export const SEGMENT_PERSIST_BATCH_SIZE = Math.max(
  1,
  Math.floor(Number(process.env.SEGMENT_PERSIST_BATCH_SIZE) || 200)
);

export const SEGMENT_BEST_EFFORTS_BATCH_SIZE = Math.max(
  1,
  Math.floor(Number(process.env.SEGMENT_BEST_EFFORTS_BATCH_SIZE) || 100)
);

export const SEGMENT_SCAN_BATCH_SIZE = Math.max(
  1,
  Math.floor(Number(process.env.SEGMENT_SCAN_BATCH_SIZE) || 32)
);

function buildQueueOptions(jobId) {
  return {
    attempts: 2,
    backoff: {
      type: "exponential",
      delay: 2000
    },
    removeOnComplete: 100,
    removeOnFail: 100,
    jobId
  };
}

function buildSegmentPersistenceJob({ uid, workoutId, payloadPath = null, entryName = null, recomputeFromDb = false, importJobId = null }) {
  const baseJobId = `persist-workout-segments:${uid}:${Number(workoutId)}`;
  return {
    name: "persist-workout-segments",
    data: {
      uid,
      workoutId: Number(workoutId),
      payloadPath,
      entryName,
      recomputeFromDb: !!recomputeFromDb,
      importJobId
    },
    opts: buildQueueOptions(buildImportScopedJobId(baseJobId, importJobId))
  };
}

function buildWorkoutSegmentBestEffortsJob({ uid, workoutId, importJobId = null }) {
  const baseJobId = `process-workout-segment-best-efforts:${uid}:${Number(workoutId)}`;
  return {
    name: "process-workout-segment-best-efforts",
    data: {
      uid,
      workoutId: Number(workoutId),
      importJobId
    },
    opts: buildQueueOptions(buildImportScopedJobId(baseJobId, importJobId))
  };
}

function buildWorkoutSegmentBestEffortsBatchJob(items) {
  const firstItem = items[0];
  const lastItem = items[items.length - 1];
  const uid = firstItem.uid;
  const importJobId = firstItem.importJobId ?? null;
  const baseJobId = `process-workout-segment-best-efforts-batch:${uid}:${Number(firstItem.workoutId)}-${Number(lastItem.workoutId)}`;
  return {
    name: "process-workout-segment-best-efforts-batch",
    data: {
      uid,
      importJobId,
      workoutIds: items.map((item) => Number(item.workoutId))
    },
    opts: buildQueueOptions(buildImportScopedJobId(baseJobId, importJobId))
  };
}

function buildSegmentPersistenceBatchJob(items) {
  const firstItem = items[0];
  const lastItem = items[items.length - 1];
  const uid = firstItem.uid;
  const importJobId = firstItem.importJobId ?? null;
  const baseJobId = `persist-workout-segments-batch:${uid}:${Number(firstItem.workoutId)}-${Number(lastItem.workoutId)}`;

  return {
    name: "persist-workout-segments-batch",
    data: {
      uid,
      importJobId,
      batchItems: items.map((item) => ({
        workoutId: Number(item.workoutId),
        entryName: item.entryName ?? null
      }))
    },
    opts: buildQueueOptions(buildImportScopedJobId(baseJobId, importJobId))
  };
}

export async function enqueueWorkoutSegmentPersistence({ uid, workoutId, payloadPath = null, entryName = null, recomputeFromDb = false, importJobId = null }) {
  if (!uid || !Number.isInteger(Number(workoutId)) || (!payloadPath && !recomputeFromDb)) {
    return null;
  }

  const job = buildSegmentPersistenceJob({ uid, workoutId, payloadPath, entryName, recomputeFromDb, importJobId });
  return segmentBestEffortsQueue.add(job.name, job.data, job.opts);
}

export async function enqueueWorkoutThumbnailGeneration({ uid, workoutId, payloadPath, entryName = null, importJobId = null }) {
  if (!uid || !Number.isInteger(Number(workoutId)) || !payloadPath) {
    return null;
  }

  return segmentBestEffortsQueue.add(
    "generate-workout-thumbnail",
    {
      uid,
      workoutId: Number(workoutId),
      payloadPath,
      entryName,
      importJobId
    },
    {
      attempts: 2,
      backoff: {
        type: "exponential",
        delay: 2000
      },
      removeOnComplete: 100,
      removeOnFail: 100,
      jobId: buildImportScopedJobId(
        `generate-workout-thumbnail:${uid}:${Number(workoutId)}`,
        importJobId
      )
    }
  );
}

export async function enqueueWorkoutSegmentBestEfforts({ uid, workoutId, importJobId = null }) {
  if (!uid || !Number.isInteger(Number(workoutId))) {
    return null;
  }

  const job = buildWorkoutSegmentBestEffortsJob({ uid, workoutId, importJobId });
  return segmentBestEffortsQueue.add(job.name, job.data, job.opts);
}

export async function enqueueWorkoutSegmentPersistenceBulk(items = []) {
  const validItems = items.filter((item) =>
    item?.uid
    && Number.isInteger(Number(item?.workoutId))
    && (item?.payloadPath || item?.recomputeFromDb)
  );
  const jobs = groupSegmentPersistenceItems(validItems, SEGMENT_PERSIST_BATCH_SIZE)
    .map((group) => group.type === "batch"
      ? buildSegmentPersistenceBatchJob(group.items)
      : buildSegmentPersistenceJob(group.items[0]));
  if (jobs.length === 0) {
    return [];
  }
  return segmentBestEffortsQueue.addBulk(jobs);
}

export async function enqueueWorkoutSegmentBestEffortsBulk(items = []) {
  const jobs = groupWorkoutSegmentBestEffortItems(items, SEGMENT_BEST_EFFORTS_BATCH_SIZE)
    .map((group) => buildWorkoutSegmentBestEffortsBatchJob(group));
  if (jobs.length === 0) {
    return [];
  }
  return segmentBestEffortsQueue.addBulk(jobs);
}

export async function enqueueSegmentBestEfforts({ uid, segmentIds }) {
  if (!uid || !Array.isArray(segmentIds) || segmentIds.length === 0) {
    return null;
  }

  const normalizedSegmentIds = [...new Set(
    segmentIds
      .map((segmentId) => Number(segmentId))
      .filter((segmentId) => Number.isInteger(segmentId) && segmentId > 0)
  )];
  if (normalizedSegmentIds.length === 0) {
    return null;
  }

  const segmentIdGroups = [];
  for (let index = 0; index < normalizedSegmentIds.length; index += SEGMENT_SCAN_BATCH_SIZE) {
    segmentIdGroups.push(normalizedSegmentIds.slice(index, index + SEGMENT_SCAN_BATCH_SIZE));
  }

  return segmentBestEffortsQueue.addBulk(segmentIdGroups.map((group) => ({
    name: "process-segment-best-efforts",
    data: {
      uid,
      segmentIds: group
    },
    opts: {
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 2000
      },
      removeOnComplete: 100,
      removeOnFail: 100
    }
  })));
}
