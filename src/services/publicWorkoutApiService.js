import { intensityProfilesFromTags } from "../shared/WorkoutIntensityTags.js";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import sharp from "sharp";
import pool from "./database.js";
import { prepareYearlyFtpSeries, yearlyFtpAt, derivedCyclingMetrics } from "./publicTrainingMetrics.js";
import { PUBLIC_ANALYTICS_LIMITS, spawnPublicApiWorker } from "./publicApiLimits.js";
import { PUBLIC_GPS_LIMITS } from "./publicApiGpsService.js";
import { PUBLIC_FIT_LIMITS, fitBudgetExceeded, runPublicFitWorker } from "./publicApiFitService.js";
import LocalThumbnailMapService from "./localThumbnailMapService.js";

const METRICS = Object.freeze({
  elapsed_time_seconds: "total_elapsed_time", timer_time_seconds: "total_timer_time",
  distance_meters: "total_distance", total_cycles: "total_cycles", work_joules: "total_work",
  calories_kcal: "total_calories", ascent_meters: "total_ascent", descent_meters: "total_descent",
  avg_speed_mps: "avg_speed", max_speed_mps: "max_speed", avg_power_watts: "avg_power",
  max_power_watts: "max_power", normalized_power_watts: "avg_normalized_power",
  avg_heart_rate_bpm: "avg_heart_rate", max_heart_rate_bpm: "max_heart_rate",
  avg_cadence_rpm: "avg_cadence", max_cadence_rpm: "max_cadence"
});
const CLASSIFICATIONS = Object.freeze({
  workout_type: ["unknown", "road", "mountain", "indoor", "motorsport"],
  terrain_profile: ["altitude_missing", "flat", "rolling", "mountainous", "altitude_invalid"],
  intensity_profile: ["unknown", "recovery", "endurance", "tempo", "threshold", "vo2max", "anaerobic"],
  intensity_structure: ["unknown", "steady", "variable", "intervals"],
  intensity_dose: ["unknown", "low", "moderate", "high"]
});

export function finite(value) {
  return !["number", "string"].includes(typeof value) || String(value).trim() === "" || !Number.isFinite(Number(value))
    ? null : Number(value);
}

function timestamp(value) {
  if (value == null) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function projectPublicWorkout(row, ftpValue = null) {
  const output = { id: String(row.id), uploaded_at: timestamp(row.uploaded_at),
    start_time: timestamp(row.start_time), end_time: timestamp(row.end_time) };
  for (const [field, column] of Object.entries(METRICS)) {
    const value = finite(row[column]);
    output[field] = value >= 0 ? value : null;
  }
  if (!Number.isInteger(output.total_cycles)) output.total_cycles = null;
  Object.assign(output, derivedCyclingMetrics(output.normalized_power_watts, output.timer_time_seconds, ftpValue,
    ["road", "mountain", "indoor"].includes(row.workout_type)));
  for (const [field, allowed] of Object.entries(CLASSIFICATIONS)) {
    output[field] = allowed.includes(row[field]) ? row[field] : allowed[0];
  }
  output.intensity_tags = intensityProfilesFromTags(row.intensity_tags);
  const exertion = finite(row.perceived_exertion);
  output.perceived_exertion = Number.isInteger(exertion) && exertion >= 1 && exertion <= 10 ? exertion : null;
  output.gps_available = row.validgps === true;
  output.gps_source = ["recorded", "manual_lookup"].includes(row.gps_source) ? row.gps_source : null;
  const sampleInterval = finite(row.samplerategps);
  output.gps_sample_interval_seconds = sampleInterval > 0 ? sampleInterval : null;
  return output;
}

const TYPES = new Set(CLASSIFICATIONS.workout_type);
// Legacy TIMESTAMP values were stored in UTC, as confirmed by the user.
const COLUMNS = `id::text, uploaded_at AT TIME ZONE 'UTC' AS uploaded_at,
  start_time, end_time, ${Object.values(METRICS).join(", ")}, workout_type, terrain_profile,
  intensity_profile, intensity_tags, intensity_structure, intensity_dose, perceived_exertion,
  validgps, gps_source, samplerategps,
  to_char(start_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_start`;

export function apiFailure(statusCode, code, message) {
  throw Object.assign(new Error(message), { statusCode, code });
}

export function publicWorkoutId(value) {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/.test(value) || BigInt(value) > 9223372036854775807n) {
    apiFailure(400, "invalid_request", "Invalid workout ID.");
  }
  return value;
}

