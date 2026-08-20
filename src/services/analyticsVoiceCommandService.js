const GROUPINGS = new Set(["week", "month", "quarter", "year"]);
const RANGE_UNITS = new Set(["day", "week", "month", "quarter", "year"]);
const SPOKEN_NUMBERS = new Map([
  ["ein", 1], ["eine", 1], ["einen", 1], ["einem", 1], ["einer", 1], ["eins", 1],
  ["zwei", 2], ["drei", 3], ["vier", 4], ["fünf", 5], ["sechs", 6], ["sieben", 7],
  ["acht", 8], ["neun", 9], ["zehn", 10], ["elf", 11], ["zwölf", 12],
  ["dreizehn", 13], ["vierzehn", 14], ["fünfzehn", 15], ["sechzehn", 16],
  ["siebzehn", 17], ["achtzehn", 18], ["neunzehn", 19], ["zwanzig", 20],
  ["one", 1], ["two", 2], ["three", 3], ["four", 4], ["five", 5], ["six", 6],
  ["seven", 7], ["eight", 8], ["nine", 9], ["ten", 10], ["eleven", 11], ["twelve", 12]
]);
const RANGE_UNIT_ALIASES = new Map([
  ["tag", "day"], ["tage", "day"], ["tagen", "day"], ["day", "day"], ["days", "day"],
  ["woche", "week"], ["wochen", "week"], ["week", "week"], ["weeks", "week"],
  ["monat", "month"], ["monate", "month"], ["monaten", "month"], ["month", "month"], ["months", "month"],
  ["quartal", "quarter"], ["quartale", "quarter"], ["quartalen", "quarter"], ["quarter", "quarter"], ["quarters", "quarter"],
  ["jahr", "year"], ["jahre", "year"], ["jahren", "year"], ["year", "year"], ["years", "year"]
]);
const MONTH_ALIASES = new Map([
  ["januar", 1], ["january", 1], ["februar", 2], ["february", 2],
  ["märz", 3], ["maerz", 3], ["march", 3], ["april", 4],
  ["mai", 5], ["may", 5], ["juni", 6], ["june", 6],
  ["juli", 7], ["july", 7], ["august", 8], ["september", 9],
  ["oktober", 10], ["october", 10], ["november", 11], ["dezember", 12], ["december", 12]
]);
const SERIES = new Set([
  "atl",
  "ctl",
  "tsb",
  "tss",
  "cp5",
  "cp15",
  "cp60",
  "cp120",
  "cp240",
  "cp360",
  "cp480",
  "cp720",
  "cp900",
  "cp960",
  "cp1800",
  "eftp"
]);

function fail(message, statusCode = 500) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

function extractResponseText(responseJson = {}) {
  if (typeof responseJson.output_text === "string" && responseJson.output_text.trim()) {
    return responseJson.output_text.trim();
  }
  return (responseJson.output || [])
    .flatMap((item) => item.content || [])
    .filter((content) => content.type === "output_text" && content.text)
    .map((content) => content.text)
    .join("\n")
    .trim();
}

export function normalizeAnalyticsVoiceActions(source) {
  if (!Array.isArray(source)) return [];
  const actions = [];
  for (const candidate of source.slice(0, 12)) {
    if (!candidate || typeof candidate !== "object") continue;
    if (candidate.type === "set_grouping" && GROUPINGS.has(candidate.grouping)) {
      actions.push({ type: "set_grouping", grouping: candidate.grouping });
      continue;
    }
    if (candidate.type === "set_relative_range") {
      const count = Number(candidate.count);
      if (Number.isInteger(count) && count >= 1 && count <= 365 && RANGE_UNITS.has(candidate.unit)) {
        actions.push({ type: "set_relative_range", count, unit: candidate.unit });
      }
      continue;
    }
    if (candidate.type === "open_relative_period") {
      const periodOffset = Number(candidate.periodOffset);
      if (Number.isInteger(periodOffset) && periodOffset >= 0 && periodOffset <= 11) {
        actions.push({ type: "open_relative_period", periodOffset });
      }
      continue;
    }
    if (candidate.type === "open_period") {
      const periodDate = String(candidate.periodDate || "");
      if (GROUPINGS.has(candidate.periodGrouping) && isValidIsoDate(periodDate)) {
        actions.push({
          type: "open_period",
          periodDate,
          periodGrouping: candidate.periodGrouping
        });
      }
      continue;
    }
    if (candidate.type === "open_calendar_period") {
      const periodOffset = Number(candidate.periodOffset);
      if (
        GROUPINGS.has(candidate.periodGrouping)
        && Number.isInteger(periodOffset)
        && periodOffset >= 0
        && periodOffset <= 12
      ) {
        actions.push({
          type: "open_calendar_period",
          periodGrouping: candidate.periodGrouping,
          periodOffset
        });
      }
      continue;
    }
    if (
      candidate.type === "set_series_visibility"
      && SERIES.has(candidate.series)
      && typeof candidate.visible === "boolean"
    ) {
      actions.push({
        type: "set_series_visibility",
        series: candidate.series,
        visible: candidate.visible
      });
    }
  }
  return actions;
}

