import fs from "fs";
import dotenv from "dotenv";
import { performance } from "perf_hooks";
import Workout from "../shared/Workout.js";

const HEADER_BYTES = 16;
const ARRAY_COUNT = 5;
const STREAM_FORMAT_CUMULATIVE_SI = 3;

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
    limit: 30,
    userId: null
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--limit" && args[i + 1]) {
      out.limit = Math.max(1, Number.parseInt(args[i + 1], 10) || out.limit);
      i += 1;
    } else if (arg === "--user" && args[i + 1]) {
      out.userId = Number.parseInt(args[i + 1], 10);
      i += 1;
    }
  }

  return out;
}

function buildCumBufferFromWorkout(workout) {
  const length = workout.length;
  const bytes = HEADER_BYTES + (ARRAY_COUNT * length * 4);
  const buffer = new ArrayBuffer(bytes);
  const view = new DataView(buffer);

  view.setUint32(0, length);
  view.setFloat64(4, workout.getStartTime());
  view.setUint8(12, workout.isValidGps() ? 1 : 0);
  view.setUint8(13, STREAM_FORMAT_CUMULATIVE_SI);
  view.setUint8(14, 0);
  view.setUint8(15, 0);

  let offset = HEADER_BYTES;
  new Uint32Array(buffer, offset, length).set(workout.cumPower); offset += length * 4;
  new Uint32Array(buffer, offset, length).set(workout.cumHr); offset += length * 4;
  new Uint32Array(buffer, offset, length).set(workout.cumCadence); offset += length * 4;
  new Uint32Array(buffer, offset, length).set(workout.cumSpeed); offset += length * 4;
  new Int32Array(buffer, offset, length).set(workout.cumAltitude);

  return buffer;
}

function summarize(name, stats) {
  const perWorkout = (value) => value / Math.max(1, stats.workouts);
  return {
    variant: name,
    workouts: stats.workouts,
    totalRawBytes: stats.totalRawBytes,
    totalCompressedBytes: stats.totalCompressedBytes,
    compressionRatio: stats.totalCompressedBytes / Math.max(1, stats.totalRawBytes),
    avgRawBytes: Math.round(perWorkout(stats.totalRawBytes)),
    avgCompressedBytes: Math.round(perWorkout(stats.totalCompressedBytes)),
    avgEncodeMs: Number(perWorkout(stats.encodeMs).toFixed(3)),
    avgDecodeMs: Number(perWorkout(stats.decodeMs).toFixed(3))
  };
}

async function run() {
  loadEnv();
  const { limit, userId } = parseArgs();
  const { default: pool } = await import("../services/database.js");

  try {
    const params = [];
    let where = "";
    if (Number.isInteger(userId) && userId > 0) {
      params.push(userId);
      where = `WHERE uid = $${params.length}`;
    }
    params.push(limit);

    const query = `
      SELECT id, uid, stream
      FROM workouts
      ${where}
      ORDER BY uploaded_at DESC
      LIMIT $${params.length}
    `;

    const result = await pool.query(query, params);
    if (result.rowCount === 0) {
      console.log("No workouts found for benchmark input.");
      return;
    }

    const compactAbsoluteStats = {
      workouts: 0,
      totalRawBytes: 0,
      totalCompressedBytes: 0,
      encodeMs: 0,
      decodeMs: 0
    };

    const cumulativeStats = {
      workouts: 0,
      totalRawBytes: 0,
      totalCompressedBytes: 0,
      encodeMs: 0,
      decodeMs: 0
    };

    let skippedUnsupported = 0;

    for (const row of result.rows) {
      let workout;
      try {
        workout = await Workout.fromCompressed(row.stream);
      } catch {
        skippedUnsupported += 1;
        continue;
      }

      const rawCompact = workout.toBuffer();
      const rawCum = buildCumBufferFromWorkout(workout);

      compactAbsoluteStats.workouts += 1;
      compactAbsoluteStats.totalRawBytes += rawCompact.byteLength;

      cumulativeStats.workouts += 1;
      cumulativeStats.totalRawBytes += rawCum.byteLength;

      {
        const t0 = performance.now();
        const compressed = await Workout.compress(rawCompact);
        const t1 = performance.now();
        compactAbsoluteStats.encodeMs += (t1 - t0);
        compactAbsoluteStats.totalCompressedBytes += compressed.byteLength ?? compressed.length ?? 0;

        const t2 = performance.now();
        await Workout.fromCompressed(compressed);
        const t3 = performance.now();
        compactAbsoluteStats.decodeMs += (t3 - t2);
      }

      {
        const t0 = performance.now();
        const compressedCum = await Workout.compress(rawCum);
        const t1 = performance.now();
        cumulativeStats.encodeMs += (t1 - t0);
        cumulativeStats.totalCompressedBytes += compressedCum.byteLength ?? compressedCum.length ?? 0;

        const t2 = performance.now();
        await Workout.fromCompressed(compressedCum);
        const t3 = performance.now();
        cumulativeStats.decodeMs += (t3 - t2);
      }
    }

    if (compactAbsoluteStats.workouts === 0) {
      console.log("No benchmarkable workouts found (only unsupported legacy stream formats).");
      return;
    }

    console.table([
      summarize("compact-absolute(v5)", compactAbsoluteStats),
      summarize("cumulative(v3-simulated)", cumulativeStats)
    ]);

    console.log("Notes:");
    console.log("- compact-absolute(v5): current layout (absolute compact samples)");
    console.log("- cumulative(v3-simulated): synthetic cumulative layout for direct A/B on same workouts");
    if (skippedUnsupported > 0) {
      console.log(`- skipped unsupported legacy streams: ${skippedUnsupported}`);
    }
  } finally {
    await pool.end();
  }
}

run().catch((err) => {
  console.error("Persistence benchmark failed:", err);
  process.exit(1);
});
