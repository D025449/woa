import { workoutIntensityQueue } from "../queue/workout-intensity-queue.js";
import { buildImportScopedJobId } from "./import-scoped-job-id.js";

export const WORKOUT_INTENSITY_RECLASSIFICATION_JOB = "reclassify-workout-intensity";

function normalizeStartTimes(startTimes = []) {
  return [...new Set((Array.isArray(startTimes) ? startTimes : [])
    .map((value) => new Date(value))
    .filter((value) => !Number.isNaN(value.getTime()))
    .map((value) => value.toISOString()))].sort();
}

function normalizeWorkoutIds(workoutIds = []) {
  return [...new Set((Array.isArray(workoutIds) ? workoutIds : [])
    .filter((value) => value != null && String(value).length > 0)
    .map(String))];
}

export async function enqueueWorkoutIntensityReclassification({
  uid,
  startTimes,
  changedWorkoutIds = [],
  importJobId = null
}) {
  if (!uid) throw new Error("uid is required");
  const normalizedStartTimes = normalizeStartTimes(startTimes);
  if (normalizedStartTimes.length === 0) return null;

  const baseJobId = `reclassify-workout-intensity:${uid}`;
  return workoutIntensityQueue.add(
    WORKOUT_INTENSITY_RECLASSIFICATION_JOB,
    {
      uid: String(uid),
      startTimes: normalizedStartTimes,
      changedWorkoutIds: normalizeWorkoutIds(changedWorkoutIds),
      importJobId: importJobId == null ? null : String(importJobId)
    },
    {
      jobId: buildImportScopedJobId(baseJobId, importJobId),
      attempts: 2,
      backoff: { type: "exponential", delay: 2000 },
      removeOnComplete: 100,
      removeOnFail: 100
    }
  );
}