function parseSpokenCount(value) {
  if (/^\d{1,3}$/u.test(value)) return Number(value);
  return SPOKEN_NUMBERS.get(value) ?? null;
}

function toIsoDate(yearValue, monthValue, dayValue = 1) {
  const year = Number(yearValue);
  const month = Number(monthValue);
  const day = Number(dayValue);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    !Number.isInteger(year) || year < 1900 || year > 2200
    || date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) return null;
  return date.toISOString().slice(0, 10);
}

function isValidIsoDate(value) {
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  return Boolean(match && toIsoDate(Number(match[1]), Number(match[2]), Number(match[3])) === value);
}

function inferExplicitAbsolutePeriod(rawText, text) {
  if (!/(?:detail|klick|öffne|zeige|show|open|select|click)/u.test(text)) return null;

  const numericDate = rawText.match(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{4})\b/u);
  if (numericDate) {
    const periodDate = toIsoDate(numericDate[3], numericDate[2], numericDate[1]);
    return periodDate ? { type: "open_period", periodDate, periodGrouping: "week" } : null;
  }

  const monthNames = [...MONTH_ALIASES.keys()].sort((a, b) => b.length - a.length).join("|");
  const namedDate = text.match(new RegExp(`\\b(\\d{1,2})\\s+(${monthNames})\\s+(\\d{4})\\b`, "u"));
  if (namedDate) {
    const periodDate = toIsoDate(namedDate[3], MONTH_ALIASES.get(namedDate[2]), namedDate[1]);
    return periodDate ? { type: "open_period", periodDate, periodGrouping: "week" } : null;
  }

  const quarter = text.match(/\b(?:q\s*([1-4])|([1-4])\.?\s*quartal)\s+(\d{4})\b/u);
  if (quarter) {
    const periodDate = toIsoDate(quarter[3], ((Number(quarter[1] || quarter[2]) - 1) * 3) + 1);
    return { type: "open_period", periodDate, periodGrouping: "quarter" };
  }

  const month = text.match(new RegExp(`\\b(${monthNames})\\s+(\\d{4})\\b`, "u"));
  if (month) {
    const periodDate = toIsoDate(month[2], MONTH_ALIASES.get(month[1]));
    return { type: "open_period", periodDate, periodGrouping: "month" };
  }

  const year = text.match(/\b(?:jahr\s+)?(19\d{2}|20\d{2}|21\d{2}|2200)\b/u);
  if (year) {
    return { type: "open_period", periodDate: `${year[1]}-01-01`, periodGrouping: "year" };
  }
  return null;
}

