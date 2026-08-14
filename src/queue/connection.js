import IORedis from 'ioredis';

const RedisConstructor = /** @type {typeof import('ioredis').Redis} */ (
  /** @type {unknown} */ (IORedis)
);

export const redisConnection = /** @type {import('bullmq').ConnectionOptions} */ (
  /** @type {unknown} */ (new RedisConstructor(process.env.REDIS_URL, {
    maxRetriesPerRequest: null
  }))
);
