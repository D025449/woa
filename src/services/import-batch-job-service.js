import { QueueEvents } from "bullmq";

import { redisConnection } from "../queue/connection.js";
import { importBatchQueue } from "../queue/import-batch-queue.js";

const DEFAULT_BATCH_SIZE = 10;

let importBatchQueueEvents = null;

function getImportBatchQueueEvents() {
  if (!importBatchQueueEvents) {
    importBatchQueueEvents = new QueueEvents("fit-import-batches", {
      connection: redisConnection
    });
  }

  return importBatchQueueEvents;
}

export function chunkImportBatchItems(items = [], batchSize = DEFAULT_BATCH_SIZE) {
  const normalizedBatchSize = Math.max(1, Number(batchSize) || DEFAULT_BATCH_SIZE);
  const batches = [];

  for (let index = 0; index < items.length; index += normalizedBatchSize) {
    batches.push(items.slice(index, index + normalizedBatchSize));
  }

  return batches;
}

export async function enqueueImportBatchJobs({
  importJobId,
  uid,
  items = [],
  shareConfig = null,
  batchSize = DEFAULT_BATCH_SIZE
}) {
  if (!importJobId) {
    throw new Error("importJobId is required");
  }

  if (!uid) {
    throw new Error("uid is required");
  }

  const normalizedItems = Array.isArray(items) ? items.filter(Boolean) : [];
  const batches = chunkImportBatchItems(normalizedItems, batchSize);

  const jobs = await Promise.all(
    batches.map((batchItems, batchIndex) => importBatchQueue.add(
      "process-fit-import-batch",
      {
        importJobId,
        uid,
        shareConfig,
        batchIndex,
        batchItems
      },
      {
        attempts: 2,
        backoff: {
          type: "exponential",
          delay: 2000
        },
        removeOnComplete: 100,
        removeOnFail: 100,
        jobId: `fit-import-batch:${importJobId}:${batchIndex}`
      }
    ))
  );

  return {
    queueEvents: getImportBatchQueueEvents(),
    jobs
  };
}
