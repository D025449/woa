import "../config/env.js";

import { pathToFileURL } from "node:url";

import {
  GPS_SEGMENT_BEST_EFFORTS_REBUILD_KEY,
  configureGpsSegmentRebuildDatabase,
  assertGpsSegmentRebuildDatabaseUnchanged,
  addGpsSegmentBestEffortsBatchSummary,
  assertGpsSegmentBestEffortsWriteTarget,
  createGpsSegmentBestEffortsRebuildSummary,
  getGpsSegmentBestEffortsRebuildUsage,
  groupEligibleWorkoutsByOwner,
  parseGpsSegmentBestEffortsRebuildArgs
} from "./gps-segment-best-efforts-rebuild-helpers.js";

const RUN_TABLE = "gps_segment_best_effort_rebuild_runs";

async function acquireRunLock(client) {
  const result = await client.query(`
    SELECT pg_try_advisory_lock(
      hashtextextended($1::text, 0)
    ) AS acquired
  `, [GPS_SEGMENT_BEST_EFFORTS_REBUILD_KEY]);
  if (result.rows[0]?.acquired !== true) {
    throw new Error("Another GPS segment best-effort rebuild is already running");
  }
}

async function releaseRunLock(client) {
  await client.query(`
    SELECT pg_advisory_unlock(
      hashtextextended($1::text, 0)
    )
  `, [GPS_SEGMENT_BEST_EFFORTS_REBUILD_KEY]);
}

async function initializeApplyRun(client, options, currentDatabase) {
  await client.query("BEGIN");
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${RUN_TABLE} (
        migration_key TEXT PRIMARY KEY,
        target_database TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'paused', 'failed', 'completed')),
        last_uid BIGINT NOT NULL DEFAULT 0,
        last_workout_id BIGINT NOT NULL DEFAULT 0,
        processed_workouts BIGINT NOT NULL DEFAULT 0,
        old_rows BIGINT NOT NULL DEFAULT 0,
        new_rows BIGINT NOT NULL DEFAULT 0,
        added_match_keys BIGINT NOT NULL DEFAULT 0,
        removed_match_keys BIGINT NOT NULL DEFAULT 0,
        changed_rows BIGINT NOT NULL DEFAULT 0,
        elapsed_ms BIGINT NOT NULL DEFAULT 0,
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
    `, [GPS_SEGMENT_BEST_EFFORTS_REBUILD_KEY]);
    const existing = existingResult.rows[0] || null;

    if (existing && existing.target_database !== currentDatabase && !options.rerunCompleted) {
      throw new Error(
        `Migration state belongs to database "${existing.target_database}", not "${currentDatabase}"; `
        + "use --rerun-completed only for a deliberate restart on this restored database"
      );
    }

    if (existing?.status === "completed" && !options.rerunCompleted) {
      throw new Error(
        `Migration ${GPS_SEGMENT_BEST_EFFORTS_REBUILD_KEY} is already completed; `
        + "use --rerun-completed only for a deliberate full repeat"
      );
    }

    if (!existing) {
      await client.query(`
        INSERT INTO ${RUN_TABLE} (
          migration_key,
          target_database,
          status
        )
        VALUES ($1, $2, 'running')
      `, [GPS_SEGMENT_BEST_EFFORTS_REBUILD_KEY, currentDatabase]);
    } else if (options.rerunCompleted) {
      await client.query(`
        UPDATE ${RUN_TABLE}
        SET
          target_database = $2,
          status = 'running',
          last_uid = 0,
          last_workout_id = 0,
          processed_workouts = 0,
          old_rows = 0,
          new_rows = 0,
          added_match_keys = 0,
          removed_match_keys = 0,
          changed_rows = 0,
          elapsed_ms = 0,
          started_at = NOW(),
          updated_at = NOW(),
          completed_at = NULL,
          last_error = NULL
        WHERE migration_key = $1
      `, [GPS_SEGMENT_BEST_EFFORTS_REBUILD_KEY, currentDatabase]);
    } else {
      await client.query(`
        UPDATE ${RUN_TABLE}
        SET
          status = 'running',
          updated_at = NOW(),
          last_error = NULL
        WHERE migration_key = $1
      `, [GPS_SEGMENT_BEST_EFFORTS_REBUILD_KEY]);
    }

    const runResult = await client.query(`
      SELECT *
      FROM ${RUN_TABLE}
      WHERE migration_key = $1
    `, [GPS_SEGMENT_BEST_EFFORTS_REBUILD_KEY]);
    await client.query("COMMIT");
    return runResult.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function loadEligibleWorkoutBatch(client, lastUid, lastWorkoutId, batchSize) {
  const result = await client.query(`
    SELECT id, uid
    FROM workouts
    WHERE (uid > $1 OR (uid = $1 AND id > $2))
      AND validgps = true
      AND workout_type <> 'motorsport'
      AND gps_track_blob IS NOT NULL
      AND gps_bounds IS NOT NULL
    ORDER BY uid ASC, id ASC
    LIMIT $3
  `, [lastUid, lastWorkoutId, batchSize]);
  const firstUid = Number(result.rows[0]?.uid);
  return result.rows.filter((row) => Number(row.uid) === firstUid);
}

async function persistCheckpoint(client, lastUid, lastWorkoutId, summary) {
  const result = await client.query(`
    UPDATE ${RUN_TABLE}
    SET
      status = 'running',
      last_uid = $2,
      last_workout_id = $3,
      processed_workouts = processed_workouts + $4,
      old_rows = old_rows + $5,
      new_rows = new_rows + $6,
      added_match_keys = added_match_keys + $7,
      removed_match_keys = removed_match_keys + $8,
      changed_rows = changed_rows + $9,
      elapsed_ms = elapsed_ms + $10,
      updated_at = NOW(),
      last_error = NULL
    WHERE migration_key = $1
  `, [
    GPS_SEGMENT_BEST_EFFORTS_REBUILD_KEY,
    lastUid,
    lastWorkoutId,
    summary.processedWorkouts,
    summary.oldRows,
    summary.newRows,
    summary.addedMatchKeys,
    summary.removedMatchKeys,
    summary.changedRows,
    Math.round(summary.elapsedMs)
  ]);
  if (result.rowCount !== 1) {
    throw new Error("GPS segment best-effort rebuild checkpoint row is missing");
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
  `, [GPS_SEGMENT_BEST_EFFORTS_REBUILD_KEY, status]);
  if (result.rowCount !== 1) {
    throw new Error("GPS segment best-effort rebuild run row is missing");
  }
}

