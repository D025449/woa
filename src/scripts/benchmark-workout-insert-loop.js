import "../config/env.js";

import { performance } from "node:perf_hooks";

import pool from "../services/database.js";

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    workoutId: null,
    userId: null,
    sourceLimit: 1,
    inserts: 20,
    variant: "full"
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
    } else if (arg === "--source-limit" && next) {
      out.sourceLimit = Math.max(1, Number.parseInt(next, 10) || 1);
      index += 1;
    } else if (arg === "--inserts" && next) {
      out.inserts = Math.max(1, Number.parseInt(next, 10) || 20);
      index += 1;
    } else if (arg === "--variant" && next) {
      out.variant = next;
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
        description: "Original insert with bounds, track_start, track_end, geom, full stream"
      };
    case "no-geom":
      return {
        name: "no-geom",
        description: "Insert with all geometry-related columns forced to NULL"
      };
    case "tiny-stream":
      return {
        name: "tiny-stream",
        description: "Original geometry, but stream replaced with 256-byte payload"
      };
    default:
      throw new Error(`Unsupported variant '${variant}'. Allowed: full, no-geom, tiny-stream`);
  }
}

async function loadSourceRows({ workoutId, userId, sourceLimit }) {
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

  params.push(sourceLimit);

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
      w.stream,
      w.gps_source,
      ST_XMin(w.bounds) AS min_lng,
      ST_YMin(w.bounds) AS min_lat,
      ST_XMax(w.bounds) AS max_lng,
      ST_YMax(w.bounds) AS max_lat,
      ST_AsText(w.track_start) AS track_start_wkt,
      ST_AsText(w.track_end) AS track_end_wkt,
      ST_AsText(w.geom) AS geom_wkt,
      octet_length(w.stream) AS stream_bytes
    FROM workouts w
    ${whereClause}
    ORDER BY w.uploaded_at DESC, w.id DESC
    LIMIT $${params.length}
  `;

  const result = await pool.query(query, params);
  return result.rows;
}

function shiftDate(value, offsetMs) {
  const source = new Date(value);
  source.setMilliseconds(source.getMilliseconds() + offsetMs);
  return source;
}

function buildInsertParams(row, variant, offsetMs) {
  const validGps = variant === "no-geom" ? false : row.validgps;
  const geomWkt = variant === "no-geom" ? null : row.geom_wkt;
  const trackStartWkt = variant === "no-geom" ? null : row.track_start_wkt;
  const trackEndWkt = variant === "no-geom" ? null : row.track_end_wkt;
  const minLng = variant === "no-geom" ? null : row.min_lng;
  const minLat = variant === "no-geom" ? null : row.min_lat;
  const maxLng = variant === "no-geom" ? null : row.max_lng;
  const maxLat = variant === "no-geom" ? null : row.max_lat;
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
    geomWkt,
    trackStartWkt,
    trackEndWkt,
    row.points_count,
    row.samplerategps,
    stream,
    row.gps_source
  ];
}

const INSERT_SQL = `
INSERT INTO workouts (
  uid,
  start_time,
  end_time,
  total_elapsed_time,
  total_timer_time,
  total_distance,
  total_cycles,
  total_work,
  total_calories,
  total_ascent,
  total_descent,
  avg_speed,
  max_speed,
  avg_power,
  max_power,
  avg_normalized_power,
  avg_heart_rate,
  max_heart_rate,
  avg_cadence,
  max_cadence,
  validGps,
  year,
  month,
  week,
  year_quarter,
  year_month,
  year_week,
  bounds,
  track_start,
  track_end,
  geom,
  points_count,
  sampleRateGPS,
  stream,
  gps_source
)
VALUES (
  $1,$2,
  $3,$4,$5,$6,$7,$8,$9,$10,
  $11,$12,$13,$14,$15,$16,$17,$18,
  $19,$20,$21,$22,$23,$24,$25,$26,$27,
CASE
  WHEN $21 = true
  THEN ST_MakeEnvelope(
    $28::float8,
    $29::float8,
    $30::float8,
    $31::float8,
    4326
  )
  ELSE NULL
END,
CASE
  WHEN $21 = true
  THEN ST_GeomFromText($33, 4326)
  ELSE NULL
END,
CASE
  WHEN $21 = true
  THEN ST_GeomFromText($34, 4326)
  ELSE NULL
END,
CASE
  WHEN $21 = true
  THEN ST_GeomFromText($32, 4326)
  ELSE NULL
END,
  $35,
  $36,
  $37,
  $38
)
ON CONFLICT (uid, start_time)
DO NOTHING
RETURNING id, uid
`;

async function runLoopBenchmark(client, rows, variant, inserts) {
  const insertTimesMs = [];
  let inserted = 0;

  await client.query("BEGIN");
  try {
    for (let index = 0; index < inserts; index += 1) {
      const row = rows[index % rows.length];
      const offsetMs = (index + 1) * 10;
      const params = buildInsertParams(row, variant, offsetMs);
      const startedAt = performance.now();
      const result = await client.query(INSERT_SQL, params);
      const endedAt = performance.now();

      insertTimesMs.push(endedAt - startedAt);
      inserted += result.rowCount;
    }

    await client.query("ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }

  return {
    insertTimesMs,
    inserted
  };
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const total = values.reduce((sum, current) => sum + current, 0);
  const average = total / Math.max(1, values.length);
  const percentile = (p) => {
    if (sorted.length === 0) {
      return 0;
    }
    const index = Math.min(
      sorted.length - 1,
      Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)
    );
    return sorted[index];
  };

  return {
    count: values.length,
    totalMs: Number(total.toFixed(3)),
    avgMs: Number(average.toFixed(3)),
    minMs: Number((sorted[0] ?? 0).toFixed(3)),
    p50Ms: Number(percentile(50).toFixed(3)),
    p95Ms: Number(percentile(95).toFixed(3)),
    maxMs: Number((sorted[sorted.length - 1] ?? 0).toFixed(3))
  };
}

async function main() {
  const args = parseArgs();
  const variantConfig = getVariantConfig(args.variant);
  const rows = await loadSourceRows(args);

  if (rows.length === 0) {
    console.log("No source workouts found for loop benchmark input.");
    return;
  }

  console.log(`Variant: ${variantConfig.name}`);
  console.log(variantConfig.description);
  console.log(`Source rows: ${rows.length}`);
  console.log(`Requested inserts: ${args.inserts}`);

  const client = await pool.connect();
  try {
    const startedAt = performance.now();
    const result = await runLoopBenchmark(client, rows, variantConfig.name, args.inserts);
    const endedAt = performance.now();

    console.table([{
      variant: variantConfig.name,
      sourceRows: rows.length,
      insertsRequested: args.inserts,
      insertsExecuted: result.insertTimesMs.length,
      insertsReturned: result.inserted,
      wallMs: Number((endedAt - startedAt).toFixed(3)),
      ...summarize(result.insertTimesMs)
    }]);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Workout insert loop benchmark failed:", error);
  process.exit(1);
});
