const asString = (value, fallback = undefined) => {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  return String(value);
};

const asNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const appEnv = {
  NODE_ENV: asString(process.env.NODE_ENV, "production"),
  PORT: asNumber(process.env.PORT, 3000),
  COGNITO_REGION: asString(process.env.COGNITO_REGION, "eu-central-1"),
  COGNITO_USER_POOL_ID: asString(process.env.COGNITO_USER_POOL_ID, "eu-central-1_FGuEMHRmT"),
  COGNITO_CLIENT_ID: asString(process.env.COGNITO_CLIENT_ID, ""),
  COGNITO_CLIENT_SECRET: asString(process.env.COGNITO_CLIENT_SECRET),
  COGNITO_DOMAIN: asString(process.env.COGNITO_DOMAIN, "https://eu-central-1fguemhrmt.auth.eu-central-1.amazoncognito.com"),
  COGNITO_REDIRECT_URI: asString(process.env.COGNITO_REDIRECT_URI, "https://cwa24.de/auth/callback"),
  APP_BASE_URL: asString(process.env.APP_BASE_URL, "https://cwa24.de"),
  SESSION_SECRET: asString(process.env.SESSION_SECRET),
  DB_HOST: asString(process.env.DB_HOST, "localhost"),
  DB_PORT: asNumber(process.env.DB_PORT, 5432),
  DB_NAME: asString(process.env.DB_NAME, "cwa24_prod"),
  DB_USER: asString(process.env.DB_USER, "cwa24user"),
  DB_PASSWORD: asString(process.env.DB_PASSWORD),
  AWS_ACCESS_KEY_ID: asString(process.env.AWS_ACCESS_KEY_ID),
  AWS_SECRET_ACCESS_KEY: asString(process.env.AWS_SECRET_ACCESS_KEY),
  AWS_REGION: asString(process.env.AWS_REGION, "eu-central-1"),
  S3_BUCKET: asString(process.env.S3_BUCKET, "cwa24bucketprod"),
  REDIS_URL: asString(process.env.REDIS_URL, "redis://127.0.0.1:6379"),
  WOA_TEMP_DIR: asString(process.env.WOA_TEMP_DIR),
  PAYPAL_ENV: asString(process.env.PAYPAL_ENV, "live"),
  PAYPAL_CLIENT_ID: asString(process.env.PAYPAL_CLIENT_ID),
  PAYPAL_CLIENT_SECRET: asString(process.env.PAYPAL_CLIENT_SECRET),
  OPENAI_API_KEY: asString(process.env.OPENAI_API_KEY),
  OPENAI_MODEL: asString(process.env.OPENAI_MODEL, "gpt-5-mini"),
  MAPTILER_API_KEY: asString(process.env.MAPTILER_API_KEY),
  FEATURE_FUN_SUDOKU: asString(process.env.FEATURE_FUN_SUDOKU, "0"),
  FEATURE_THUMBNAILS_ON_DEMAND: asString(process.env.FEATURE_THUMBNAILS_ON_DEMAND, "1")
};

const dbEnv = {
  NODE_ENV: asString(process.env.NODE_ENV, "production"),
  DB_HOST: asString(process.env.DB_HOST, "localhost"),
  DB_PORT: asNumber(process.env.DB_PORT, 5432),
  DB_NAME: asString(process.env.DB_NAME, "cwa24_prod"),
  DB_USER: asString(process.env.DB_USER, "cwa24user"),
  DB_PASSWORD: asString(process.env.DB_PASSWORD)
};

const workerEnv = {
  ...dbEnv,
  AWS_ACCESS_KEY_ID: asString(process.env.AWS_ACCESS_KEY_ID),
  AWS_SECRET_ACCESS_KEY: asString(process.env.AWS_SECRET_ACCESS_KEY),
  AWS_REGION: asString(process.env.AWS_REGION, "eu-central-1"),
  S3_BUCKET: asString(process.env.S3_BUCKET, "cwa24bucketprod"),
  REDIS_URL: asString(process.env.REDIS_URL, "redis://127.0.0.1:6379"),
  WOA_TEMP_DIR: asString(process.env.WOA_TEMP_DIR),
  FIT_PARSER_VARIANT: asString(process.env.FIT_PARSER_VARIANT, "fast"),
  IMPORT_QUEUE_CONCURRENCY: asString(process.env.IMPORT_QUEUE_CONCURRENCY),
  IMPORT_BATCH_WORKER_CONCURRENCY: asString(process.env.IMPORT_BATCH_WORKER_CONCURRENCY),
  IMPORT_POSTPROCESS_MODE: asString(process.env.IMPORT_POSTPROCESS_MODE),
  IMPORT_POSTPROCESS_LOGS: asString(process.env.IMPORT_POSTPROCESS_LOGS),
  IMPORT_SYNC_PROFILE_LOG: asString(process.env.IMPORT_SYNC_PROFILE_LOG),
  IMPORT_TIMING_DEBUG: asString(process.env.IMPORT_TIMING_DEBUG),
  IMPORT_VERBOSE_LOGS: asString(process.env.IMPORT_VERBOSE_LOGS),
  FEATURE_THUMBNAILS_ON_DEMAND: asString(process.env.FEATURE_THUMBNAILS_ON_DEMAND, "1")
};

module.exports = {
  apps: [
    {
      name: "cwa24",
      script: "src/index.js",
      env: appEnv,
      env_production: appEnv
    },
    {
      name: "migrate",
      script: "src/migrate.js",
      autorestart: false,
      env: dbEnv,
      env_production: dbEnv
    },
    {
      name: "import-worker",
      script: "src/workers/import-worker.js",
      instances: 1,
      exec_mode: "fork",
      env: workerEnv,
      env_production: workerEnv
    },
    {
      name: "import-batch-worker",
      script: "src/workers/import-batch-worker.js",
      instances: 2,
      exec_mode: "fork",
      env: workerEnv,
      env_production: workerEnv
    }
  ]
};
