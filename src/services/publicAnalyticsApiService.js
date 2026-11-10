import pool from "./database.js";
import { Pool } from "pg";
import { FileDBService } from "./fileDBService.js";
import { apiFailure, publicWorkoutId } from "./publicWorkoutApiService.js";
import { parsePerformanceOptions, selectPublicPowerEfforts, buildPublicPowerProfile, buildPublicFtpHistory } from "./publicAnalyticsPowerService.js";

const DAY = 86400000;
export const PUBLIC_ANALYTICS_LIMITS = Object.freeze({ days: 366, rows: 50000,
  historyDays: 20000, ftpRows: 500, responseBytes: 1024 * 1024, concurrent: 2 });
// Keep analytics connection waits bounded without changing the application's
// existing shared pool or its other callers.
const analyticsDatabase = new Pool({ ...pool.options, max: PUBLIC_ANALYTICS_LIMITS.concurrent, connectionTimeoutMillis: 5000 });

function budget() {
  apiFailure(422, "analytics_response_too_large", "Analytics exceeds the configured budget.");
}

function dateValue(value) {
  if (typeof value !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)
    || value.startsWith("0000")) apiFailure(400, "invalid_request", "Use UTC calendar dates.");
  const time = Date.parse(value + "T00:00:00Z");
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) {
    apiFailure(400, "invalid_request", "Invalid calendar date.");
  }
  return time;
}

export function parsePublicAnalyticsQuery(params, now = Date.now()) {
  for (const key of params.keys()) {
    if (!["from", "to"].includes(key) || params.getAll(key).length !== 1) {
      apiFailure(400, "invalid_request", "Unknown or repeated query parameter.");
    }
  }
  const today = Math.floor(now / DAY) * DAY;
  const to = params.has("to") ? dateValue(params.get("to")) : today + DAY;
  const from = params.has("from") ? dateValue(params.get("from")) : to - 28 * DAY;
  if (from >= to || to > today + DAY || (to - from) / DAY > PUBLIC_ANALYTICS_LIMITS.days) {
    apiFailure(400, "invalid_request", "Use a past/current interval of at most 366 days.");
  }
  return { from: new Date(from).toISOString().slice(0, 10), to: new Date(to).toISOString().slice(0, 10) };
}

function nonnegative(value) {
  return ["number", "string"].includes(typeof value) && String(value).trim() !== ""
    && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
}

function rounded(value) {
  if (!Number.isFinite(value)) budget();
  const result = Math.round(value * 1000) / 1000;
  if (!Number.isFinite(result)) budget();
  return result;
}

// The existing yearly FTP method, with UTC anchors and no fallback to a later
// year's value before the first available year. Results are retrospective.
export function analyticsFtpAt(series, time) {
  if (!series.length || time < series[0].time) return null;
  let low = 0, high = series.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (series[middle].time <= time) low = middle; else high = middle - 1;
  }
  const left = series[low], right = series[low + 1];
  const value = right ? left.ftp + (time - left.time) / (right.time - left.time) * (right.ftp - left.ftp) : left.ftp;
  return Number.isFinite(value) && value > 0 ? value : null;
}

function statistics() {
  return { activity_count: 0, imported_activity_count: 0, manual_activity_count: 0,
    timer_time_seconds: 0, missing_duration_count: 0, tss: 0,
    recorded_derived_tss: 0, manual_estimated_tss: 0,
    known_tss_count: 0, missing_tss_count: 0, tss_not_applicable_count: 0 };
}

function finishStatistics(stats) {
  const result = { ...stats };
  for (const key of ["timer_time_seconds", "tss", "recorded_derived_tss", "manual_estimated_tss"]) result[key] = rounded(result[key]);
  if (!result.known_tss_count && result.missing_tss_count) result.tss = null;
  if (result.missing_duration_count === result.activity_count && result.activity_count) result.timer_time_seconds = null;
  return result;
}

function addActivity(stats, row, duration, tss, applicable) {
  stats.activity_count += 1;
  const manual = row.entity_type === "manual_activity";
  stats[manual ? "manual_activity_count" : "imported_activity_count"] += 1;
  if (duration == null) stats.missing_duration_count += 1; else stats.timer_time_seconds += duration;
  if (!applicable) stats.tss_not_applicable_count += 1;
  else if (tss == null) stats.missing_tss_count += 1;
  else {
    stats.known_tss_count += 1;
    stats.tss += tss;
    stats[manual ? "manual_estimated_tss" : "recorded_derived_tss"] += tss;
  }
}

