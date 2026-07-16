import { FileDBService } from "./fileDBService.js";

const SEGMENT_TYPES = new Map([
  [1, "auto"],
  [2, "crit"]
]);
const DEFAULT_BATCH_WORKOUT_COUNT = 100;

export class WorkoutLocalPostprocessValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "WorkoutLocalPostprocessValidationError";
    this.statusCode = 400;
  }
}

function requireInteger(value, name, min, max) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < min || numeric > max) {
    throw new WorkoutLocalPostprocessValidationError(`Invalid ${name}`);
  }
  return numeric;
}

export function normalizeWorkoutLocalPostprocessPayload(decoded) {
  const workouts = Array.isArray(decoded?.workouts) ? decoded.workouts : [];
  const declaredWorkoutCount = requireInteger(decoded?.workoutCount, "workout count", 0, 10_000);
  const declaredSegmentCount = requireInteger(decoded?.segmentCount, "segment count", 0, 500_000);
  if (workouts.length !== declaredWorkoutCount) throw new WorkoutLocalPostprocessValidationError("WPP1 workout count mismatch");

  const seenStartTimes = new Set();
  let segmentCount = 0;
  const normalized = workouts.map((workout, workoutIndex) => {
    const startTimeSec = requireInteger(workout?.startTimeSec, `workout ${workoutIndex} start time`, 1, 0xfffffffe);
    const recordCount = requireInteger(workout?.recordCount, `workout ${workoutIndex} record count`, 1, 0xfffffffe);
    if (seenStartTimes.has(startTimeSec)) throw new WorkoutLocalPostprocessValidationError(`Duplicate WPP1 workout start time: ${startTimeSec}`);
    seenStartTimes.add(startTimeSec);

    const segments = (Array.isArray(workout?.segments) ? workout.segments : []).map((segment, segmentIndex) => {
      const typeCode = requireInteger(segment?.type, `workout ${workoutIndex} segment ${segmentIndex} type`, 1, 2);
      const segmenttype = SEGMENT_TYPES.get(typeCode);
      const startOffset = requireInteger(segment?.start, `workout ${workoutIndex} segment ${segmentIndex} start`, 0, 0xfffffffe);
      const endOffset = requireInteger(segment?.end, `workout ${workoutIndex} segment ${segmentIndex} end`, startOffset, 0xfffffffe);
      if (endOffset >= recordCount) {
        throw new WorkoutLocalPostprocessValidationError(`WPP1 segment exceeds workout ${workoutIndex} record range`);
      }
      const duration = requireInteger(segment?.duration, `workout ${workoutIndex} segment ${segmentIndex} duration`, 1, 0xfffffffe);
      const expectedDuration = segmenttype === "auto"
        ? endOffset - startOffset
        : endOffset - startOffset + 1;
      if (duration !== expectedDuration) {
        throw new WorkoutLocalPostprocessValidationError(`Invalid workout ${workoutIndex} segment ${segmentIndex} duration`);
      }
      segmentCount += 1;
      return {
        rowstate: "CRE",
        segmenttype,
        start_offset: startOffset,
        end_offset: endOffset,
        duration,
        avg_power: requireInteger(segment?.avgPower, `workout ${workoutIndex} segment ${segmentIndex} power`, 0, 0xfffe),
        avg_heart_rate: requireInteger(segment?.avgHeartRate, `workout ${workoutIndex} segment ${segmentIndex} heart rate`, 0, 0xfe),
        avg_cadence: requireInteger(segment?.avgCadence, `workout ${workoutIndex} segment ${segmentIndex} cadence`, 0, 0xfe),
        avg_speed: requireInteger(Math.round(Number(segment?.avgSpeed || 0) * 100), `workout ${workoutIndex} segment ${segmentIndex} speed`, 0, 0xfffe) / 100,
        altimeters: requireInteger(segment?.altimeters, `workout ${workoutIndex} segment ${segmentIndex} altimeters`, -0x80000000, 0x7fffffff),
        segmentname: ""
      };
    });

    return {
      startTimeSec,
      startTime: new Date(startTimeSec * 1000),
      recordCount,
      segments
    };
  });

  if (segmentCount !== declaredSegmentCount) throw new WorkoutLocalPostprocessValidationError("WPP1 segment count mismatch");
  return { workouts: normalized, segmentCount };
}

