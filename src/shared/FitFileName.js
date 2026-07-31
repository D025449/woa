function normalizeTimeZone(value, fallback = "UTC") {
  const candidate = String(value || "").trim();
  if (!candidate || candidate.length > 100) {
    return fallback;
  }

  try {
    new Intl.DateTimeFormat("en", { timeZone: candidate }).format(0);
    return candidate;
  } catch {
    return fallback;
  }
}

export function getBrowserTimeZone() {
  try {
    return normalizeTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return "UTC";
  }
}

export function formatFitExportFileName(
  startTimeValue,
  {
    timeZone = "UTC",
    fallbackName = "workout.fit",
    suffix = ""
  } = {}
) {
  const date = new Date(startTimeValue);
  if (Number.isNaN(date.getTime())) {
    return fallbackName;
  }

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: normalizeTimeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const timestamp = [
    values.year,
    values.month,
    values.day,
    values.hour,
    values.minute,
    values.second
  ].join("-");

  return `${timestamp}${suffix}.fit`;
}
