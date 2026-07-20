import { workoutSimilarityQueue } from "../queue/workout-similarity-queue.js";
import { buildImportScopedJobId } from "./import-scoped-job-id.js";
import { groupWorkoutSimilarityItems } from "./workout-similarity-batches.js";

export const WORKOUT_SIMILARITY_BATCH_SIZE = Math.max(
  1,
  Math.floor(Number(process.env.WORKOUT_SIMILARITY_BATCH_SIZE) || 100)
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

function buildWorkoutSimilarityClassificationJob({ uid, workoutId, importJobId = null }) {
  const baseJobId = `classify-workout-similarity:${uid}:${Number(workoutId)}`;
  return {
    name: "classify-workout-similarity",
    data: {
      uid,
      workoutId: Number(workoutId),
      importJobId
    },
    opts: buildQueueOptions(buildImportScopedJobId(baseJobId, importJobId))
  };
}

function buildWorkoutSimilarityClassificationBatchJob(items) {
  const firstItem = items[0];
  const lastItem = items[items.length - 1];
  const uid = firstItem.uid;
  const importJobId = firstItem.importJobId ?? null;
  const baseJobId = `classify-workout-similarity-batch:${uid}:${Number(firstItem.workoutId)}-${Number(lastItem.workoutId)}`;

  return {
    name: "classify-workout-similarity-batch",
    data: {
      uid,
      importJobId,
      workoutIds: items.map((item) => Number(item.workoutId))
    },
    opts: buildQueueOptions(buildImportScopedJobId(baseJobId, importJobId))
  };
}

export async function enqueueWorkoutSimilarityClassification({ uid, workoutId, importJobId = null }) {
  if (!uid) {
    throw new Error("uid is required");
  }

  if (!Number.isInteger(Number(workoutId))) {
    throw new Error("workoutId is required");
  }

  const job = buildWorkoutSimilarityClassificationJob({ uid, workoutId, importJobId });
  return workoutSimilarityQueue.add(job.name, job.data, job.opts);
}

export async function enqueueWorkoutSimilarityClassificationBulk(items = []) {
  const jobs = groupWorkoutSimilarityItems(items, WORKOUT_SIMILARITY_BATCH_SIZE)
    .map((group) => buildWorkoutSimilarityClassificationBatchJob(group));
  if (jobs.length === 0) {
    return [];
  }
  return workoutSimilarityQueue.addBulk(jobs);
}