export function inferExplicitAnalyticsVoiceActions(transcript) {
  const rawText = String(transcript || "")
    .toLocaleLowerCase("de")
    .trim();
  const text = rawText
    .replace(/[.,;:!?]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!text) return [];

  const actions = [];
  const absolutePeriod = inferExplicitAbsolutePeriod(rawText, text);
  if (absolutePeriod) actions.push(absolutePeriod);
  const currentCalendarPeriod = text.match(
    /\baktuell(?:e|en|er|es|em)?\s+(woche|monat|quartal|jahr)\b|\b(?:diese|dieser|dieses)\s+(woche|monat|quartal|jahr)\b|\b(?:current|this)\s+(week|month|quarter|year)\b/u
  );
  if (currentCalendarPeriod) {
    const unit = currentCalendarPeriod[1] || currentCalendarPeriod[2] || currentCalendarPeriod[3];
    actions.push({
      type: "open_calendar_period",
      periodGrouping: RANGE_UNIT_ALIASES.get(unit),
      periodOffset: 0
    });
  }
  const calendarPeriod = text.match(
    /\b(vorvorletzt|vorletzt|letzt)(?:e|en|er|es|em)?\s+(woche|monat|quartal|jahr)\b|\b(third[- ]last|second[- ]last|last)\s+(week|month|quarter|year)\b/u
  );
  if (calendarPeriod) {
    const relative = calendarPeriod[1] || calendarPeriod[3];
    const unit = calendarPeriod[2] || calendarPeriod[4];
    const periodOffset = relative.startsWith("vorvor") || relative.startsWith("third")
      ? 3
      : relative.startsWith("vor") || relative.startsWith("second") ? 2 : 1;
    actions.push({
      type: "open_calendar_period",
      periodGrouping: RANGE_UNIT_ALIASES.get(unit),
      periodOffset
    });
  }
  const periodMatch = text.match(
    /(?:details?\s+(?:zu|zur|zum)\s+(?:der\s+)?|klick(?:e)?\s+(?:auf\s+)?(?:die|den|das)?\s*|öffne\s+(?:die|den|das)?\s*)(vorvorletzt|vorletzt|letzt)(?:e|en|er|es|em)?\s+(?:gruppe|zeitraum)|(?:show|open|select|click)\s+(?:the\s+)?(third[- ]last|second[- ]last|last)\s+(?:group|period)/u
  );
  if (periodMatch) {
    const relative = periodMatch[1] || periodMatch[2];
    const periodOffset = relative.startsWith("vorvor") || relative.startsWith("third")
      ? 2
      : relative.startsWith("vor") || relative.startsWith("second") ? 1 : 0;
    actions.push({ type: "open_relative_period", periodOffset });
  }

  const numberWords = [...SPOKEN_NUMBERS.keys()].sort((a, b) => b.length - a.length).join("|");
  const units = [...RANGE_UNIT_ALIASES.keys()].sort((a, b) => b.length - a.length).join("|");
  const rangePattern = new RegExp(
    `(?:letzt(?:e|en|er|es|em)?|vorherig(?:e|en|er|es|em)?|last|previous|past)\\s+(${numberWords}|\\d{1,3})\\s+(${units})(?=\\s|$)`,
    "u"
  );
  const match = text.match(rangePattern);
  if (match) {
    const count = parseSpokenCount(match[1]);
    const unit = RANGE_UNIT_ALIASES.get(match[2]);
    actions.push({ type: "set_relative_range", count, unit });
  }
  return normalizeAnalyticsVoiceActions(actions);
}

function materializeCalendarPeriodAction(action, nowValue) {
  if (action?.type !== "open_calendar_period") return action;
  const date = new Date(nowValue);
  if (!Number.isFinite(date.getTime())) return null;
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  if (action.periodGrouping === "week") {
    const weekday = date.getUTCDay() || 7;
    start.setUTCDate(date.getUTCDate() - weekday + 1);
  }
  if (action.periodGrouping === "quarter") {
    start.setUTCMonth(Math.floor(date.getUTCMonth() / 3) * 3, 1);
  }
  if (action.periodGrouping === "year") start.setUTCMonth(0, 1);
  if (action.periodGrouping === "week") start.setUTCDate(start.getUTCDate() - (action.periodOffset * 7));
  if (action.periodGrouping === "month") start.setUTCMonth(start.getUTCMonth() - action.periodOffset);
  if (action.periodGrouping === "quarter") start.setUTCMonth(start.getUTCMonth() - (action.periodOffset * 3));
  if (action.periodGrouping === "year") start.setUTCFullYear(start.getUTCFullYear() - action.periodOffset);
  return {
    type: "open_period",
    periodDate: start.toISOString().slice(0, 10),
    periodGrouping: action.periodGrouping
  };
}

export function mergeAnalyticsVoiceActions(modelActions, explicitActions, nowValue = Date.now()) {
  const merged = normalizeAnalyticsVoiceActions([...(modelActions || []), ...(explicitActions || [])]);
  const requestedGrouping = merged.filter((action) => action.type === "set_grouping").at(-1);
  const relativeRange = merged.filter((action) => action.type === "set_relative_range").at(-1);
  const drilldown = merged.filter((action) => [
    "open_relative_period",
    "open_period",
    "open_calendar_period"
  ].includes(action.type)).at(-1);
  const resolvedDrilldown = materializeCalendarPeriodAction(drilldown, nowValue);
  const grouping = resolvedDrilldown?.periodGrouping ? null : requestedGrouping;
  const series = new Map();
  merged
    .filter((action) => action.type === "set_series_visibility")
    .forEach((action) => series.set(action.series, action));
  return [
    grouping,
    relativeRange,
    ...series.values(),
    resolvedDrilldown
  ].filter(Boolean);
}

async function readJsonResponse(response, operation) {
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = json?.error?.message || json?.error || `${response.status}`;
    fail(`${operation} failed: ${detail}`, 502);
  }
  return json;
}