async function recordApplyFailure(client, error) {
  await client.query(`
    UPDATE ${RUN_TABLE}
    SET
      status = 'failed',
      updated_at = NOW(),
      last_error = $2
    WHERE migration_key = $1
  `, [GPS_SEGMENT_BEST_EFFORTS_REBUILD_KEY, String(error?.message || error).slice(0, 2000)]);
}

export async function runGpsSegmentBestEffortsRebuild(args = process.argv.slice(2)) {
  const options = parseGpsSegmentBestEffortsRebuildArgs(args);
  if (options.help) {
    console.log(getGpsSegmentBestEffortsRebuildUsage());
    return;
  }

  // Resolve before importing services: database.js captures DB_NAME when its pool is constructed.
  const runtimeDatabase = configureGpsSegmentRebuildDatabase();
  assertGpsSegmentBestEffortsWriteTarget(options, runtimeDatabase.databaseName);
  const { default: pool } = await import("../services/database.js");
  const { default: SegmentDBService } = await import("../services/segmentDBService.js");
  let client;
  try {
    client = await pool.connect();
  } catch (error) {
    await pool.end();
    throw error;
  }
  let lockAcquired = false;
  let applyRunInitialized = false;
  const totalStartedAt = performance.now();
  let totalSummary = createGpsSegmentBestEffortsRebuildSummary();

  try {
    const databaseResult = await client.query("SELECT current_database() AS name");
    const currentDatabase = String(databaseResult.rows[0]?.name || "");
    if (currentDatabase !== runtimeDatabase.databaseName) {
      throw new Error(`Connected to ${currentDatabase}, expected active database ${runtimeDatabase.databaseName}`);
    }
    assertGpsSegmentBestEffortsWriteTarget(options, currentDatabase);
    await acquireRunLock(client);
    lockAcquired = true;

    let lastUid = 0;
    let lastWorkoutId = 0;
    if (options.apply) {
      const run = await initializeApplyRun(client, options, currentDatabase);
      applyRunInitialized = true;
      lastUid = Number(run.last_uid) || 0;
      lastWorkoutId = Number(run.last_workout_id) || 0;
    }

    console.log("[gps-segment-best-efforts] start", {
      migration: GPS_SEGMENT_BEST_EFFORTS_REBUILD_KEY,
      mode: options.apply ? "APPLY" : options.verify ? "VERIFY" : "DRY-RUN",
      database: currentDatabase,
      pointerFile: runtimeDatabase.pointerFile,
      batchSize: options.batchSize,
      limit: options.limit ?? "none",
      resumeAfter: { uid: lastUid, workoutId: lastWorkoutId }
    });

    let remaining = options.limit;
    let reachedEnd = false;
    while (remaining === null || remaining > 0) {
      assertGpsSegmentRebuildDatabaseUnchanged(process.env, currentDatabase);
      const scanBatchSize = remaining === null
        ? options.batchSize
        : Math.min(options.batchSize, remaining);
      const rows = await loadEligibleWorkoutBatch(client, lastUid, lastWorkoutId, scanBatchSize);
      if (rows.length === 0) {
        reachedEnd = true;
        break;
      }

      const batchStartedAt = performance.now();
      const [ownerGroup] = groupEligibleWorkoutsByOwner(rows);
      if (!ownerGroup || ownerGroup.workoutIds.length !== rows.length) {
        throw new Error("Eligible workout batch could not be grouped under one valid owner");
      }
      const { uid, workoutIds } = ownerGroup;
      const nextWorkoutId = workoutIds.at(-1);
      const result = await SegmentDBService.rebuildSegmentBestEffortsForWorkoutsBatch(
        uid,
        workoutIds,
        {
          apply: options.apply,
          client,
          beforeCommit: options.apply
            ? async (replacementSummary, transactionClient) => {
                assertGpsSegmentRebuildDatabaseUnchanged(process.env, currentDatabase);
                await persistCheckpoint(transactionClient, uid, nextWorkoutId, {
                  processedWorkouts: replacementSummary.workoutCount,
                  oldRows: replacementSummary.oldRowCount,
                  newRows: replacementSummary.newRowCount,
                  addedMatchKeys: replacementSummary.addedMatchKeyCount,
                  removedMatchKeys: replacementSummary.removedMatchKeyCount,
                  changedRows: replacementSummary.changedRowCount,
                  elapsedMs: performance.now() - batchStartedAt
                });
              }
            : null
        }
      );
      const batchSummary = addGpsSegmentBestEffortsBatchSummary(
        createGpsSegmentBestEffortsRebuildSummary(),
        {
          ...result,
          elapsedMs: performance.now() - batchStartedAt
        }
      );
      totalSummary = addGpsSegmentBestEffortsBatchSummary(totalSummary, {
        workoutCount: batchSummary.processedWorkouts,
        oldRowCount: batchSummary.oldRows,
        newRowCount: batchSummary.newRows,
        addedMatchKeyCount: batchSummary.addedMatchKeys,
        removedMatchKeyCount: batchSummary.removedMatchKeys,
        changedRowCount: batchSummary.changedRows,
        elapsedMs: batchSummary.elapsedMs
      });

      lastUid = uid;
      lastWorkoutId = nextWorkoutId;

      console.log("[gps-segment-best-efforts] batch", {
        uid,
        lastWorkoutId,
        processedWorkouts: batchSummary.processedWorkouts,
        oldRows: batchSummary.oldRows,
        newRows: batchSummary.newRows,
        addedMatchKeys: batchSummary.addedMatchKeys,
        removedMatchKeys: batchSummary.removedMatchKeys,
        changedRows: batchSummary.changedRows,
        elapsedMs: Math.round(batchSummary.elapsedMs)
      });

      if (remaining !== null) remaining -= rows.length;
    }

    if (options.apply) {
      await finishApplyRun(client, reachedEnd ? "completed" : "paused");
    }

    console.log("[gps-segment-best-efforts] summary", {
      mode: options.apply ? "APPLY" : options.verify ? "VERIFY" : "DRY-RUN",
      complete: reachedEnd,
      lastUid,
      lastWorkoutId,
      processedWorkouts: totalSummary.processedWorkouts,
      oldRows: totalSummary.oldRows,
      newRows: totalSummary.newRows,
      addedMatchKeys: totalSummary.addedMatchKeys,
      removedMatchKeys: totalSummary.removedMatchKeys,
      changedRows: totalSummary.changedRows,
      elapsedMs: Math.round(performance.now() - totalStartedAt)
    });
    if (options.verify && (totalSummary.addedMatchKeys || totalSummary.removedMatchKeys || totalSummary.changedRows)) {
      throw new Error("Verification failed: stored best efforts differ from the E5 recomputation (see summary)");
    }
    if (options.verify) console.log("[gps-segment-best-efforts] verification passed: all eligible stored results match");
  } catch (error) {
    if (options.apply && applyRunInitialized) {
      try {
        await recordApplyFailure(client, error);
      } catch (recordError) {
        console.error("[gps-segment-best-efforts] could not record failure", {
          message: recordError?.message,
          code: recordError?.code
        });
      }
    }
    throw error;
  } finally {
    try {
      if (lockAcquired) {
        await releaseRunLock(client);
      }
    } catch (unlockError) {
      console.error("[gps-segment-best-efforts] could not release advisory lock", {
        message: unlockError?.message,
        code: unlockError?.code
      });
    } finally {
      client.release();
      await pool.end();
    }
  }
}

const isMain = process.argv[1]
  && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  runGpsSegmentBestEffortsRebuild().catch((error) => {
    console.error("[gps-segment-best-efforts] failed", {
      message: error?.message,
      code: error?.code
    });
    process.exitCode = 1;
  });
}
