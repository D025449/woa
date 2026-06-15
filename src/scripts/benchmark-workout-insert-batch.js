import "../config/env.js";

import { performance } from "node:perf_hooks";

import pool from "../services/database.js";

const BASE_COLUMNS = [
  "uid",
  "start_time",
  "end_time",
  "total_elapsed_time",
  "total_timer_time",
  "total_distance",
  "total_cycles",
  "total_work",
  "total_calories",
  "total_ascent",
  "total_descent",
  "avg_speed",
  "max_speed",
  "avg_power",
  "max_power",
  "avg_normalized_power",
  "avg_heart_rate",
  "max_heart_rate",
  "avg_cadence",
  "max_cadence",
  "validGps",
  "year",
  "month",
  "week",
  "year_quarter",
  "year_month",
  "year_week",
  "bounds",
  "track_start",
  "track_end",
  "points_count",
  "sampleRateGPS",
  "gps_track_blob",
  "stream",
  "gps_source"
];

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    workoutId: null,
    userId: null,
    inserts: 10,
    variant: "full",
    repeats: 5
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    if (arg === "--workout" && next) {
      out.workoutId = Number.parseInt(next, 10);
      index += 1;
    } else if (arg === "--user" && next) {
      out.userId = Number.parseInt(next, 10);
      index += 1;
    } else if (arg === "--inserts" && next) {
      out.inserts = Math.max(1, Number.parseInt(next, 10) || 10);
      index += 1;
    } else if (arg === "--variant" && next) {
      out.variant = next;
      index += 1;
    } else if (arg === "--repeats" && next) {
      out.repeats = Math.max(1, Number.parseInt(next, 10) || 5);
      index += 1;
    }
  }

  return out;
}

function getVariantConfig(variant) {
  switch (variant) {
    case "full":
      return {
        name: "full",
        description: "Current insert with bounds, track_start, track_end, gps_track_blob, full stream"
      };
    case "no-geom":
      return {
        name: "no-geom",
        description: "Insert with all GPS-related columns forced to NULL"
      };
    case "tiny-stream":
      return {
        name: "tiny-stream",
        description: "Current insert, but stream replaced with a 256-byte payload"
      };
    default:
      throw new Error(`Unsupported variant '${variant}'. Allowed: full, no-geom, tiny-stream`);
  }
}

async function loadSourceRow({ workoutId, userId }) {
  const conditions = [];
  const params = [];

  if (Number.isInteger(workoutId) && workoutId > 0) {
    params.push(workoutId);
    conditions.push(`w.id = $${params.length}`);
  }

  if (Number.isInteger(userId) && userId > 0) {
    params.push(userId);
    conditions.push(`w.uid = $${params.length}`);
  }

  const whereClause = conditions.length > 0
    ? `WHERE ${conditions.join(" AND ")}`
    : "";

  const query = `
    SELECT
      w.id,
      w.uid,
      w.start_time,
      w.end_time,
      w.total_elapsed_time,
      w.total_timer_time,
      w.total_distance,
      w.total_cycles,
      w.total_work,
      w.total_calories,
      w.total_ascent,
      w.total_descent,
      w.avg_speed,
      w.max_speed,
      w.avg_power,
      w.max_power,
      w.avg_normalized_power,
      w.avg_heart_rate,
      w.max_heart_rate,
      w.avg_cadence,
      w.max_cadence,
      w.validGps,
      w.year,
      w.month,
      w.week,
      w.year_quarter,
      w.year_month,
      w.year_week,
      w.points_count,
      w.sampleRateGPS,
      w.gps_track_blob,
      w.stream,
      w.gps_source,
      ST_XMin(w.bounds) AS min_lng,
      ST_YMin(w.bounds) AS min_lat,
      ST_XMax(w.bounds) AS max_lng,
      ST_YMax(w.bounds) AS max_lat,
      ST_AsText(w.track_start) AS track_start_wkt,
      ST_AsText(w.track_end) AS track_end_wkt,
      octet_length(w.stream) AS stream_bytes
    FROM workouts w
    ${whereClause}
    ORDER BY w.uploaded_at DESC, w.id DESC
    LIMIT 1
  `;

  const result = await pool.query(query, params);
  return result.rows[0] || null;
}

