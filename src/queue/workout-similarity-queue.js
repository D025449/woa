import { Queue } from "bullmq";
import { redisConnection } from "./connection.js";

export const workoutSimilarityQueue = new Queue("workout-similarity", {
  connection: redisConnection
});