function filterTimestamp(value) {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]{1,6})?(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])$/.test(value)
    || value.startsWith("0000") || !Number.isFinite(Date.parse(value))
    || new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== value.slice(0, 10)) {
    apiFailure(400, "invalid_request", "Use valid RFC 3339 timestamps with an offset and at most six fractional digits.");
  }
  const utc = new Date(value).toISOString();
  if (utc.length !== 24) apiFailure(400, "invalid_request", "Timestamp out of range.");
  const fraction = (value.match(/\.([0-9]+)/)?.[1] || "").padEnd(6, "0");
  return `${utc.slice(0, 19)}.${fraction}Z`;
}

export function parsePublicWorkoutQuery(params) {
  const allowed = new Set(["from", "to", "type", "limit", "cursor"]);
  for (const key of params.keys()) {
    if (!allowed.has(key) || params.getAll(key).length !== 1) {
      apiFailure(400, "invalid_request", "Unknown or repeated query parameter.");
    }
  }
  const limit = params.get("limit") ?? "50";
  const type = params.get("type");
  const cursor = params.get("cursor");
  if (!/^[1-9][0-9]{0,2}$/.test(limit) || Number(limit) > 100 || (type !== null && !TYPES.has(type))
    || (cursor !== null && (!/^[A-Za-z0-9_-]+$/.test(cursor) || cursor.length > 4096))) {
    apiFailure(400, "invalid_request", "Invalid limit, type or cursor.");
  }
  const from = params.has("from") ? filterTimestamp(params.get("from")) : null;
  const to = params.has("to") ? filterTimestamp(params.get("to")) : null;
  if (from && to && from >= to) apiFailure(400, "invalid_request", "from must precede to.");
  return { limit: Number(limit), cursor, filters: { from, to, type } };
}

let activeGpsWorkers = 0;

export async function runPublicGpsWorker(row, id, timeoutMs = PUBLIC_GPS_LIMITS.timeoutMs) {
  if (activeGpsWorkers >= PUBLIC_GPS_LIMITS.workers) {
    apiFailure(429, "rate_limited", "GPS processing capacity exceeded.");
  }
  activeGpsWorkers += 1;
  try {
    return await spawnPublicApiWorker({
      workerUrl: new URL("../workers/public-api-gps-worker.js", import.meta.url),
      workerData: { blob: row.gps_track_blob, codec: row.gps_track_blob_codec, id },
      resourceLimits: { maxOldGenerationSizeMb: 96 },
      timeoutMs,
      validateMessage: message => typeof message.json === "string" ? message.json : null,
      errorMessage: "GPS processing unavailable.",
      tooLargeCode: "gps_response_too_large",
    });
  } finally {
    activeGpsWorkers -= 1;
  }
}

export default class PublicWorkoutApiService {
  constructor({ database = pool, cursorSecret = null, now = Date.now, fitWorker = runPublicFitWorker,
    localMapClient = LocalThumbnailMapService } = {}) {
    this.database = database;
    this.cursorSecret = cursorSecret;
    this.now = now;
    this.fitWorker = fitWorker;
    this.localMapClient = localMapClient;
  }

  cursorKey() {
    const secret = this.cursorSecret ?? process.env.SESSION_SECRET;
    if (typeof secret !== "string" || !secret) apiFailure(503, "service_unavailable", "API configuration unavailable.");
    return createHash("sha256").update("woa-public-workout-cursor-v1\0").update(secret).digest();
  }

