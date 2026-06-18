import fs from "fs";
import dotenv from "dotenv";
import { performance } from "perf_hooks";

import Workout from "../shared/Workout.js";
import IntervalDetector from "../shared/IntervalDetector.js";
import BestEffortDetector from "../shared/BestEffortDetector.js";
import SegmentService from "../shared/SegmentService.js";

function loadEnv() {
  const nodeEnv = process.env.NODE_ENV || "development";
  const candidates = [`.env.${nodeEnv}`, ".env"];

  for (const path of candidates) {
    if (fs.existsSync(path)) {
      dotenv.config({ path, override: false });
      break;
    }
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    limit: 20,
    userId: null,
    workoutId: null
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--limit" && args[index + 1]) {
      out.limit = Math.max(1, Number.parseInt(args[index + 1], 10) || out.limit);
      index += 1;
      continue;
    }
    if (arg === "--user" && args[index + 1]) {
      out.userId = Number.parseInt(args[index + 1], 10);
      index += 1;
      continue;
    }
    if (arg === "--workout" && args[index + 1]) {
      out.workoutId = Number.parseInt(args[index + 1], 10);
      index += 1;
    }
  }

  return out;
}

function toRecordsFromWorkout(workout) {
  const records = new Array(workout.length);
  const startTime = Number(workout.getStartTime());

  for (let index = 0; index < workout.length; index += 1) {
    records[index] = {
      timestamp: new Date(startTime + (index * 1000)),
      power: workout.getPowerAt(index),
      heart_rate: workout.getHrAt(index),
      cadence: workout.getCadenceAt(index),
      speed: workout.getSpeedAt(index) / 3.6,
      altitude: workout.getAltitudeAt(index),
      distance: workout.getDistanceAt(index)
    };
  }

  return records;
}

function summarize(stats) {
  const safeDiv = (value, divisor) => divisor > 0 ? value / divisor : 0;

  return {
    workouts: stats.workouts,
    avgDbReadMs: Number(safeDiv(stats.dbReadMs, stats.workouts).toFixed(3)),
    avgDecompressMs: Number(safeDiv(stats.decompressMs, stats.workouts).toFixed(3)),
    avgRecordBuildMs: Number(safeDiv(stats.recordBuildMs, stats.workouts).toFixed(3)),
    avgDetectAutoMs: Number(safeDiv(stats.detectAutoMs, stats.workouts).toFixed(3)),
    avgDetectBestEffortsMs: Number(safeDiv(stats.detectBestEffortsMs, stats.workouts).toFixed(3)),
    avgMapSegmentsMs: Number(safeDiv(stats.mapSegmentsMs, stats.workouts).toFixed(3)),
    avgTotalMs: Number(safeDiv(stats.totalMs, stats.workouts).toFixed(3)),
    totalSegments: stats.totalSegments,
    avgSegmentsPerWorkout: Number(safeDiv(stats.totalSegments, stats.workouts).toFixed(2)),
    avgRecordCount: Number(safeDiv(stats.totalRecords, stats.workouts).toFixed(1))
  };
}

async function run() {
  loadEnv();
  const { default: pool } = await import("../services/database.js");
  const { limit, userId, workoutId } = parseArgs();

  try {
    const params = [];
    const where = [];

    if (Number.isInteger(workoutId) && workoutId > 0) {
      params.push(workoutId);
      where.push(`id = $${params.length}`);
    }

    if (Number.isInteger(userId) && userId > 0) {
      params.push(userId);
      where.push(`uid = $${params.length}`);
    }

    params.push(limit);

    const query = `
      SELECT id, uid, stream, stream_codec
      FROM workouts
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY uploaded_at DESC
      LIMIT $${params.length}
    `;

    const tDb0 = performance.now();
    const result = await pool.query(query, params);
    const tDb1 = performance.now();

    if (result.rowCount === 0) {
      console.log("No workouts found for segment recompute benchmark.");
      return;
    }

    const stats = {
      workouts: 0,
      dbReadMs: tDb1 - tDb0,
      decompressMs: 0,
      recordBuildMs: 0,
      detectAutoMs: 0,
      detectBestEffortsMs: 0,
      mapSegmentsMs: 0,
      totalMs: 0,
      totalSegments: 0,
      totalRecords: 0
    };

    for (const row of result.rows) {
      const workoutStartedAt = performance.now();

      const t0 = performance.now();
      const workout = await Workout.fromCompressedWithCodec(row.stream, row.stream_codec || "brotli");
      const t1 = performance.now();
      stats.decompressMs += (t1 - t0);

      const t2 = performance.now();
      const records = toRecordsFromWorkout(workout);
      const t3 = performance.now();
      stats.recordBuildMs += (t3 - t2);
      stats.totalRecords += records.length;

      const t4 = performance.now();
      const autoIntervals = IntervalDetector.detect(records);
      const t5 = performance.now();
      stats.detectAutoMs += (t5 - t4);

      const t6 = performance.now();
      const bestEffortIntervals = BestEffortDetector.detect(records);
      const t7 = performance.now();
      stats.detectBestEffortsMs += (t7 - t6);

      const t8 = performance.now();
      const autoSegments = SegmentService.createSgmentsFromIntervals(autoIntervals, "auto");
      const bestEffortSegments = SegmentService.createSgmentsFromIntervals(bestEffortIntervals, "crit");
      const segmentCount = autoSegments.length + bestEffortSegments.length;
      const t9 = performance.now();
      stats.mapSegmentsMs += (t9 - t8);
      stats.totalSegments += segmentCount;

      stats.totalMs += (performance.now() - workoutStartedAt);
      stats.workouts += 1;
    }

    console.table([summarize(stats)]);
    console.log("Notes:");
    console.log("- avgDbReadMs is amortized over the full DB query that fetched the selected workouts.");
    console.log("- avgTotalMs includes decompress + record reconstruction + segment detection + segment mapping.");
    console.log("- speed is reconstructed from stored workout stream and converted back to m/s for detector parity.");
  } finally {
    await pool.end();
  }
}

run().catch((error) => {
  console.error("Segment recompute benchmark failed:", error);
  process.exit(1);
});
