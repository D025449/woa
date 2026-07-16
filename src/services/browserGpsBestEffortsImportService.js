const MAX_WORKOUTS = 10_000;
const MAX_MATCHES = 500_000;

export class BrowserGpsBestEffortsValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "BrowserGpsBestEffortsValidationError";
    this.statusCode = 400;
  }
}

function requireInteger(value, name, min, max) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < min || numeric > max) {
    throw new BrowserGpsBestEffortsValidationError(`Invalid ${name}`);
  }
  return numeric;
}

export function normalizeBrowserGpsBestEffortsPayload(decoded) {
  const workouts = Array.isArray(decoded?.workouts) ? decoded.workouts : [];
  const workoutCount = requireInteger(decoded?.workoutCount, "workout count", 0, MAX_WORKOUTS);
  const declaredMatchCount = requireInteger(decoded?.matchCount, "match count", 0, MAX_MATCHES);
  if (workouts.length !== workoutCount) throw new BrowserGpsBestEffortsValidationError("GBE1 workout count mismatch");

  const seenStartTimes = new Set();
  let matchCount = 0;
  const normalizedWorkouts = workouts.map((workout, workoutIndex) => {
    const startTimeSec = requireInteger(workout?.startTimeSec, `workout ${workoutIndex} start time`, 1, 0xfffffffe);
    if (seenStartTimes.has(startTimeSec)) throw new BrowserGpsBestEffortsValidationError(`Duplicate GBE1 workout start time: ${startTimeSec}`);
    seenStartTimes.add(startTimeSec);
    const matches = (Array.isArray(workout?.matches) ? workout.matches : []).map((match, matchIndex) => {
      const startOffset = requireInteger(match?.startOffset, `workout ${workoutIndex} match ${matchIndex} start`, 0, 0xfffffffe);
      const endOffset = requireInteger(match?.endOffset, `workout ${workoutIndex} match ${matchIndex} end`, startOffset + 1, 0xfffffffe);
      matchCount += 1;
      return {
        segmentId: requireInteger(match?.segmentId, `workout ${workoutIndex} match ${matchIndex} segment`, 1, 0xfffffffe),
        startOffset,
        endOffset,
        avgPower: requireInteger(match?.avgPower, `workout ${workoutIndex} match ${matchIndex} power`, 0, 0xfffe),
        avgHeartRate: requireInteger(match?.avgHeartRate, `workout ${workoutIndex} match ${matchIndex} heart rate`, 0, 0xfe),
        avgCadence: requireInteger(match?.avgCadence, `workout ${workoutIndex} match ${matchIndex} cadence`, 0, 0xfe),
        avgSpeed: requireInteger(Math.round(Number(match?.avgSpeed || 0) * 10), `workout ${workoutIndex} match ${matchIndex} speed`, 0, 0xfffe) / 10
      };
    });
    return { startTimeSec, startTime: new Date(startTimeSec * 1000), matches };
  });
  if (matchCount !== declaredMatchCount) throw new BrowserGpsBestEffortsValidationError("GBE1 match count mismatch");
  return { workouts: normalizedWorkouts, matchCount };
}

export async function persistBrowserGpsBestEfforts({ uid, decoded, pool }) {
  if (!uid || !pool?.connect) throw new Error("Browser GPS best-efforts persistence is not configured");
  const normalized = normalizeBrowserGpsBestEffortsPayload(decoded);
  if (normalized.workouts.length === 0) {
    return { workoutCount: 0, matchCount: 0, deletedMatchCount: 0, insertedMatchCount: 0, statementCount: 0 };
  }

  const profile = { resolveWorkoutsMs: 0, validateSegmentsMs: 0, deleteMatchesMs: 0, insertMatchesMs: 0, transactionMs: 0 };
  const client = await pool.connect();
  const transactionStartedAt = performance.now();
  try {
    await client.query("BEGIN");
    let stepStartedAt = performance.now();
    const workoutResult = await client.query(`
      SELECT id, start_time
      FROM workouts
      WHERE uid = $1
        AND start_time = ANY($2::timestamptz[])
    `, [uid, normalized.workouts.map((workout) => workout.startTime)]);
    profile.resolveWorkoutsMs = performance.now() - stepStartedAt;
    const rowsByStartTimeSec = new Map(workoutResult.rows.map((row) => [
      Math.round(new Date(row.start_time).getTime() / 1000), Number(row.id)
    ]));
    const missing = normalized.workouts.filter((workout) => !rowsByStartTimeSec.has(workout.startTimeSec));
    if (missing.length) throw new BrowserGpsBestEffortsValidationError(`GBE1 references ${missing.length} unknown workouts`);

    const segmentIds = [...new Set(normalized.workouts.flatMap((workout) => workout.matches.map((match) => match.segmentId)))];
    stepStartedAt = performance.now();
    if (segmentIds.length) {
      const segmentResult = await client.query(`
        SELECT id
        FROM gps_segments
        WHERE uid = $1
          AND id = ANY($2::bigint[])
      `, [uid, segmentIds]);
      if (segmentResult.rows.length !== segmentIds.length) {
        throw new BrowserGpsBestEffortsValidationError("GBE1 references unknown GPS segments");
      }
    }
    profile.validateSegmentsMs = performance.now() - stepStartedAt;

    const workoutIds = normalized.workouts.map((workout) => rowsByStartTimeSec.get(workout.startTimeSec));
    stepStartedAt = performance.now();
    const deleteResult = await client.query(`
      DELETE FROM gps_segment_best_efforts AS effort
      USING gps_segments AS segment
      WHERE effort.sid = segment.id
        AND segment.uid = $1
        AND effort.wid = ANY($2::bigint[])
    `, [uid, workoutIds]);
    profile.deleteMatchesMs = performance.now() - stepStartedAt;

    const rows = normalized.workouts.flatMap((workout) => {
      const workoutId = rowsByStartTimeSec.get(workout.startTimeSec);
      return workout.matches.map((match) => ({ workoutId, ...match }));
    });
    let insertedMatchCount = 0;
    if (rows.length) {
      stepStartedAt = performance.now();
      const insertResult = await client.query(`
        INSERT INTO gps_segment_best_efforts (
          sid, wid, start_offset, end_offset, duration,
          avg_power, avg_heart_rate, avg_cadence, avg_speed
        )
        SELECT *
        FROM UNNEST(
          $1::bigint[], $2::bigint[], $3::int[], $4::int[], $5::int[],
          $6::float8[], $7::float8[], $8::float8[], $9::float8[]
        )
      `, [
        rows.map((row) => row.segmentId),
        rows.map((row) => row.workoutId),
        rows.map((row) => row.startOffset),
        rows.map((row) => row.endOffset),
        rows.map((row) => row.endOffset - row.startOffset),
        rows.map((row) => row.avgPower),
        rows.map((row) => row.avgHeartRate),
        rows.map((row) => row.avgCadence),
        rows.map((row) => row.avgSpeed)
      ]);
      insertedMatchCount = Number(insertResult.rowCount || rows.length);
      profile.insertMatchesMs = performance.now() - stepStartedAt;
    }

    await client.query("COMMIT");
    profile.transactionMs = performance.now() - transactionStartedAt;
    return {
      workoutCount: normalized.workouts.length,
      matchCount: normalized.matchCount,
      deletedMatchCount: Number(deleteResult.rowCount || 0),
      insertedMatchCount,
      statementCount: rows.length ? 4 : 3,
      profile
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
