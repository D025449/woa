import { Queue } from "bullmq";
import { redisConnection } from "./connection.js";

export const importBatchQueue = new Queue("fit-import-batches", {
  connection: redisConnection
});

// We can wait on many batch jobs concurrently during large imports.
// BullMQ attaches internal "closing" listeners per wait, which exceeds
// Node's default EventEmitter warning threshold even though this is expected.
importBatchQueue.setMaxListeners(0);