export function buildPublicAnalytics(rows, ftpRows, range, now, limits = PUBLIC_ANALYTICS_LIMITS) {
  if (rows.length > limits.rows || ftpRows.length > limits.ftpRows) budget();
  const from = dateValue(range.from), to = dateValue(range.to);
  const today = Math.floor(now / DAY) * DAY;
  const ftpSeries = ftpRows.map(row => ({ period: Number(row.period), ftp: nonnegative(row.ftp) }))
    .filter(row => Number.isInteger(row.period) && row.period >= 1000 && row.period <= 9999 && row.ftp > 0)
    .map(row => ({ ...row, time: Date.parse(String(row.period) + "-01-01T00:00:00Z") }))
    .sort((a, b) => a.time - b.time);
  const days = new Map();
  const totals = statistics();
  let firstLoad = null;
  let historyMissing = 0;
  for (const row of rows) {
    if (row.start_time == null) continue;
    const time = new Date(row.start_time).getTime();
    if (!Number.isFinite(time) || time >= to || time > now || row.workout_type === "motorsport") continue;
    const day = Math.floor(time / DAY) * DAY;
    const manual = row.entity_type === "manual_activity";
    const applicable = manual ? row.activity_type === "cycling" : ["road", "mountain", "indoor"].includes(row.workout_type);
    const duration = nonnegative(row.total_timer_time);
    let tss = null;
    if (applicable) {
      if (manual && (row.tss_source === "manual" || row.tss_source == null)) tss = nonnegative(row.estimated_tss);
      if (tss == null) {
        const ftp = analyticsFtpAt(ftpSeries, time);
        const power = nonnegative(row.avg_normalized_power);
        if (ftp > 0 && power != null && duration != null) {
          tss = Math.round(duration / 3600 * (power / ftp) ** 2 * 100);
          if (!Number.isFinite(tss)) budget();
        }
      }
      if (tss != null) firstLoad = firstLoad == null ? day : Math.min(firstLoad, day);
      else historyMissing += 1;
    }
    const stats = days.get(day) || statistics();
    addActivity(stats, row, duration, tss, applicable);
    days.set(day, stats);
    if (day >= from) addActivity(totals, row, duration, tss, applicable);
  }
  for (const stats of days.values()) {
    if (!Number.isFinite(stats.tss) || !Number.isFinite(stats.timer_time_seconds)) budget();
  }
  const loadStart = firstLoad == null ? from : Math.min(from, firstLoad);
  if ((to - loadStart) / DAY > limits.historyDays) budget();
  // Reuse the application's 42/7-day recurrence, including daily rounding.
  // Missing TSS contributes zero, with coverage explicitly reported to callers.
  const history = [];
  for (let day = loadStart; day < to; day += DAY) history.push({ day: new Date(day).toISOString().slice(0, 10), tss: days.get(day)?.tss || 0 });
  const load = FileDBService.computeCTLATL(history);
  const data = load.filter(point => dateValue(point.date) >= from).map(point => {
    const day = dateValue(point.date);
    const known = firstLoad != null && day >= firstLoad;
    return { date: point.date, ...finishStatistics(days.get(day) || statistics()),
      ctl: known ? point.ctl : null, atl: known ? point.atl : null, tsb: known ? point.tsb : null,
      current_day_partial: day === today };
  });
  const last = data.at(-1);
  const ftp = analyticsFtpAt(ftpSeries, Math.min(now, to - 1));
  const meta = { ...range, time_zone: "UTC", generated_at: new Date(now).toISOString(),
    current_day_partial: to > today, history_from: firstLoad == null ? null : new Date(firstLoad).toISOString().slice(0, 10),
    history_missing_tss_count: historyMissing, ctl_time_constant_days: 42, atl_time_constant_days: 7,
    load_method: "daily_rounded_ema", ftp_method: "yearly_utc_interpolation" };
  const summary = { ...finishStatistics(totals), latest_load: { date: last.date, ctl: last.ctl, atl: last.atl, tsb: last.tsb },
    ftp_watts: ftp == null ? null : rounded(ftp) };
  const result = { meta, summary, days: data };
  if (Buffer.byteLength(JSON.stringify(result)) > limits.responseBytes) budget();
  return result;
}

let activeRequests = 0;

export default class PublicAnalyticsApiService {
  constructor({ database = analyticsDatabase, now = Date.now } = {}) { this.database = database; this.now = now; }

