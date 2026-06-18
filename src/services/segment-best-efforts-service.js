import { segmentBestEffortsQueue } from "../queue/segment-best-efforts-queue.js";

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
    opts: buildQueueOptions(`persist-workout-segments:${uid}:${Number(workoutId)}`)
  };
}

function buildWorkoutSegmentBestEffortsJob({ uid, workoutId, importJobId = null }) {
  return {
    name: "process-workout-segment-best-efforts",
    data: {
      uid,
      workoutId: Number(workoutId),
      importJobId
    },
    opts: buildQueueOptions(`process-workout-segment-best-efforts:${uid}:${Number(workoutId)}`)
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
      jobId: `generate-workout-thumbnail:${uid}:${Number(workoutId)}`
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
  const jobs = items
    .filter((item) => item?.uid && Number.isInteger(Number(item?.workoutId)) && (item?.payloadPath || item?.recomputeFromDb))
    .map((item) => buildSegmentPersistenceJob(item));
  if (jobs.length === 0) {
    return [];
  }
  return segmentBestEffortsQueue.addBulk(jobs);
}

export async function enqueueWorkoutSegmentBestEffortsBulk(items = []) {
  const jobs = items
    .filter((item) => item?.uid && Number.isInteger(Number(item?.workoutId)))
    .map((item) => buildWorkoutSegmentBestEffortsJob(item));
  if (jobs.length === 0) {
    return [];
  }
  return segmentBestEffortsQueue.addBulk(jobs);
}

export async function enqueueSegmentBestEfforts({ uid, segmentIds }) {
  if (!uid || !Array.isArray(segmentIds) || segmentIds.length === 0) {
    return null;
  }

  return segmentBestEffortsQueue.add(
    "process-segment-best-efforts",
    {
      uid,
      segmentIds
    },
    {
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 2000
      },
      removeOnComplete: 100,
      removeOnFail: 100
    }
  );
}
