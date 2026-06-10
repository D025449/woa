import { segmentBestEffortsQueue } from "../queue/segment-best-efforts-queue.js";

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