  async analytics(owner, params, kind) {
    const userId = publicWorkoutId(String(owner));
    const now = this.now();
    const range = parsePublicAnalyticsQuery(params, now);
    if (activeRequests >= PUBLIC_ANALYTICS_LIMITS.concurrent) apiFailure(429, "rate_limited", "Analytics capacity exceeded.");
    activeRequests += 1;
    let client;
    try {
      client = await this.database.connect();
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query("SET LOCAL statement_timeout = '5000ms'");
      const { rows } = await client.query([
        "SELECT entity_type, start_time, total_timer_time, avg_normalized_power, workout_type, activity_type, estimated_tss, tss_source FROM (",
        "SELECT 'workout'::text AS entity_type, start_time, total_timer_time, avg_normalized_power, workout_type,",
        "NULL::text AS activity_type, NULL::double precision AS estimated_tss, NULL::text AS tss_source",
        "FROM workouts WHERE uid = $1 AND start_time < $2::timestamptz AND start_time <= $3::timestamptz",
        "AND workout_type IS DISTINCT FROM 'motorsport' UNION ALL",
        "SELECT 'manual_activity'::text AS entity_type, start_time, duration_seconds AS total_timer_time,",
        "avg_normalized_power, workout_type, activity_type, estimated_tss, tss_source",
        "FROM training_activities WHERE uid = $1 AND start_time < $2::timestamptz AND start_time <= $3::timestamptz",
        ") owned ORDER BY start_time LIMIT $4"
      ].join(" "), [userId, range.to + "T00:00:00Z", new Date(now).toISOString(), PUBLIC_ANALYTICS_LIMITS.rows + 1]);
      if (rows.length > PUBLIC_ANALYTICS_LIMITS.rows) budget();
      const ftp = await client.query("SELECT period, ftp FROM get_ftp_by_period2($1, $2) WHERE period <= $3 ORDER BY period LIMIT $4",
        [userId, "year", new Date(dateValue(range.to) - 1).getUTCFullYear(), PUBLIC_ANALYTICS_LIMITS.ftpRows + 1]);
      if (ftp.rows.length > PUBLIC_ANALYTICS_LIMITS.ftpRows) budget();
      await client.query("COMMIT");
      client.release();
      client = null;
      const result = buildPublicAnalytics(rows, ftp.rows, range, now);
      return { meta: result.meta, data: kind === "summary" ? result.summary : result.days };
    } catch (error) {
      if (client) await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally { client?.release(); activeRequests -= 1; }
  }

  summary(owner, params) { return this.analytics(owner, params, "summary"); }
  trainingLoad(owner, params) { return this.analytics(owner, params, "training-load"); }

  async performance(owner, params, kind) {
    const userId = publicWorkoutId(String(owner)), now = this.now();
    const options = parsePerformanceOptions(params, kind);
    const range = parsePublicAnalyticsQuery(options.dates, now);
    if (activeRequests >= PUBLIC_ANALYTICS_LIMITS.concurrent) apiFailure(429, "rate_limited", "Analytics capacity exceeded.");
    activeRequests += 1;
    let client;
    try {
      client = await this.database.connect();
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query("SET LOCAL statement_timeout = '5000ms'");
      await client.query("SET LOCAL work_mem = '8MB'");
      const result = await client.query([
        "SELECT w.id::text AS workout_id, s.id::text AS segment_id, w.start_time,",
        "to_char(w.start_time AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS sort_start,",
        "s.duration, s.avg_power, s.start_offset, s.end_offset",
        "FROM workouts w JOIN workout_segments s ON s.wid = w.id AND s.uid = $1",
        "WHERE w.uid = $1 AND w.workout_type IN ('road', 'mountain', 'indoor') AND s.segmenttype = 'crit'",
        "AND w.start_time >= $2::timestamptz AND w.start_time < $3::timestamptz AND w.start_time <= $4::timestamptz",
        "AND s.duration = ANY($5::int[]) ORDER BY w.start_time, w.id, s.id LIMIT $6"
      ].join(" "), [userId, range.from + "T00:00:00Z", range.to + "T00:00:00Z", new Date(now).toISOString(),
        kind === "power-profile" ? options.durations : [480, 900], PUBLIC_ANALYTICS_LIMITS.rows + 1]);
      if (result.rows.length > PUBLIC_ANALYTICS_LIMITS.rows) budget();
      const winners = kind === "power-profile" ? selectPublicPowerEfforts(result.rows, range, options.durations, now) : null;
      let weights = [];
      if (winners?.size) {
        const dates = [...new Set([...winners.values()].map(row => new Date(row.start_time).toISOString().slice(0, 10)))];
        const weightResult = await client.query([
          "SELECT d.date::text, COALESCE(h.weight_kg, p.weight_kg) AS weight_kg,",
          "CASE WHEN h.weight_kg IS NOT NULL THEN 'history' WHEN p.weight_kg IS NOT NULL THEN 'profile' ELSE NULL END AS source",
          "FROM unnest($2::date[]) AS d(date) LEFT JOIN user_profiles p ON p.user_id = $1",
          "LEFT JOIN LATERAL (SELECT weight_kg FROM user_weight_history WHERE user_id = $1 AND valid_from <= d.date",
          "ORDER BY valid_from DESC LIMIT 1) h ON TRUE"
        ].join(" "), [userId, dates]);
        weights = weightResult.rows;
      }
      await client.query("COMMIT");
      client.release(); client = null;
      const response = kind === "power-profile" ? buildPublicPowerProfile(winners, weights, range, options.durations, now)
        : buildPublicFtpHistory(result.rows, range, options.grouping, now);
      if (Buffer.byteLength(JSON.stringify(response)) > PUBLIC_ANALYTICS_LIMITS.responseBytes) budget();
      return response;
    } catch (error) {
      if (client) await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally { client?.release(); activeRequests -= 1; }
  }

  powerProfile(owner, params) { return this.performance(owner, params, "power-profile"); }
  ftpHistory(owner, params) { return this.performance(owner, params, "ftp-history"); }
}
