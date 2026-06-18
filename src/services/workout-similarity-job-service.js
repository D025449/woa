import { workoutSimilarityQueue } from "../queue/workout-similarity-queue.js";

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
  return {
    name: "classify-workout-similarity",
    data: {
      uid,
      workoutId: Number(workoutId),
      importJobId
    },
    opts: buildQueueOptions(`classify-workout-similarity:${uid}:${Number(workoutId)}`)
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
  const jobs = items
    .filter((item) => item?.uid && Number.isInteger(Number(item?.workoutId)))
    .map((item) => buildWorkoutSimilarityClassificationJob(item));
  if (jobs.length === 0) {
    return [];
  }
  return workoutSimilarityQueue.addBulk(jobs);
}

export async function enqueueWorkoutSimilarityRebuild({ uid, mode = "delta" }) {
  if (!uid) {
    throw new Error("uid is required");
  }

  const normalizedMode = String(mode || "delta").trim().toLowerCase() === "full"
    ? "full"
    : "delta";

  const job = await workoutSimilarityQueue.add(
    "rebuild-workout-similarity",
    { uid, mode: normalizedMode },
    {
      attempts: 2,
      backoff: {
        type: "exponential",
        delay: 2000
      },
      removeOnComplete: 100,
      removeOnFail: 100
    }
  );

  return { id: job.id };
}

export async function getWorkoutSimilarityRebuildJob(jobId) {
  const job = await workoutSimilarityQueue.getJob(jobId);
  if (!job) {
    return null;
  }

  const state = await job.getState();
  const progress = job.progress && typeof job.progress === "object"
    ? job.progress
    : { progressPercent: Number(job.progress || 0) };

  return {
    id: job.id,
    uid: job.data?.uid ?? null,
    mode: job.data?.mode ?? "delta",
    status: state,
    progressPercent: Number(progress.progressPercent || 0),
    workoutCount: Number(progress.workoutCount || 0),
    processedWorkouts: Number(progress.processedWorkouts || 0),
    edgeCount: Number(progress.edgeCount || 0),
    errorMessage: job.failedReason || null,
    returnvalue: job.returnvalue || null
  };
}