function shiftDate(value, offsetMs) {
  const source = new Date(value);
  source.setMilliseconds(source.getMilliseconds() + offsetMs);
  return source;
}

function buildInsertParams(row, variant, offsetMs) {
  const validGps = variant === "no-geom" ? false : row.validgps;
  const trackStartWkt = variant === "no-geom" ? null : row.track_start_wkt;
  const trackEndWkt = variant === "no-geom" ? null : row.track_end_wkt;
  const minLng = variant === "no-geom" ? null : row.min_lng;
  const minLat = variant === "no-geom" ? null : row.min_lat;
  const maxLng = variant === "no-geom" ? null : row.max_lng;
  const maxLat = variant === "no-geom" ? null : row.max_lat;
  const gpsTrackBlob = variant === "no-geom" ? null : row.gps_track_blob;
  const stream = variant === "tiny-stream"
    ? Buffer.alloc(Math.min(256, row.stream.length), 0)
    : row.stream;

  return [
    row.uid,
    shiftDate(row.start_time, offsetMs),
    shiftDate(row.end_time, offsetMs),
    row.total_elapsed_time,
    row.total_timer_time,
    row.total_distance,
    row.total_cycles,
    row.total_work,
    row.total_calories,
    row.total_ascent,
    row.total_descent,
    row.avg_speed,
    row.max_speed,
    row.avg_power,
    row.max_power,
    row.avg_normalized_power,
    row.avg_heart_rate,
    row.max_heart_rate,
    row.avg_cadence,
    row.max_cadence,
    validGps,
    row.year,
    row.month,
    row.week,
    row.year_quarter,
    row.year_month,
    row.year_week,
    minLng,
    minLat,
    maxLng,
    maxLat,
    trackStartWkt,
    trackEndWkt,
    row.points_count,
    row.samplerategps,
    gpsTrackBlob,
    stream,
    row.gps_source
  ];
}

function createValuesClause(rowIndex) {
  const offset = rowIndex * 38;
  const p = (index) => `$${offset + index}`;
  return `(
${p(1)},${p(2)},
${p(3)},${p(4)},${p(5)},${p(6)},${p(7)},${p(8)},${p(9)},${p(10)},
${p(11)},${p(12)},${p(13)},${p(14)},${p(15)},${p(16)},${p(17)},${p(18)},
${p(19)},${p(20)},${p(21)},${p(22)},${p(23)},${p(24)},${p(25)},${p(26)},${p(27)},
CASE
  WHEN ${p(21)} = true
  THEN ST_MakeEnvelope(
    ${p(28)}::float8,
    ${p(29)}::float8,
    ${p(30)}::float8,
    ${p(31)}::float8,
    4326
  )
  ELSE NULL
END,
CASE
  WHEN ${p(21)} = true
  THEN ST_GeomFromText(${p(32)}, 4326)
  ELSE NULL
END,
CASE
  WHEN ${p(21)} = true
  THEN ST_GeomFromText(${p(33)}, 4326)
  ELSE NULL
END,
${p(34)},
${p(35)},
${p(36)},
${p(37)},
${p(38)}
)`;
}

function buildSingleInsertSql() {
  return `
INSERT INTO workouts (
  ${BASE_COLUMNS.join(",\n  ")}
)
VALUES ${createValuesClause(0)}
ON CONFLICT (uid, start_time)
DO NOTHING
RETURNING id, uid;
`;
}

function buildBatchInsertSql(rowCount) {
  const valuesClauses = [];
  for (let index = 0; index < rowCount; index += 1) {
    valuesClauses.push(createValuesClause(index));
  }

  return `
INSERT INTO workouts (
  ${BASE_COLUMNS.join(",\n  ")}
)
VALUES
${valuesClauses.join(",\n")}
ON CONFLICT (uid, start_time)
DO NOTHING
RETURNING id, uid;
`;
}