  encodeCursor(userId, filters, row) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.cursorKey(), nonce);
    const payload = JSON.stringify({ version: 1, userId, filters, id: String(row.id),
      start: row.cursor_start, expires: this.now() + 86400000 });
    const encrypted = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64url");
  }

  decodeCursor(token, userId, filters) {
    const key = this.cursorKey();
    try {
      const bytes = Buffer.from(token, "base64url");
      if (bytes.length < 29 || bytes.toString("base64url") !== token) throw new Error("Invalid encoding");
      const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      const payload = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"));
      if (payload.version !== 1 || payload.userId !== userId || payload.expires <= this.now()
        || JSON.stringify(payload.filters) !== JSON.stringify(filters)) throw new Error("Invalid binding");
      publicWorkoutId(payload.id);
      if (payload.start !== null && filterTimestamp(payload.start) !== payload.start) throw new Error("Invalid position");
      return payload;
    } catch { apiFailure(400, "invalid_request", "Invalid or expired cursor."); }
  }

  async read(operation) {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN READ ONLY");
      await client.query("SET LOCAL statement_timeout = '5000ms'");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  async projectRows(client, userId, rows) {
    if (!rows.length) return [];
    const result = await client.query("SELECT period, ftp FROM get_ftp_by_period2($1, $2) ORDER BY period LIMIT $3",
      [userId, "year", PUBLIC_ANALYTICS_LIMITS.ftpRows + 1]);
    if (result.rows.length > PUBLIC_ANALYTICS_LIMITS.ftpRows) apiFailure(503, "service_unavailable", "FTP history exceeds the configured budget.");
    const series = prepareYearlyFtpSeries(result.rows);
    return rows.map(row => projectPublicWorkout(row, row.start_time == null ? null
      : yearlyFtpAt(series, new Date(row.start_time).getTime())));
  }

  async list(owner, params) {
    const userId = publicWorkoutId(String(owner));
    const { limit, cursor, filters } = parsePublicWorkoutQuery(params);
    const position = cursor ? this.decodeCursor(cursor, userId, filters) : null;
    const values = [userId];
    const clauses = ["uid = $1"];
    const bind = value => { values.push(value); return `$${values.length}`; };
    if (filters.from) clauses.push(`start_time >= ${bind(filters.from)}::timestamptz`);
    if (filters.to) clauses.push(`start_time < ${bind(filters.to)}::timestamptz`);
    if (filters.type) clauses.push(`workout_type = ${bind(filters.type)}`);
    if (position) {
      const id = bind(position.id);
      if (position.start === null) clauses.push(`start_time IS NULL AND id < ${id}::bigint`);
      else {
        const start = bind(position.start);
        clauses.push(`(start_time IS NULL OR (start_time, id) < (${start}::timestamptz, ${id}::bigint))`);
      }
    }
    const pageLimit = bind(limit + 1);
    return this.read(async client => {
      const { rows } = await client.query(`SELECT ${COLUMNS} FROM workouts WHERE ${clauses.join(" AND ")}
        ORDER BY start_time DESC NULLS LAST, id DESC LIMIT ${pageLimit}`, values);
      const page = rows.slice(0, limit);
      const next = rows.length > limit ? this.encodeCursor(userId, filters, page.at(-1)) : null;
      return { data: await this.projectRows(client, userId, page), next_cursor: next };
    });
  }

  async detail(owner, id) {
    const userId = publicWorkoutId(String(owner));
    publicWorkoutId(id);
    return this.read(async client => {
      const { rows } = await client.query(`SELECT ${COLUMNS} FROM workouts WHERE uid = $1 AND id = $2`, [userId, id]);
      if (!rows.length) apiFailure(404, "workout_not_found", "Workout not found.");
      return { data: (await this.projectRows(client, userId, rows))[0] };
    });
  }

  async fit(owner, id) {
    const userId = publicWorkoutId(String(owner));
    publicWorkoutId(id);
    const payload = await this.read(async client => {
      const { rows } = await client.query(`SELECT id::text, validgps, samplerategps, gps_source, stream_codec, gps_track_blob_codec,
        avg_normalized_power, total_calories, workout_type,
        octet_length(stream) AS stream_size, octet_length(gps_track_blob) AS gps_size,
        octet_length(fit_device_metadata::text) AS metadata_size,
        CASE WHEN octet_length(stream) <= $3 THEN stream END AS stream,
        CASE WHEN validgps = true AND octet_length(gps_track_blob) <= $4 THEN gps_track_blob END AS gps_track_blob,
        CASE WHEN octet_length(fit_device_metadata::text) <= $5 THEN fit_device_metadata END AS fit_device_metadata
        FROM workouts WHERE uid = $1 AND id = $2`,
      [userId, id, PUBLIC_FIT_LIMITS.streamBytes, PUBLIC_FIT_LIMITS.gpsBlobBytes, PUBLIC_FIT_LIMITS.metadataBytes]);
      if (!rows.length) apiFailure(404, "workout_not_found", "Workout not found.");
      const row = rows[0];
      if (Number(row.stream_size) > PUBLIC_FIT_LIMITS.streamBytes
        || (row.validgps === true && Number(row.gps_size) > PUBLIC_FIT_LIMITS.gpsBlobBytes)
        || Number(row.metadata_size) > PUBLIC_FIT_LIMITS.metadataBytes) fitBudgetExceeded();
      const result = await client.query(`SELECT id::text, start_offset, end_offset, segmenttype, structure_kind
        FROM workout_segments WHERE uid = $1 AND wid = $2
          AND (segmenttype = 'manual' OR structure_kind IN ('microintervals', 'intervals'))
        ORDER BY start_offset, id LIMIT $3`, [userId, id, PUBLIC_FIT_LIMITS.segments + 1]);
      if (result.rows.length > PUBLIC_FIT_LIMITS.segments) fitBudgetExceeded();
      const blocks = result.rows.filter(segment => ["microintervals", "intervals"].includes(segment.structure_kind));
      if (blocks.length) {
        const phases = await client.query(`SELECT p.segment_id::text, p.position, p.phase_kind, p.start_offset, p.end_offset
          FROM workout_segment_phases p JOIN workout_segments s ON s.id = p.segment_id
          WHERE s.uid = $1 AND s.wid = $2 AND s.id = ANY($3::bigint[])
          ORDER BY p.segment_id, p.position LIMIT $4`,
        [userId, id, blocks.map(segment => segment.id), PUBLIC_FIT_LIMITS.phases + 1]);
        if (phases.rows.length > PUBLIC_FIT_LIMITS.phases) fitBudgetExceeded();
        const byId = new Map(blocks.map(block => [String(block.id), block]));
        for (const block of blocks) block.phases = [];
        for (const phase of phases.rows) byId.get(String(phase.segment_id))?.phases.push(phase);
      }
      return { row, segments: result.rows };
    });
    return this.fitWorker(payload.row, payload.segments);
  }

  async gps(owner, id) {
    const userId = publicWorkoutId(String(owner));
    publicWorkoutId(id);
    const row = await this.read(async client => {
      const { rows } = await client.query(`SELECT validgps, gps_track_blob_codec,
        octet_length(gps_track_blob) AS blob_size,
        CASE WHEN validgps = true AND octet_length(gps_track_blob) <= $3 THEN gps_track_blob END AS gps_track_blob
        FROM workouts WHERE uid = $1 AND id = $2`, [userId, id, PUBLIC_GPS_LIMITS.blobBytes]);
      if (!rows.length) apiFailure(404, "workout_not_found", "Workout not found.");
      return rows[0];
    });
    if (row.validgps === true && Number(row.blob_size) > PUBLIC_GPS_LIMITS.blobBytes) {
      apiFailure(422, "gps_response_too_large", "GPS response exceeds the configured budget.");
    }
    if (row.validgps !== true || !row.gps_track_blob) {
      return JSON.stringify({ type: "Feature", properties: { workout_id: id }, geometry: null });
    }
    return runPublicGpsWorker(row, id);
  }

  async map(userId, workoutId) {
    const geoJsonStr = await this.gps(userId, workoutId);
    const { geometry } = JSON.parse(geoJsonStr);
    if (!geometry) apiFailure(404, "workout_not_found", "Workout has no GPS track.");
    const segments = geometry.type === "MultiLineString" ? geometry.coordinates : [geometry.coordinates];
    let result;
    try {
      result = await this.localMapClient.render({ segments });
    } catch {
      apiFailure(503, "map_unavailable", "Map rendering is unavailable.");
    }
    return sharp(result.background)
      .composite([{ input: Buffer.from(result.routeSvg) }])
      .resize(640, 400)
      .webp({ quality: 65 })
      .toBuffer();
  }
}
