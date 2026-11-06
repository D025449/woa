import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import dotenv from "dotenv";
import sharp from "sharp";
import { applyRuntimeDatabasePointer } from "../../ops/postgres-backup/runtime-database.mjs";

export function selectGpsBenchmarkSample(rows, limit) {
  if (!rows.length) return [];
  const count = Math.min(limit, rows.length);
  return Array.from({ length: count }, (_, index) => rows[count === 1 ? 0 : Math.round(index * (rows.length - 1) / (count - 1))]);
}

export async function compareGpsThumbnailPixels(referenceSvg, candidateSvg) {
  const reference = await sharp(Buffer.from(referenceSvg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const candidate = await sharp(Buffer.from(candidateSvg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { identicalPixels: reference.info.width === candidate.info.width && reference.info.height === candidate.info.height
    && reference.data.equals(candidate.data), identicalSvg: referenceSvg === candidateSvg,
  referencePixelHash: createHash("sha256").update(reference.data).digest("hex"),
  candidatePixelHash: createHash("sha256").update(candidate.data).digest("hex") };
}

export async function createGpsBenchmarkConnection(pool, namespace) {
  const client = await pool.connect();
  return {
    async query(sql, parameters) {
      if (sql === "BEGIN") {
        await client.query("BEGIN");
        await client.query(`CREATE TEMP TABLE workout_thumbnails (
          workout_id bigint PRIMARY KEY, kind text NOT NULL, mime_type text NOT NULL,
          width integer NOT NULL, height integer NOT NULL, content text NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT NOW()
        ) ON COMMIT DROP`);
        const result = await client.query(`SELECT to_regclass('workout_thumbnails') =
          to_regclass('pg_temp.workout_thumbnails') AS isolated`);
        if (result.rows[0]?.isolated !== true) throw new Error("Temporary thumbnail table isolation failed");
        return { rows: [] };
      }
      if (sql.startsWith("SELECT pg_advisory_xact_lock")) {
        return client.query(sql, [`woa:gps-benchmark:${namespace}:${parameters[0]}`]);
      }
      return client.query(sql, parameters);
    },
    release() { client.release(); }
  };
}

function summary(values) {
  const sorted = values.filter(Number.isFinite).sort((first, second) => first - second);
  if (!sorted.length) return null;
  return { mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    p50: sorted[Math.floor((sorted.length - 1) * 0.5)], p95: sorted[Math.ceil((sorted.length - 1) * 0.95)], max: sorted.at(-1) };
}

async function closeMapClient(client) {
  const exited = client.worker ? new Promise(resolve => client.worker.once("exit", resolve)) : Promise.resolve();
  client.close();
  await exited;
}

export async function runGpsThumbnailBenchmark(argv) {
  const { values } = parseArgs({ args: argv, options: { "env-file": { type: "string" }, limit: { type: "string", default: "6" },
    "compare-pixels": { type: "boolean", default: false }, "png-memory": { type: "boolean", default: false },
    "raw-memory": { type: "boolean", default: false } } });
  if (values["png-memory"] && values["raw-memory"]) throw new Error("Select only one memory cache mode");
  const limit = Number(values.limit);
  const envFile = values["env-file"];
  if (!envFile || path.basename(envFile) !== ".env.development" || !Number.isInteger(limit) || limit < 1 || limit > 12) {
    throw new Error("Specify --env-file .env.development and --limit 1..12");
  }
  const loaded = dotenv.config({ path: path.resolve(envFile), override: true, quiet: true });
  if (loaded.error || !loaded.parsed?.DB_NAME || !loaded.parsed.DB_USER
    || loaded.parsed.NODE_ENV && loaded.parsed.NODE_ENV !== "development") throw new Error("Development environment required");
  if (!["localhost", "127.0.0.1", "::1"].includes(process.env.DB_HOST || "localhost")) throw new Error("Local development database required");
  process.env.NODE_ENV = "development";
  applyRuntimeDatabasePointer(process.env);
  const [{ default: pool }, { default: ThumbnailService }, { LocalThumbnailMapClient }, { getLocalThumbnailMapConfig },
    { readMapArchiveSet }, { withMapStorageBudget }] = await Promise.all([
    import("../services/database.js"), import("../services/workoutThumbnailService.js"),
    import("../services/localThumbnailMapService.js"), import("../config/storagePaths.js"), import("../services/localMapArchiveSetService.js"),
    import("../services/localMapStorageService.js")
  ]);
  const config = getLocalThumbnailMapConfig();
  if (!config.enabled || !readMapArchiveSet(config.dataDirectory).active.archives.length) {
    await pool.end();
    throw new Error("Local provider and installed map archives required");
  }
  const namespace = randomUUID();
  const directory = path.join(config.cacheRoot, `gps-benchmark-${namespace}`);
  const reports = [];
  let mapClient;
  try {
    const identity = await pool.query("SELECT current_database() AS name");
    if (identity.rows[0]?.name !== process.env.DB_NAME) throw new Error("Unexpected development database");
    const inventory = await pool.query(`SELECT id, octet_length(gps_track_blob) AS gps_bytes
      FROM workouts WHERE validgps = true AND gps_track_blob IS NOT NULL
      ORDER BY octet_length(gps_track_blob), id`);
    const sample = selectGpsBenchmarkSample(inventory.rows, limit);
    if (!sample.length) throw new Error("No GPS workout blobs available");
    await mkdir(directory, { recursive: true });
    const connectionFactory = () => createGpsBenchmarkConnection(pool, namespace);
    for (const concurrency of [1, 3, 6]) {
      const localMapConfig = { ...config, cacheRoot: path.join(directory, `concurrency-${concurrency}`),
        storageCacheRoot: config.cacheRoot, allowCacheEviction: false, rawPixelCache: values["raw-memory"] };
      for (const mode of ["cold", "disk", "ram"]) {
        if (mode !== "ram") {
          if (mapClient) await closeMapClient(mapClient);
          mapClient = new LocalThumbnailMapClient();
        }
        const cpuStarted = process.cpuUsage();
        const resourcesStarted = process.resourceUsage();
        const startedAt = performance.now();
        const delay = monitorEventLoopDelay({ resolution: 20 });
        delay.enable();
        let peakRss = process.memoryUsage().rss;
        const memorySampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 20);
        const results = [];
        try {
          let next = 0;
          await Promise.all(Array.from({ length: Math.min(concurrency, sample.length) }, async () => {
            while (next < sample.length) {
              const workout = sample[next++];
              const thumbnail = await ThumbnailService.generateThumbnailForWorkout(workout.id, {
                skipExistingCheck: true, connectionFactory, localMapClient: mapClient, localMapConfig
              });
              results.push({ workoutId: workout.id, gpsBytes: workout.gps_bytes,
                success: ThumbnailService.hasMapBackground(thumbnail), svgBytes: Buffer.byteLength(thumbnail?.content || ""),
                profile: thumbnail?.generationProfile || null });
            }
          }));
        } finally { clearInterval(memorySampler); delay.disable(); }
        const wallMs = performance.now() - startedAt;
        const cpu = process.cpuUsage(cpuStarted);
        const resources = process.resourceUsage();
        const timings = {};
        for (const key of ["generationEndToEndMs", "generationQueueMs", "dbConnectionWaitMs", "advisoryLockMs", "dbConnectionHeldMs",
          "loadWorkoutMs", "decodeGpsTrackMs", "loadWorkoutSegmentsMs", "loadGpsCandidatesMs", "loadGpsDefinitionsMs", "matchGpsSegmentsMs",
          "renderSvgMs", "persistThumbnailMs"]) timings[key] = summary(results.map(result => result.profile?.[key]));
        for (const key of ["ms", "workerQueueMs", "workerServiceMs", "workerStartupMs", "workerInitializationMs"]) {
          timings[`map.${key}`] = summary(results.map(result => result.profile?.localMap?.[key]));
        }
        for (const key of ["viewportMs", "tileAssemblyMs", "mosaicDecodeCompositeMs", "labelPlacementMs", "outputPipelineMs", "finishSvgMs"]) {
          timings[`render.${key}`] = summary(results.map(result => result.profile?.localMap?.renderProfile?.[key]));
        }
        for (const key of ["cacheReadMs", "vectorBuildMs", "tileLoadDecodeMs", "geometryBuildMs", "rasterizeMs", "vectorSources",
          "identicalSourceRows", "storageReservationMs", "cacheFileWriteMs", "cacheTrimMs", "cacheWriteMs", "pixelDecodeMs"]) {
          timings[`tile.${key}`] = summary(results.map(result => result.profile?.localMap?.tileProfile?.[key]));
        }
        const report = { mode, concurrency, rawPixelCache: localMapConfig.rawPixelCache,
          workouts: results.length, successful: results.filter(result => result.success).length,
          wallMs, workoutsPerSecond: results.length * 1000 / wallMs, cpuMs: (cpu.user + cpu.system) / 1000,
          peakRssBytes: Math.max(peakRss, process.memoryUsage().rss), filesystemReads: resources.fsRead - resourcesStarted.fsRead,
          filesystemWrites: resources.fsWrite - resourcesStarted.fsWrite, eventLoopDelayMaxMs: delay.max / 1e6, timings, results };
        reports.push(report);
        console.log(JSON.stringify(report));
      }
    }
    const imageComparisons = [];
    if (values["compare-pixels"]) {
      const references = new Map();
      for (const rawPixelCache of [false, true]) {
        if (mapClient) await closeMapClient(mapClient);
        mapClient = new LocalThumbnailMapClient();
        const localMapConfig = { ...config, cacheRoot: path.join(directory, "image-comparison"),
          storageCacheRoot: config.cacheRoot, allowCacheEviction: false, rawPixelCache };
        for (const workout of sample) {
          const thumbnail = await ThumbnailService.generateThumbnailForWorkout(workout.id, {
            skipExistingCheck: true, connectionFactory, localMapClient: mapClient, localMapConfig
          });
          if (!ThumbnailService.hasMapBackground(thumbnail)) throw new Error("Comparison requires a local map background");
          if (!rawPixelCache) references.set(workout.id, thumbnail.content);
          else {
            const comparison = await compareGpsThumbnailPixels(references.get(workout.id), thumbnail.content);
            imageComparisons.push({ workoutId: workout.id, ...comparison });
            if (!comparison.identicalPixels) throw new Error("Raw pixel cache changed thumbnail pixels");
          }
        }
      }
      console.log(JSON.stringify({ imageComparisons }));
    }
    const payload = JSON.stringify({ measuredAt: new Date().toISOString(),
      persistence: "session-local temporary table; real COMMIT but no durable thumbnail writes", sample, reports, imageComparisons }, null, 2);
    await withMapStorageBudget(config, Buffer.byteLength(payload), () => writeFile(path.join(directory, "report.json"), payload),
      { cacheWrite: true, allowCacheEviction: false });
    console.log(`GPS benchmark report: ${path.join(directory, "report.json")}`);
    return { directory, reports, imageComparisons };
  } finally {
    if (mapClient) await closeMapClient(mapClient);
    await pool.end();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runGpsThumbnailBenchmark(process.argv.slice(2)).catch(() => {
    console.error("GPS thumbnail benchmark failed; inspect development prerequisites and local diagnostics. Existing thumbnails were not replaced.");
    process.exitCode = 1;
  });
}