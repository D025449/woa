import "../config/env.js";

import { pathToFileURL } from "node:url";

import {
  GPS_SEGMENT_ELEVATION_PROFILE_REBUILD_KEY,
  addGpsSegmentElevationProfileBatch,
  assertGpsSegmentElevationProfileWriteTarget,
  assertGpsSegmentRebuildDatabaseUnchanged,
  configureGpsSegmentRebuildDatabase,
  createGpsSegmentElevationProfileSummary,
  getGpsSegmentElevationProfileRebuildUsage,
  parseGpsSegmentElevationProfileRebuildArgs
} from "./gps-segment-elevation-profile-rebuild-helpers.js";

const RUN_TABLE = "gps_segment_elevation_profile_rebuild_runs";

async function acquireRunLock(client) {
  const result = await client.query(`
    SELECT pg_try_advisory_lock(hashtextextended($1::text, 0)) AS acquired
  `, [GPS_SEGMENT_ELEVATION_PROFILE_REBUILD_KEY]);
  if (result.rows[0]?.acquired !== true) {
    throw new Error("Another GPS segment elevation-profile rebuild is already running");
  }
}

async function releaseRunLock(client) {
  await client.query(`
    SELECT pg_advisory_unlock(hashtextextended($1::text, 0))
  `, [GPS_SEGMENT_ELEVATION_PROFILE_REBUILD_KEY]);
}

