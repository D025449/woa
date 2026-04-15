import { segmentBestEffortsQueue } from "../queue/segment-best-efforts-queue.js";

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
