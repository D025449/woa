import { resolveAnalysisPeriod } from "./analytics-period.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function finiteTime(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

export function toDateInputValue(value) {
  const time = finiteTime(value);
  return time === null ? "" : new Date(time).toISOString().slice(0, 10);
}

export function resolveRelativeAnalyticsRange(domain, countValue, unit) {
  const count = Number(countValue);
  if (!domain || !Number.isInteger(count) || count < 1 || count > 365) return null;
  if (!["day", "week", "month", "quarter", "year"].includes(unit)) return null;
  const end = new Date(domain.end);
  if (!Number.isFinite(end.getTime())) return null;
  const start = new Date(end);
  if (unit === "day") start.setUTCDate(start.getUTCDate() - count);
  if (unit === "week") start.setUTCDate(start.getUTCDate() - (count * 7));
  if (unit === "month") start.setUTCMonth(start.getUTCMonth() - count);
  if (unit === "quarter") start.setUTCMonth(start.getUTCMonth() - (count * 3));
  if (unit === "year") start.setUTCFullYear(start.getUTCFullYear() - count);
  return {
    start: Math.max(Number(domain.start), start.getTime()),
    end: Number(domain.end)
  };
}

export function selectRelativePeriodTimestamp(timestamps, range, offsetValue) {
  const offset = Number(offsetValue);
  if (!Number.isInteger(offset) || offset < 0) return null;
  const start = finiteTime(range?.start);
  const end = finiteTime(range?.end);
  if (start === null || end === null) return null;
  const visible = [...new Set((timestamps || [])
    .map(finiteTime)
    .filter((timestamp) => timestamp !== null && timestamp >= start && timestamp <= end))]
    .sort((a, b) => a - b);
  return visible.at(-(offset + 1)) ?? null;
}

export function selectStablePeriodTimestamp(timestamps, value, currentValue = null) {
  const pointer = finiteTime(value);
  if (pointer === null) return null;
  const periods = Array.isArray(timestamps) ? timestamps : [];
  if (!periods.length) return pointer;

  let low = 0;
  let high = periods.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (periods[middle] < pointer) low = middle + 1;
    else high = middle;
  }
  const rightIndex = low;
  const leftIndex = Math.max(0, rightIndex - 1);
  const candidateIndex = Math.abs(periods[leftIndex] - pointer)
    <= Math.abs(periods[rightIndex] - pointer)
    ? leftIndex
    : rightIndex;

  const current = finiteTime(currentValue);
  const currentIndex = current === null ? -1 : periods.indexOf(current);
  if (currentIndex < 0 || currentIndex === candidateIndex) return periods[candidateIndex];
  if (Math.abs(candidateIndex - currentIndex) > 1) return periods[candidateIndex];

  const candidate = periods[candidateIndex];
  const boundary = (current + candidate) / 2;
  const hysteresis = Math.abs(candidate - current) * 0.05;
  if (candidate > current) {
    return pointer >= boundary + hysteresis ? candidate : current;
  }
  return pointer <= boundary - hysteresis ? candidate : current;
}

export function findSeriesTimeBounds(series) {
  let start = Infinity;
  let end = -Infinity;

  for (const item of series || []) {
    for (const point of item?.data || []) {
      const time = finiteTime(point?.value?.[0]);
      if (time === null) continue;
      start = Math.min(start, time);
      end = Math.max(end, time);
    }
  }

  return Number.isFinite(start) && Number.isFinite(end) ? { start, end } : null;
}

export function resolveAnalyticsTimeRange(preference, bounds) {
  if (!bounds || !Number.isFinite(bounds.start) || !Number.isFinite(bounds.end)) {
    return null;
  }

  const mode = preference?.mode || "all";
  if (mode === "custom") {
    const start = finiteTime(preference.start);
    const end = finiteTime(preference.end);
    if (start !== null && end !== null && start <= end) {
      return { start, end };
    }
  }

  return { ...bounds };
}

export function snapAnalyticsRangeToGrouping(range, grouping) {
  const start = finiteTime(range?.start);
  const end = finiteTime(range?.end);
  if (start === null || end === null || start > end) return null;
  if (!["week", "month", "quarter", "year"].includes(grouping)) {
    return { start, end };
  }

  const startPeriod = resolveAnalysisPeriod(start, grouping);
  const endPeriod = resolveAnalysisPeriod(end, grouping);
  if (!startPeriod || !endPeriod) return null;
  return {
    start: startPeriod.startMs,
    end: endPeriod.endMs - DAY_MS
  };
}

export function readZoomEventTimeRange(event, bounds) {
  if (!bounds) return null;

  const payload = event?.batch?.[0] || event || {};
  const startValue = finiteTime(payload.startValue);
  const endValue = finiteTime(payload.endValue);
  if (startValue !== null && endValue !== null) {
    return { start: startValue, end: endValue };
  }

  const startPercent = Number(payload.start);
  const endPercent = Number(payload.end);
  if (!Number.isFinite(startPercent) || !Number.isFinite(endPercent)) {
    return null;
  }

  const span = Math.max(DAY_MS, bounds.end - bounds.start);
  return {
    start: bounds.start + span * startPercent / 100,
    end: bounds.start + span * endPercent / 100
  };
}
