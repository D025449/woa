export const PUBLIC_API_QUOTAS = Object.freeze({ ingress: 480, user: 240,
  analytics: 40, gps: 40, fit: 40, oauth: 120 });

export const PUBLIC_ANALYTICS_LIMITS = Object.freeze({ rows: 50000,
  historyDays: 20000, ftpRows: 500, responseBytes: 1024 * 1024, concurrent: 2 });

export async function spawnPublicApiWorker({ workerUrl, workerData, resourceLimits,
  timeoutMs, validateMessage, errorMessage, tooLargeCode }) {
  const { Worker } = await import("node:worker_threads");
  const worker = new Worker(workerUrl, { workerData, resourceLimits });
  try {
    return await new Promise((resolve, reject) => {
      const failure = status => reject(Object.assign(new Error(errorMessage),
        { statusCode: status, code: status === 422 ? tooLargeCode : "service_unavailable" }));
      const timer = setTimeout(() => failure(422), timeoutMs);
      worker.once("message", message => {
        clearTimeout(timer);
        const result = validateMessage(message);
        if (result != null) resolve(result);
        else failure(message.statusCode === 422 ? 422 : 503);
      });
      worker.once("error", error => {
        clearTimeout(timer);
        failure(error?.code === "ERR_WORKER_OUT_OF_MEMORY" ? 422 : 503);
      });
      worker.once("exit", () => { clearTimeout(timer); failure(503); });
    });
  } finally {
    await worker.terminate().catch(() => {});
  }
}
