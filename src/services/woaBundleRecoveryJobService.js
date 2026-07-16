import { importQueue } from "../queue/import-queue.js";

export const WOA_BUNDLE_RECOVERY_JOB = "woa-bundle-recovery";

export async function enqueueWoaBundleRecovery({ uid, uploadId }) {
  return importQueue.add(
    WOA_BUNDLE_RECOVERY_JOB,
    { type: WOA_BUNDLE_RECOVERY_JOB, uid: String(uid), uploadId: String(uploadId) },
    {
      jobId: `woa-bundle-${uid}-${uploadId}`,
      attempts: Math.max(1, Number(process.env.WOA_BUNDLE_RECOVERY_ATTEMPTS) || 3),
      backoff: { type: "exponential", delay: 2000 },
      removeOnComplete: 100,
      removeOnFail: 100
    }
  );
}
