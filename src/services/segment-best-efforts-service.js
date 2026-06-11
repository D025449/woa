import { segmentBestEffortsQueue } from "../queue/segment-best-efforts-queue.js";

export async function enqueueWorkoutSegmentPersistence({ uid, workoutId, payloadPath, entryName = null }) {
  if (!uid || !Number.isInteger(Number(workoutId)) || !payloadPath) {
    return null;
  }

  return segmentBestEffortsQueue.add(
    "persist-workout-segments",
    {
      uid,
      workoutId: Number(workoutId),
      payloadPath,
      entryName
    },
    {
      attempts: 2,
      backoff: {
        type: "exponential",
        delay: 2000
      },
      removeOnComplete: 100,
      removeOnFail: 100,
      jobId: `persist-workout-segments:${uid}:${Number(workoutId)}`
    }
  );
}

export async function enqueueWorkoutThumbnailGeneration({ uid, workoutId, payloadPath, entryName = null }) {
  if (!uid || !Number.isInteger(Number(workoutId)) || !payloadPath) {
    return null;
  }

  return segmentBestEffortsQueue.add(
    "generate-workout-thumbnail",
    {
      uid,
      workoutId: Number(workoutId),
      payloadPath,
      entryName
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

export async function enqueueWorkoutSegmentBestEfforts({ uid, workoutId }) {
  if (!uid || !Number.isInteger(Number(workoutId))) {
    return null;
  }

  return segmentBestEffortsQueue.add(
    "process-workout-segment-best-efforts",
    {
      uid,
      workoutId: Number(workoutId)
    },
    {
      attempts: 2,
      backoff: {
        type: "exponential",
        delay: 2000
      },
      removeOnComplete: 100,
      removeOnFail: 100,
      jobId: `process-workout-segment-best-efforts:${uid}:${Number(workoutId)}`
    }
  );
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
