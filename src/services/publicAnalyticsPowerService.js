import { apiFailure } from "./publicWorkoutApiService.js";
import { powerWeightFields } from "../shared/PowerWeight.js";

export const PUBLIC_POWER_DURATIONS = Object.freeze([5, 15, 60, 120, 240, 300, 360, 480, 720, 900, 960, 1200, 1800]);
const DAY = 86400000;

export function parsePerformanceOptions(params, kind) {
  const extra = kind === "power-profile" ? "durations" : "grouping";
  const dates = new URLSearchParams();
  for (const [key, value] of params) {
    if (!["from", "to", extra].includes(key) || params.getAll(key).length !== 1) {
      apiFailure(400, "invalid_request", "Unknown or repeated query parameter.");
    }
    if (key !== extra) dates.set(key, value);
  }
  const grouping = params.get("grouping") ?? "month";
  const value = params.get("durations");
  const durations = value == null ? [...PUBLIC_POWER_DURATIONS] : value.split(",").map(part => /^[1-9][0-9]*$/.test(part) ? Number(part) : NaN);
  if (kind === "power-profile" && (!durations.length || durations.length > PUBLIC_POWER_DURATIONS.length
    || durations.some(duration => !PUBLIC_POWER_DURATIONS.includes(duration)) || new Set(durations).size !== durations.length)) {
    apiFailure(400, "invalid_request", "Select distinct supported power durations.");
  }
  if (kind === "ftp-history" && !["week", "month", "quarter", "year"].includes(grouping)) {
    apiFailure(400, "invalid_request", "Invalid FTP grouping.");
  }
  return { dates, grouping, durations: durations.sort((a, b) => a - b) };
}

function finite(value) {
  return ["number", "string"].includes(typeof value) && String(value).trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : null;
}

function scalar(value) {
  const number = finite(value);
  if (number == null || number < 0) return null;
  const rounded = Math.round(number * 1000) / 1000;
  if (!Number.isFinite(rounded)) apiFailure(422, "analytics_response_too_large", "Invalid analytics magnitude.");
  return rounded;
}

function safeId(value) {
  return typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
}

export function selectPublicPowerEfforts(rows, range, durations, now) {
  const from = Date.parse(range.from + "T00:00:00Z"), to = Date.parse(range.to + "T00:00:00Z");
  const winners = new Map();
  for (const row of rows) {
    const time = row.start_time == null ? NaN : new Date(row.start_time).getTime();
    const power = finite(row.avg_power), duration = Number(row.duration);
    const start = finite(row.start_offset), end = finite(row.end_offset);
    if (!Number.isFinite(time) || time < from || time >= to || time > now || power == null || power < 0
      || !durations.includes(duration) || !safeId(row.workout_id) || !safeId(row.segment_id)
      || !Number.isInteger(start) || start < 0 || !Number.isInteger(end) || end <= start) continue;
    const current = winners.get(duration);
    const timeKey = row.sort_start ?? new Date(time).toISOString();
    const currentKey = current ? current.sort_start ?? new Date(current.start_time).toISOString() : null;
    // Equal power prefers the newer microsecond timestamp, then exact BIGINT
    // workout and segment IDs without losing precision in Number().
    const better = !current || power > Number(current.avg_power) || (power === Number(current.avg_power)
      && (timeKey > currentKey || (timeKey === currentKey
        && (BigInt(row.workout_id) > BigInt(current.workout_id) || (row.workout_id === current.workout_id
          && BigInt(row.segment_id) > BigInt(current.segment_id))))));
    if (better) winners.set(duration, row);
  }
  return winners;
}