async function runSingleInsertBenchmark(client, row, { inserts, variant, runIndex }) {
  const sql = buildSingleInsertSql();
  const startedAt = performance.now();
  let insertedRows = 0;

  await client.query("BEGIN");
  try {
    for (let index = 0; index < inserts; index += 1) {
      const offsetMs = ((runIndex * 1_000_000) + index + 1) * 1000;
      const params = buildInsertParams(row, variant, offsetMs);
      const result = await client.query(sql, params);
      insertedRows += result.rowCount;
    }
  } finally {
    await client.query("ROLLBACK");
  }

  return {
    mode: "single",
    wallMs: performance.now() - startedAt,
    insertedRows
  };
}

async function runBatchInsertBenchmark(client, row, { inserts, variant, runIndex }) {
  const sql = buildBatchInsertSql(inserts);
  const startedAt = performance.now();
  const params = [];

  for (let index = 0; index < inserts; index += 1) {
    const offsetMs = ((runIndex * 1_000_000) + index + 1) * 1000;
    params.push(...buildInsertParams(row, variant, offsetMs));
  }

  let insertedRows = 0;
  await client.query("BEGIN");
  try {
    const result = await client.query(sql, params);
    insertedRows = result.rowCount;
  } finally {
    await client.query("ROLLBACK");
  }

  return {
    mode: "batch",
    wallMs: performance.now() - startedAt,
    insertedRows
  };
}

function summarizeRuns(mode, runs, inserts) {
  const wallValues = runs.map((run) => run.wallMs).sort((a, b) => a - b);
  const totalMs = wallValues.reduce((sum, value) => sum + value, 0);
  const avgMs = totalMs / wallValues.length;
  const p50Ms = wallValues[Math.floor(wallValues.length * 0.5)] ?? wallValues[wallValues.length - 1] ?? 0;
  const p95Ms = wallValues[Math.min(wallValues.length - 1, Math.floor(wallValues.length * 0.95))] ?? wallValues[wallValues.length - 1] ?? 0;
  return {
    mode,
    insertsPerRun: inserts,
    runs: runs.length,
    avgMs: Number(avgMs.toFixed(3)),
    perInsertAvgMs: Number((avgMs / inserts).toFixed(3)),
    minMs: Number((wallValues[0] ?? 0).toFixed(3)),
    p50Ms: Number(p50Ms.toFixed(3)),
    p95Ms: Number(p95Ms.toFixed(3)),
    maxMs: Number((wallValues[wallValues.length - 1] ?? 0).toFixed(3))
  };
}

async function main() {
  const args = parseArgs();
  const variantConfig = getVariantConfig(args.variant);
  const row = await loadSourceRow({
    workoutId: args.workoutId,
    userId: args.userId
  });

  if (!row) {
    console.log("No source workout found for batch insert benchmark input.");
    return;
  }

  const client = await pool.connect();
  try {
    const singleRuns = [];
    const batchRuns = [];

    for (let runIndex = 0; runIndex < args.repeats; runIndex += 1) {
      singleRuns.push(await runSingleInsertBenchmark(client, row, {
        inserts: args.inserts,
        variant: args.variant,
        runIndex
      }));
      batchRuns.push(await runBatchInsertBenchmark(client, row, {
        inserts: args.inserts,
        variant: args.variant,
        runIndex: runIndex + args.repeats
      }));
    }

    const singleSummary = summarizeRuns("single", singleRuns, args.inserts);
    const batchSummary = summarizeRuns("batch", batchRuns, args.inserts);
    const speedup = batchSummary.avgMs > 0
      ? Number((singleSummary.avgMs / batchSummary.avgMs).toFixed(3))
      : null;

    console.log(`Variant: ${variantConfig.name}`);
    console.log(variantConfig.description);
    console.log(`Source workout: ${row.id}`);
    console.log(`Source stream bytes: ${row.stream_bytes}`);
    console.log(`Inserts per run: ${args.inserts}`);
    console.log(`Runs per mode: ${args.repeats}`);
    console.table([singleSummary, batchSummary]);
    console.log("Notes:");
    console.log("- single = one INSERT per workout row inside a transaction, rolled back after each run");
    console.log("- batch = one multi-row INSERT statement per run, rolled back after each run");
    console.log("- Both modes use the same source workout shape and shifted timestamps to avoid conflicts.");
    if (speedup !== null) {
      console.log(`- Average speedup (single/batch): ${speedup}x`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Workout insert batch benchmark failed:", error);
  process.exitCode = 1;
});
