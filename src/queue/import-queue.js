import { Queue } from 'bullmq';
import { redisConnection } from './connection.js';

export const importQueue = new Queue('fit-imports', {
    connection: redisConnection
});