import { performance } from "perf_hooks";

function parseArgs() {
  const args = process.argv.slice(2);
  const options = { segmentIds: [], repeats: 3, limit: 100, metrics: false };

  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--segments" && args[index + 1]) {
      options.segmentIds = args[index + 1]
        .split(",")
        .map(Number)
        .filter((id) => Number.isInteger(id) && id > 0);
      index += 1;
    } else if (args[index] === "--repeats" && args[index + 1]) {
      options.repeats = Math.max(1, Number.parseInt(args[index + 1], 10) || 1);
      index += 1;
    } else if (args[index] === "--limit" && args[index + 1]) {
      options.limit = Math.max(1, Number.parseInt(args[index + 1], 10) || 100);
      index += 1;
    } else if (args[index] === "--metrics") {
      options.metrics = true;
    }
  }

  if (options.segmentIds.length === 0) {
    throw new Error("Pass at least one segment ID via --segments 74,81");
  }
  return options;
}

function round(value) {
  return Math.round(Number(value) * 100) / 100;
}

const { segmentIds, repeats, limit, metrics } = parseArgs();
await import("../config/env.js");
const { default: pool } = await import("../services/database.js");
const { default: SegmentDBService } = await import("../services/segmentDBService.js");
const { default: WorkoutDBService } = await import("../services/workoutDBService.js");

try {
  const segmentRows = (await pool.query(`
    SELECT id, uid
    FROM gps_segments
    WHERE id = ANY($1::bigint[])
    ORDER BY id
  `, [segmentIds])).rows;

  if (segmentRows.length !== segmentIds.length) {
    const found = new Set(segmentRows.map((row) => Number(row.id)));
    const missing = segmentIds.filter((id) => !found.has(id));
    throw new Error(`Unknown segment IDs: ${missing.join(", ")}`);
  }

  const userIds = new Set(segmentRows.map((row) => Number(row.uid)));
  if (userIds.size !== 1) throw new Error("All benchmark segments must belong to the same user");
  const uid = [...userIds][0];
  const workoutCount = Number((await pool.query(`
    SELECT COUNT(*)::int AS count
    FROM workouts
    WHERE uid = $1
      AND validgps = true
      AND gps_track_blob IS NOT NULL
  `, [uid])).rows[0]?.count) || 0;

  const rows = [];
  for (const segmentId of segmentIds) {
    for (let run = 1; run <= repeats; run += 1) {
      const startedAt = performance.now();
      const result = await SegmentDBService.scanWorkoutsForSegments(uid, [segmentId], {
        includeProfile: true,
        includeExistingBestEfforts: true,
        includeMetrics: false,
        maxMatches: limit
      });

      let materializedWorkouts = 0;
      let workoutBlobMs = 0;
      let averagesMs = 0;
      if (metrics && result.matches.length > 0) {
        const workoutIds = [...new Set(result.matches.map((match) => Number(match.workout_id)))];
        const loadStartedAt = performance.now();
        const rawWorkoutObjects = await WorkoutDBService.getWorkouts(workoutIds);
        const workoutObjects = new Map(
          [...rawWorkoutObjects.entries()].map(([workoutId, workout]) => [Number(workoutId), workout])
        );
        workoutBlobMs = performance.now() - loadStartedAt;
        materializedWorkouts = workoutObjects.size;

        const averagesStartedAt = performance.now();
        for (const match of result.matches) {
          const workout = workoutObjects.get(Number(match.workout_id));
          if (workout) Object.assign(match, workout.getAverages(match.start_offset, match.end_offset));
        }
        averagesMs = performance.now() - averagesStartedAt;
      }
      const totalMs = performance.now() - startedAt;
      const profile = result.profile;
      rows.push({
        segment: segmentId,
        run,
        workouts: workoutCount,
        candidates: profile.candidateWorkoutCount,
        candidatePercent: workoutCount > 0 ? round((profile.candidateWorkoutCount / workoutCount) * 100) : 0,
        rawMatches: profile.rawMatchCount,
        returnedMatches: profile.matchCount,
        materializedWorkouts,
        definitionsMs: profile.loadSegmentDefinitionsMs,
        candidatesMs: profile.loadCandidateRowsMs,
        decodeMs: profile.decodeWorkoutTracksMs,
        matchMs: profile.matchSegmentsMs,
        workoutBlobMs: round(workoutBlobMs),
        averagesMs: round(averagesMs),
        totalMs: round(totalMs)
      });
    }
  }

  console.table(rows);
  console.log(metrics
    ? `Two-phase benchmark: matched first, then materialized at most ${limit} fastest efforts.`
    : `Matching-only: workout streams and averages are not loaded; fastest result limit=${limit}.`);
} finally {
  await pool.end();
}