export default class AnalyticsVoiceCommandService {
  static async transcribe(audio, locale = "en") {
    if (!process.env.OPENAI_API_KEY) {
      fail("Voice commands are not configured. Missing OPENAI_API_KEY.", 400);
    }
    if (!audio?.buffer?.length) fail("Audio recording is missing.", 400);

    const mimeType = String(audio.mimetype || "audio/webm").split(";")[0];
    const extension = {
      "audio/mp4": "m4a",
      "audio/mpeg": "mp3",
      "audio/ogg": "ogg",
      "audio/wav": "wav"
    }[mimeType] || "webm";
    const form = new FormData();
    form.append("model", process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe");
    form.append("file", new Blob([audio.buffer], { type: mimeType }), `analytics-command.${extension}`);
    const language = String(locale || "").toLowerCase().split(/[-_]/u)[0];
    if (/^[a-z]{2}$/u.test(language)) form.append("language", language);

    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form
    });
    const json = await readJsonResponse(response, "Voice transcription");
    const transcript = String(json.text || "").trim();
    if (!transcript) fail("No speech could be recognized.", 422);
    return transcript;
  }

  static async interpret(transcript, locale = "en") {
    const model = process.env.OPENAI_VOICE_COMMAND_MODEL || "gpt-4o-mini";
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model,
        input: [
          {
            role: "system",
            content: [{
              type: "input_text",
              text: [
                "Convert every independently requested part of a spoken analytics UI command into an allowed action.",
                "Never invent an action. Ignore requests outside the allowed analytics controls.",
                "Grouping supports week, month, quarter, year.",
                "Relative ranges support day, week, month, quarter, year.",
                "Opening a relative visible group uses open_relative_period: last=0, penultimate/second-last=1, antepenultimate/third-last=2.",
                "Opening a named period uses open_period with an ISO date and periodGrouping. A named month selects month, Q1-Q4 selects quarter, a year selects year, and an exact date selects its week.",
                "Opening the current week/month/quarter/year uses open_calendar_period with periodOffset=0 and the matching periodGrouping. Last uses offset=1, second-last=2 and third-last=3. This differs from the last visible group.",
                "Series aliases: ATL or ATL_AVG=atl, CTL=ctl, TSB=tsb, TSS=tss.",
                "Critical-power aliases map seconds or minutes to cp5, cp15, cp60, cp120, cp240, cp360, cp480, cp720, cp900, cp960, cp1800; eFTP=eftp.",
                "German phrases such as einblenden/anzeigen mean visible=true and ausblenden/verbergen mean visible=false.",
                `The UI locale is ${String(locale || "en").slice(0, 16)}.`
              ].join(" ")
            }]
          },
          {
            role: "user",
            content: [{ type: "input_text", text: transcript }]
          }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "analytics_voice_command",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                actions: {
                  type: "array",
                  maxItems: 12,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      type: {
                        type: "string",
                        enum: ["set_grouping", "set_relative_range", "set_series_visibility", "open_relative_period", "open_period", "open_calendar_period"]
                      },
                      grouping: { type: ["string", "null"], enum: ["week", "month", "quarter", "year", null] },
                      count: { type: ["integer", "null"], minimum: 1, maximum: 365 },
                      unit: { type: ["string", "null"], enum: ["day", "week", "month", "quarter", "year", null] },
                      series: { type: ["string", "null"], enum: [...SERIES, null] },
                      visible: { type: ["boolean", "null"] },
                      periodOffset: { type: ["integer", "null"], minimum: 0, maximum: 11 },
                      periodDate: { type: ["string", "null"] },
                      periodGrouping: { type: ["string", "null"], enum: ["week", "month", "quarter", "year", null] }
                    },
                    required: ["type", "grouping", "count", "unit", "series", "visible", "periodOffset", "periodDate", "periodGrouping"]
                  }
                }
              },
              required: ["actions"]
            }
          }
        }
      })
    });
    const json = await readJsonResponse(response, "Voice command interpretation");
    let parsed;
    try {
      parsed = JSON.parse(extractResponseText(json));
    } catch {
      fail("Voice command response could not be parsed.", 502);
    }
    return mergeAnalyticsVoiceActions(
      parsed?.actions,
      inferExplicitAnalyticsVoiceActions(transcript)
    );
  }

  static async process(audio, locale = "en") {
    const transcript = await this.transcribe(audio, locale);
    const actions = await this.interpret(transcript, locale);
    return { transcript, actions };
  }
}
