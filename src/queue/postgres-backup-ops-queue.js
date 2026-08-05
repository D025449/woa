import { Queue } from "bullmq";

import { redisConnection } from "./connection.js";

export const POSTGRES_BACKUP_OPS_QUEUE = "postgres-backup-ops";

export const postgresBackupOpsQueue = new Queue(POSTGRES_BACKUP_OPS_QUEUE, {
  connection: redisConnection,
  defaultJobOptions: {
    removeOnComplete: { age: 24 * 60 * 60, count: 50 },
    removeOnFail: { age: 7 * 24 * 60 * 60, count: 100 }
  }
});
