const DAY_MS = 24 * 60 * 60 * 1000;

function utcDate(value) {
  const timestamp = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

export function getISOWeekStartDate(year, week) {
  const normalizedYear = Number(year);
  const normalizedWeek = Number(week);
  if (!Number.isInteger(normalizedYear) || !Number.isInteger(normalizedWeek)) return null;
  if (normalizedWeek < 1 || normalizedWeek > 53) return null;

  const januaryFourth = new Date(Date.UTC(normalizedYear, 0, 4));
  const januaryFourthWeekday = januaryFourth.getUTCDay() || 7;
  const monday = new Date(januaryFourth);
  monday.setUTCDate(
    januaryFourth.getUTCDate() - januaryFourthWeekday + 1 + (normalizedWeek - 1) * 7
  );
  return monday.toISOString().slice(0, 10);
}

export function resolveAnalysisPeriod(value, grouping) {
  const date = utcDate(value);
  if (!date) return null;

  const start = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate()
  ));
  const end = new Date(start);

  if (grouping === "week") {
    const weekday = start.getUTCDay() || 7;
    start.setUTCDate(start.getUTCDate() - weekday + 1);
    end.setTime(start.getTime() + 7 * DAY_MS);
  } else if (grouping === "quarter") {
    start.setUTCMonth(Math.floor(start.getUTCMonth() / 3) * 3, 1);
    end.setTime(start.getTime());
    end.setUTCMonth(end.getUTCMonth() + 3);
  } else if (grouping === "year") {
    start.setUTCMonth(0, 1);
    end.setTime(start.getTime());
    end.setUTCFullYear(end.getUTCFullYear() + 1);
  } else {
    start.setUTCDate(1);
    end.setTime(start.getTime());
    end.setUTCMonth(end.getUTCMonth() + 1);
  }

  return {
    start: start.toISOString(),
    end: end.toISOString(),
    startMs: start.getTime(),
    endMs: end.getTime()
  };
}

export function resolveCalendarAnalysisPeriod(value, grouping, offsetValue = 0) {
  const offset = Number(offsetValue);
  const current = resolveAnalysisPeriod(value, grouping);
  if (!current || !Number.isInteger(offset) || offset < 0 || offset > 12) return null;
  const target = new Date(current.startMs);
  if (grouping === "week") target.setUTCDate(target.getUTCDate() - (offset * 7));
  if (grouping === "month") target.setUTCMonth(target.getUTCMonth() - offset);
  if (grouping === "quarter") target.setUTCMonth(target.getUTCMonth() - (offset * 3));
  if (grouping === "year") target.setUTCFullYear(target.getUTCFullYear() - offset);
  return resolveAnalysisPeriod(target.getTime(), grouping);
}

export function resolvePreviousAnalysisPeriod(value, grouping, offsetValue = 1) {
  return resolveCalendarAnalysisPeriod(value, grouping, offsetValue);
}

export function formatAnalysisPeriod(period, grouping, locale = "en") {
  if (!period) return "";
  const start = new Date(period.startMs);
  const endInclusive = new Date(period.endMs - DAY_MS);
  if (grouping === "quarter") {
    return `Q${Math.floor(start.getUTCMonth() / 3) + 1} ${start.getUTCFullYear()}`;
  }
  const formatter = new Intl.DateTimeFormat(locale, {
    day: grouping === "week" ? "2-digit" : undefined,
    month: grouping === "year" ? undefined : "short",
    year: "numeric",
    timeZone: "UTC"
  });

  if (grouping === "week") {
    return `${formatter.format(start)} - ${formatter.format(endInclusive)}`;
  }
  return formatter.format(start);
}

export function formatAnalysisPeriodValue(value, grouping, locale = "en") {
  const normalizedGrouping = {
    year_week: "week",
    year_month: "month",
    year_quarter: "quarter"
  }[grouping] || grouping;
  const period = resolveAnalysisPeriod(value, normalizedGrouping);
  return formatAnalysisPeriod(period, normalizedGrouping, locale);
}

export function mapSharedGrouping(grouping) {
  const normalized = ["week", "month", "quarter", "year"].includes(grouping)
    ? grouping
    : "month";
  return {
    shared: normalized,
    loadModel: normalized,
    powerCurve: normalized === "week" || normalized === "month"
      ? `year_${normalized}`
      : normalized === "quarter" ? "year_quarter" : "year"
  };
}
