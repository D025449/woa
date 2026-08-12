import { Queue } from "bullmq";

import { redisConnection } from "./connection.js";

export const WORKOUT_INTENSITY_QUEUE = "workout-intensity";

export const workoutIntensityQueue = new Queue(WORKOUT_INTENSITY_QUEUE, {
  connection: redisConnection
});

workoutIntensityQueue.setMaxListeners(0);