export async function persistWorkoutLocalPostprocess({
  uid,
  decoded,
  pool,
  batchWorkoutCount = DEFAULT_BATCH_WORKOUT_COUNT
}) {
  if (!uid || !pool?.connect) throw new Error("Workout-local postprocessing persistence is not configured");
  const normalized = normalizeWorkoutLocalPostprocessPayload(decoded);
  if (normalized.workouts.length === 0) {
    return { workoutCount: 0, segmentCount: 0, deletedSegmentCount: 0, insertedSegmentCount: 0, batchCount: 0 };
  }

  const client = await pool.connect();
  const profile = {
    resolveWorkoutsMs: 0,
    deleteSegmentsMs: 0,
    insertSegmentsMs: 0,
    updateStatusMs: 0,
    transactionMs: 0
  };
  const transactionStartedAt = performance.now();
  try {
    await client.query("BEGIN");
    let stepStartedAt = performance.now();
    const workoutResult = await client.query(`
      SELECT id, start_time
      FROM workouts
      WHERE uid = $1
        AND start_time = ANY($2::timestamptz[])
      FOR UPDATE
    `, [uid, normalized.workouts.map((workout) => workout.startTime)]);
    profile.resolveWorkoutsMs = performance.now() - stepStartedAt;

    const rowsByStartTimeSec = new Map(workoutResult.rows.map((row) => [
      Math.round(new Date(row.start_time).getTime() / 1000),
      row
    ]));
    const missingStartTimes = normalized.workouts
      .filter((workout) => !rowsByStartTimeSec.has(workout.startTimeSec))
      .map((workout) => workout.startTime.toISOString());
    if (missingStartTimes.length > 0) {
      throw new WorkoutLocalPostprocessValidationError(`WPP1 references ${missingStartTimes.length} unknown workouts`);
    }

    const workoutSegments = normalized.workouts.map((workout) => {
      const row = rowsByStartTimeSec.get(workout.startTimeSec);
      return { workoutId: Number(row.id), segments: workout.segments };
    });
    const workoutIds = workoutSegments.map((item) => item.workoutId);

    stepStartedAt = performance.now();
    const deleteResult = await client.query(`
      DELETE FROM workout_segments
      WHERE uid = $1
        AND wid = ANY($2::bigint[])
        AND segmenttype = ANY($3::text[])
    `, [uid, workoutIds, ["auto", "crit"]]);
    profile.deleteSegmentsMs = performance.now() - stepStartedAt;

    const normalizedBatchWorkoutCount = Math.max(1, Math.min(1_000, Number(batchWorkoutCount) || DEFAULT_BATCH_WORKOUT_COUNT));
    let insertedSegmentCount = 0;
    let batchCount = 0;
    stepStartedAt = performance.now();
    for (let index = 0; index < workoutSegments.length; index += normalizedBatchWorkoutCount) {
      const result = await FileDBService.insertSegmentsForWorkoutsBulk(
        uid,
        workoutSegments.slice(index, index + normalizedBatchWorkoutCount),
        client
      );
      insertedSegmentCount += Number(result.insertedCount || 0);
      batchCount += Number(result.statementCount || 0);
    }
    profile.insertSegmentsMs = performance.now() - stepStartedAt;

    stepStartedAt = performance.now();
    await client.query(`
      UPDATE workouts
      SET
        segment_processing_status = 'completed',
        segment_processing_error = NULL,
        segment_processing_updated_at = NOW()
      WHERE uid = $1
        AND id = ANY($2::bigint[])
    `, [uid, workoutIds]);
    profile.updateStatusMs = performance.now() - stepStartedAt;

    await client.query("COMMIT");
    profile.transactionMs = performance.now() - transactionStartedAt;
    return {
      workoutCount: workoutSegments.length,
      segmentCount: normalized.segmentCount,
      deletedSegmentCount: Number(deleteResult.rowCount || 0),
      insertedSegmentCount,
      batchCount,
      configuredBatchWorkoutCount: normalizedBatchWorkoutCount,
      profile
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