export function buildPublicPowerProfile(winners, weightRows, range, durations, now) {
  const weights = new Map(weightRows.map(row => [row.date, row]));
  const data = durations.map(duration => {
    const row = winners.get(duration);
    const startTime = row ? new Date(row.start_time).toISOString() : null;
    const date = startTime?.slice(0, 10) ?? null;
    const power = row ? scalar(row.avg_power) : null;
    const weight = weights.get(date);
    const fields = powerWeightFields(power, weight?.weight_kg,
      ["history", "profile"].includes(weight?.source) ? weight.source : null, date);
    return { duration_seconds: duration, power_watts: power, watts_per_kg: scalar(fields.wattsPerKg),
      weight_kg: fields.weightKg, weight_source: fields.weightSource, weight_date: fields.weightDate,
      workout_id: row?.workout_id ?? null, workout_start_time: startTime,
      start_offset_seconds: row ? Number(row.start_offset) : null, end_offset_seconds: row ? Number(row.end_offset) : null };
  });
  return { meta: { ...range, time_zone: "UTC", generated_at: new Date(now).toISOString(),
    durations_seconds: durations, power_method: "stored_critical_efforts", current_day_partial: range.to > new Date(now).toISOString().slice(0, 10) }, data };
}

export function ftpPeriod(time, grouping) {
  const date = new Date(time);
  const year = date.getUTCFullYear(), month = date.getUTCMonth();
  let start, end;
  const anchor = (y, m) => { const value = new Date(0); value.setUTCFullYear(y, m, 1); return value.getTime(); };
  if (grouping === "year") { start = anchor(year, 0); end = anchor(year + 1, 0); }
  else if (grouping === "quarter") { start = anchor(year, Math.floor(month / 3) * 3); end = anchor(year, Math.floor(month / 3) * 3 + 3); }
  else if (grouping === "week") { start = Math.floor(time / DAY) * DAY - ((date.getUTCDay() + 6) % 7) * DAY; end = start + 7 * DAY; }
  else { start = anchor(year, month); end = anchor(year, month + 1); }
  return { start, end };
}

function percentile95(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * 0.95, left = Math.floor(position);
  return sorted[left] + (position - left) * ((sorted[left + 1] ?? sorted[left]) - sorted[left]);
}

export function buildPublicFtpHistory(rows, range, grouping, now) {
  const from = Date.parse(range.from + "T00:00:00Z"), to = Date.parse(range.to + "T00:00:00Z");
  const buckets = new Map();
  for (const row of rows) {
    const time = row.start_time == null ? NaN : new Date(row.start_time).getTime();
    const power = finite(row.avg_power), duration = Number(row.duration);
    if (!Number.isFinite(time) || time < from || time >= to || time > now || !(power > 0) || ![480, 900].includes(duration)) continue;
    const period = ftpPeriod(time, grouping);
    const bucket = buckets.get(period.start) || { cp8: [], cp15: [] };
    bucket[duration === 480 ? "cp8" : "cp15"].push(power);
    buckets.set(period.start, bucket);
  }
  const data = [];
  let period = ftpPeriod(from, grouping);
  while (period.start < to) {
    const bucket = buckets.get(period.start) || { cp8: [], cp15: [] };
    const cp8 = percentile95(bucket.cp8), cp15 = percentile95(bucket.cp15);
    const estimate = cp8 == null || cp15 == null ? null
      : (cp8 + (Math.log(1200) - Math.log(480)) / (Math.log(900) - Math.log(480)) * (cp15 - cp8)) * 0.95;
    data.push({ period_from: new Date(period.start).toISOString().slice(0, 10), period_to: new Date(period.end).toISOString().slice(0, 10),
      partial_period: period.start < from || period.end > to || period.end > now,
      cp8_watts: scalar(cp8), cp15_watts: scalar(cp15), ftp_watts: estimate > 0 ? scalar(estimate) : null,
      cp8_effort_count: bucket.cp8.length, cp15_effort_count: bucket.cp15.length,
      confidence: Math.min(bucket.cp8.length, bucket.cp15.length) });
    period = ftpPeriod(period.end, grouping);
  }
  return { meta: { ...range, time_zone: "UTC", generated_at: new Date(now).toISOString(), grouping,
    ftp_method: "period_cp8_cp15_p95", current_day_partial: to > Math.floor(now / DAY) * DAY }, data };
}
