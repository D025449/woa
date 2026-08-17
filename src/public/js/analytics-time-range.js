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