async function initializeApplyRun(client, options, currentDatabase) {
  await client.query("BEGIN");
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${RUN_TABLE} (
        migration_key TEXT PRIMARY KEY,
        target_database TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'paused', 'failed', 'completed')),
        last_segment_id BIGINT NOT NULL DEFAULT 0,
        processed_segments BIGINT NOT NULL DEFAULT 0,
        confirmed_segments BIGINT NOT NULL DEFAULT 0,
        candidate_segments BIGINT NOT NULL DEFAULT 0,
        unavailable_segments BIGINT NOT NULL DEFAULT 0,
        retained_segments BIGINT NOT NULL DEFAULT 0,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        last_error TEXT
      )
    `);

    const existingResult = await client.query(`
      SELECT *
      FROM ${RUN_TABLE}
      WHERE migration_key = $1
      FOR UPDATE
    `, [GPS_SEGMENT_ELEVATION_PROFILE_REBUILD_KEY]);
    const existing = existingResult.rows[0] || null;

    if (existing && existing.target_database !== currentDatabase && !options.rerunCompleted) {
      throw new Error(
        `Migration state belongs to database "${existing.target_database}", not "${currentDatabase}"; `
        + "use --rerun-completed only for a deliberate restart on this restored database"
      );
    }
    if (existing?.status === "completed" && !options.rerunCompleted) {
      throw new Error(
        `Migration ${GPS_SEGMENT_ELEVATION_PROFILE_REBUILD_KEY} is already completed; `
        + "use --rerun-completed only for a deliberate full repeat"
      );
    }

    if (!existing) {
      await client.query(`
        INSERT INTO ${RUN_TABLE} (migration_key, target_database, status)
        VALUES ($1, $2, 'running')
      `, [GPS_SEGMENT_ELEVATION_PROFILE_REBUILD_KEY, currentDatabase]);
    } else if (options.rerunCompleted) {
      await client.query(`
        UPDATE ${RUN_TABLE}
        SET
          target_database = $2,
          status = 'running',
          last_segment_id = 0,
          processed_segments = 0,
          confirmed_segments = 0,
          candidate_segments = 0,
          unavailable_segments = 0,
          retained_segments = 0,
          started_at = NOW(),
          updated_at = NOW(),
          completed_at = NULL,
          last_error = NULL
        WHERE migration_key = $1
      `, [GPS_SEGMENT_ELEVATION_PROFILE_REBUILD_KEY, currentDatabase]);
    } else {
      await client.query(`
        UPDATE ${RUN_TABLE}
        SET status = 'running', updated_at = NOW(), last_error = NULL
        WHERE migration_key = $1
      `, [GPS_SEGMENT_ELEVATION_PROFILE_REBUILD_KEY]);
    }

    const runResult = await client.query(`
      SELECT * FROM ${RUN_TABLE} WHERE migration_key = $1
    `, [GPS_SEGMENT_ELEVATION_PROFILE_REBUILD_KEY]);
    await client.query("COMMIT");
    return runResult.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function loadEligibleSegmentBatch(
  client,
  lastSegmentId,
  batchSize,
  algorithmVersion,
  includeCurrentProfiles
) {
  const result = await client.query(`
    SELECT segment.id
    FROM gps_segments segment
    WHERE segment.id > $1
      AND EXISTS (
        SELECT 1
        FROM gps_segment_best_efforts effort
        WHERE effort.sid = segment.id
      )
      AND (
        $4::boolean
        OR segment.workout_altitude_status <> 'confirmed'
        OR segment.workout_altitude_algorithm_version IS DISTINCT FROM $2
      )
    ORDER BY segment.id
    LIMIT $3
  `, [lastSegmentId, algorithmVersion, batchSize, includeCurrentProfiles]);
  return result.rows.map((row) => Number(row.id)).filter(Number.isInteger);
}

async function loadInventory(client, algorithmVersion) {
  const result = await client.query(`
    SELECT
      COUNT(*)::bigint AS total_segments,
      COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM gps_segment_best_efforts effort WHERE effort.sid = segment.id
      ))::bigint AS segments_with_efforts,
      COUNT(*) FILTER (WHERE
        EXISTS (SELECT 1 FROM gps_segment_best_efforts effort WHERE effort.sid = segment.id)
        AND (
          segment.workout_altitude_status <> 'confirmed'
          OR segment.workout_altitude_algorithm_version IS DISTINCT FROM $1
        )
      )::bigint AS eligible_segments
    FROM gps_segments segment
  `, [algorithmVersion]);
  const row = result.rows[0] || {};
  return {
    totalSegments: Number(row.total_segments) || 0,
    segmentsWithEfforts: Number(row.segments_with_efforts) || 0,
    eligibleSegments: Number(row.eligible_segments) || 0
  };
}

async function persistCheckpoint(client, lastSegmentId, batchSummary) {
  const result = await client.query(`
    UPDATE ${RUN_TABLE}
    SET
      status = 'running',
      last_segment_id = $2,
      processed_segments = processed_segments + $3,
      confirmed_segments = confirmed_segments + $4,
      candidate_segments = candidate_segments + $5,
      unavailable_segments = unavailable_segments + $6,
      retained_segments = retained_segments + $7,
      updated_at = NOW(),
      last_error = NULL
    WHERE migration_key = $1
  `, [
    GPS_SEGMENT_ELEVATION_PROFILE_REBUILD_KEY,
    lastSegmentId,
    batchSummary.processedSegments,
    batchSummary.confirmedSegments,
    batchSummary.candidateSegments,
    batchSummary.unavailableSegments,
    batchSummary.retainedSegments
  ]);
  if (result.rowCount !== 1) {
    throw new Error("GPS segment elevation-profile rebuild checkpoint row is missing");
  }
}

async function finishApplyRun(client, status) {
  const result = await client.query(`
    UPDATE ${RUN_TABLE}
    SET
      status = $2,
      updated_at = NOW(),
      completed_at = CASE WHEN $2 = 'completed' THEN NOW() ELSE NULL END
    WHERE migration_key = $1
  `, [GPS_SEGMENT_ELEVATION_PROFILE_REBUILD_KEY, status]);
  if (result.rowCount !== 1) {
    throw new Error("GPS segment elevation-profile rebuild run row is missing");
  }
}

async function recordApplyFailure(client, error) {
  await client.query(`
    UPDATE ${RUN_TABLE}
    SET status = 'failed', updated_at = NOW(), last_error = $2
    WHERE migration_key = $1
  `, [GPS_SEGMENT_ELEVATION_PROFILE_REBUILD_KEY, String(error?.message || error).slice(0, 2000)]);
}

export async function runGpsSegmentElevationProfileRebuild(args = process.argv.slice(2)) {
  const options = parseGpsSegmentElevationProfileRebuildArgs(args);
  if (options.help) {
    console.log(getGpsSegmentElevationProfileRebuildUsage());
    return;
  }

  const runtimeDatabase = configureGpsSegmentRebuildDatabase();
  assertGpsSegmentElevationProfileWriteTarget(options, runtimeDatabase.databaseName);
  const { default: pool } = await import("../services/database.js");
  const {
    default: SegmentElevationProfileService,
    WORKOUT_ALTITUDE_ALGORITHM_VERSION
  } = await import("../services/segmentElevationProfileService.js");

  let client;
  try {
    client = await pool.connect();
  } catch (error) {
    await pool.end();
    throw error;
  }

  let lockAcquired = false;
  let applyRunInitialized = false;
  let summary = createGpsSegmentElevationProfileSummary();
  const startedAt = performance.now();

  try {
    const databaseResult = await client.query("SELECT current_database() AS name");
    const currentDatabase = String(databaseResult.rows[0]?.name || "");
    if (currentDatabase !== runtimeDatabase.databaseName) {
      throw new Error(`Connected to ${currentDatabase}, expected active database ${runtimeDatabase.databaseName}`);
    }
    assertGpsSegmentElevationProfileWriteTarget(options, currentDatabase);
    await acquireRunLock(client);
    lockAcquired = true;

    let lastSegmentId = 0;
    if (options.apply) {
      const run = await initializeApplyRun(client, options, currentDatabase);
      applyRunInitialized = true;
      lastSegmentId = Number(run.last_segment_id) || 0;
    }

    const inventory = await loadInventory(client, WORKOUT_ALTITUDE_ALGORITHM_VERSION);
    console.log("[gps-segment-elevation-profiles] start", {
      migration: GPS_SEGMENT_ELEVATION_PROFILE_REBUILD_KEY,
      mode: options.apply ? "APPLY" : "DRY-RUN",
      database: currentDatabase,
      pointerFile: runtimeDatabase.pointerFile,
      algorithmVersion: WORKOUT_ALTITUDE_ALGORITHM_VERSION,
      candidateLimit: SegmentElevationProfileService.candidateLimit,
      batchSize: options.batchSize,
      limit: options.limit ?? "none",
      resumeAfterSegmentId: lastSegmentId,
      ...inventory
    });

    let remaining = options.limit;
    let reachedEnd = false;
    while (remaining === null || remaining > 0) {
      assertGpsSegmentRebuildDatabaseUnchanged(process.env, currentDatabase);
      const scanBatchSize = remaining === null
        ? options.batchSize
        : Math.min(options.batchSize, remaining);
      const segmentIds = await loadEligibleSegmentBatch(
        client,
        lastSegmentId,
        scanBatchSize,
        WORKOUT_ALTITUDE_ALGORITHM_VERSION,
        options.rerunCompleted
      );
      if (segmentIds.length === 0) {
        reachedEnd = true;
        break;
      }

      const batchStartedAt = performance.now();
      const results = await SegmentElevationProfileService.rebuildSegments(segmentIds, {
        persist: options.apply
      });
      const batchSummary = addGpsSegmentElevationProfileBatch(
        createGpsSegmentElevationProfileSummary(),
        results
      );
      summary = addGpsSegmentElevationProfileBatch(summary, results);
      lastSegmentId = segmentIds.at(-1);

      if (options.apply) {
        assertGpsSegmentRebuildDatabaseUnchanged(process.env, currentDatabase);
        await persistCheckpoint(client, lastSegmentId, batchSummary);
      }

      console.log("[gps-segment-elevation-profiles] batch", {
        lastSegmentId,
        requestedSegments: segmentIds.length,
        processedSegments: batchSummary.processedSegments,
        confirmedSegments: batchSummary.confirmedSegments,
        candidateSegments: batchSummary.candidateSegments,
        unavailableSegments: batchSummary.unavailableSegments,
        retainedSegments: batchSummary.retainedSegments,
        elapsedMs: Math.round(performance.now() - batchStartedAt)
      });

      if (remaining !== null) remaining -= segmentIds.length;
    }

    if (options.apply) {
      await finishApplyRun(client, reachedEnd ? "completed" : "paused");
    }

    console.log("[gps-segment-elevation-profiles] summary", {
      mode: options.apply ? "APPLY" : "DRY-RUN",
      complete: reachedEnd,
      lastSegmentId,
      ...summary,
      elapsedMs: Math.round(performance.now() - startedAt)
    });
  } catch (error) {
    if (options.apply && applyRunInitialized) {
      try {
        await recordApplyFailure(client, error);
      } catch (recordError) {
        console.error("[gps-segment-elevation-profiles] could not record failure", {
          message: recordError?.message,
          code: recordError?.code
        });
      }
    }
    throw error;
  } finally {
    try {
      if (lockAcquired) await releaseRunLock(client);
    } catch (unlockError) {
      console.error("[gps-segment-elevation-profiles] could not release advisory lock", {
        message: unlockError?.message,
        code: unlockError?.code
      });
    } finally {
      client.release();
      await pool.end();
    }
  }
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  runGpsSegmentElevationProfileRebuild().catch((error) => {
    console.error("[gps-segment-elevation-profiles] failed", {
      message: error?.message,
      code: error?.code
    });
    process.exitCode = 1;
  });
}
