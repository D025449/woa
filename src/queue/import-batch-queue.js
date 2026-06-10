import { Queue } from "bullmq";
import { redisConnection } from "./connection.js";

export const importBatchQueue = new Queue("fit-import-batches", {
  connection: redisConnection
});
