import { Queue } from "bullmq";
import { redisConnection } from "./connection.js";

export const segmentBestEffortsQueue = new Queue("segment-best-efforts", {
  connection: redisConnection
});
