import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  resolveRelativeAnalyticsRange,
  selectRelativePeriodTimestamp
} from "../src/public/js/analytics-time-range.js";
import {
  inferExplicitAnalyticsVoiceActions,
  mergeAnalyticsVoiceActions,
  normalizeAnalyticsVoiceActions
} from "../src/services/analyticsVoiceCommandService.js";

const projectRoot = new URL("../", import.meta.url);

test("analytics voice actions keep only the strict command whitelist", () => {
  assert.deepEqual(normalizeAnalyticsVoiceActions([
    { type: "set_grouping", grouping: "week" },
    { type: "set_relative_range", count: 10, unit: "week" },
    { type: "set_series_visibility", series: "atl", visible: false },
    { type: "set_series_visibility", series: "database", visible: false },
    { type: "delete_workout", workoutId: 1 },
    { type: "set_relative_range", count: 1000, unit: "week" }
  ]), [
    { type: "set_grouping", grouping: "week" },
    { type: "set_relative_range", count: 10, unit: "week" },
    { type: "set_series_visibility", series: "atl", visible: false }
  ]);
});

test("relative voice ranges use and clamp to the shared analytics domain", () => {
  const end = Date.UTC(2026, 7, 18);
  const domain = { start: Date.UTC(2026, 0, 1), end };
  assert.deepEqual(resolveRelativeAnalyticsRange(domain, 10, "week"), {
    start: Date.UTC(2026, 5, 9),
    end
  });
  assert.equal(resolveRelativeAnalyticsRange(domain, 2, "year").start, domain.start);
  assert.equal(resolveRelativeAnalyticsRange(domain, 0, "week"), null);
});

test("explicit German relative ranges supplement incomplete model actions", () => {
  const explicit = inferExplicitAnalyticsVoiceActions(
    "Grupiere nach Monat und zeige die letzten zwölf Monate an."
  );
  assert.deepEqual(explicit, [
    { type: "set_relative_range", count: 12, unit: "month" }
  ]);
  assert.deepEqual(mergeAnalyticsVoiceActions([
    { type: "set_grouping", grouping: "month" }
  ], explicit), [
    { type: "set_grouping", grouping: "month" },
    { type: "set_relative_range", count: 12, unit: "month" }
  ]);
});

test("explicit relative ranges support digits, inflections and English", () => {
  assert.deepEqual(inferExplicitAnalyticsVoiceActions("Zeige die letzten 10 Wochen"), [
    { type: "set_relative_range", count: 10, unit: "week" }
  ]);
  assert.deepEqual(inferExplicitAnalyticsVoiceActions("Show the last twelve months"), [
    { type: "set_relative_range", count: 12, unit: "month" }
  ]);
});

test("relative period drill-down phrases map to visible group offsets", () => {
  assert.deepEqual(inferExplicitAnalyticsVoiceActions("Zeige mir Details zur letzten Gruppe"), [
    { type: "open_relative_period", periodOffset: 0 }
  ]);
  assert.deepEqual(inferExplicitAnalyticsVoiceActions("Klicke auf die vorletzte Gruppe"), [
    { type: "open_relative_period", periodOffset: 1 }
  ]);
  assert.deepEqual(inferExplicitAnalyticsVoiceActions("Öffne den vorvorletzten Zeitraum"), [
    { type: "open_relative_period", periodOffset: 2 }
  ]);
});

test("named relative calendar periods switch grouping before drill-down", () => {
  const currentQuarter = inferExplicitAnalyticsVoiceActions("Zeig mir Details zum aktuellen Quartal");
  assert.deepEqual(currentQuarter, [
    { type: "open_calendar_period", periodGrouping: "quarter", periodOffset: 0 }
  ]);
  assert.deepEqual(mergeAnalyticsVoiceActions([], currentQuarter, Date.UTC(2026, 7, 18)), [
    { type: "open_period", periodDate: "2026-07-01", periodGrouping: "quarter" }
  ]);
  assert.deepEqual(inferExplicitAnalyticsVoiceActions("Zeige die aktuelle Woche"), [
    { type: "open_calendar_period", periodGrouping: "week", periodOffset: 0 }
  ]);
  const lastWeek = inferExplicitAnalyticsVoiceActions("Zeig mir Details der letzten Woche");
  assert.deepEqual(lastWeek, [
    { type: "open_calendar_period", periodGrouping: "week", periodOffset: 1 }
  ]);
  assert.deepEqual(mergeAnalyticsVoiceActions([], lastWeek, Date.UTC(2026, 7, 18)), [
    { type: "open_period", periodDate: "2026-08-10", periodGrouping: "week" }
  ]);
  assert.deepEqual(inferExplicitAnalyticsVoiceActions("Öffne den vorletzten Monat"), [
    { type: "open_calendar_period", periodGrouping: "month", periodOffset: 2 }
  ]);
});

test("relative period drill-down selects only visible data groups", () => {
  const timestamps = [
    Date.UTC(2025, 11, 1),
    Date.UTC(2026, 0, 1),
    Date.UTC(2026, 2, 1),
    Date.UTC(2026, 3, 1)
  ];
  const range = { start: Date.UTC(2026, 0, 1), end: Date.UTC(2026, 2, 31) };
  assert.equal(selectRelativePeriodTimestamp(timestamps, range, 0), Date.UTC(2026, 2, 1));
  assert.equal(selectRelativePeriodTimestamp(timestamps, range, 1), Date.UTC(2026, 0, 1));
  assert.equal(selectRelativePeriodTimestamp(timestamps, range, 2), null);
});

test("named periods select their natural analytics grouping", () => {
  assert.deepEqual(inferExplicitAnalyticsVoiceActions("Zeige mir Details zu Januar 2026"), [
    { type: "open_period", periodDate: "2026-01-01", periodGrouping: "month" }
  ]);
  assert.deepEqual(inferExplicitAnalyticsVoiceActions("Öffne Q4 2025"), [
    { type: "open_period", periodDate: "2025-10-01", periodGrouping: "quarter" }
  ]);
  assert.deepEqual(inferExplicitAnalyticsVoiceActions("Zeige Details zum Jahr 2024"), [
    { type: "open_period", periodDate: "2024-01-01", periodGrouping: "year" }
  ]);
});

test("an exact spoken date selects the containing week", () => {
  assert.deepEqual(inferExplicitAnalyticsVoiceActions("Zeige Details zum 12. Januar 2026"), [
    { type: "open_period", periodDate: "2026-01-12", periodGrouping: "week" }
  ]);
  assert.deepEqual(inferExplicitAnalyticsVoiceActions("Öffne den Zeitraum 18.08.2026"), [
    { type: "open_period", periodDate: "2026-08-18", periodGrouping: "week" }
  ]);
});

test("voice series changes use chart APIs and update the matching preference branch", () => {
  return readFile(new URL("src/public/js/analytics-controller.js", projectRoot), "utf8").then((controller) => {
    assert.match(controller, /LOAD_MODEL_SERIES\.has\(series\)/u);
    assert.match(controller, /ctlChartView\?\.setSeriesVisibility\(series, visible\)/u);
    assert.match(controller, /cpChartView\?\.setSeriesVisibility\(series, visible\)/u);
    assert.match(controller, /seriesVisibility: \{ \[series\]: visible \}/u);
    assert.match(controller, /await this\.handleAnalysisPointClick\(\{ date: period\.startMs, grouping, data: null \}\)/u);
    assert.doesNotMatch(controller, /hasData = timestamps\.some/u);
  });
});

test("analytics exposes an authenticated bounded voice-command endpoint and push-to-talk UI", async () => {
  const [route, service, markup, controller] = await Promise.all([
    readFile(new URL("src/routes/analyticsRoutes.js", projectRoot), "utf8"),
    readFile(new URL("src/services/analyticsVoiceCommandService.js", projectRoot), "utf8"),
    readFile(new URL("src/views/analytics.ejs", projectRoot), "utf8"),
    readFile(new URL("src/public/js/analytics-controller.js", projectRoot), "utf8")
  ]);

  assert.match(route, /router\.post\("\/voice-command", authMiddleware, receiveVoiceUpload/u);
  assert.match(route, /fileSize: 1024 \* 1024/u);
  assert.match(service, /gpt-4o-mini-transcribe/u);
  assert.match(service, /json_schema/u);
  assert.match(markup, /id="analytics-voice-button"/u);
  assert.match(markup, /id="analytics-voice-feedback"/u);
  assert.match(controller, /navigator\.mediaDevices\.getUserMedia/u);
  assert.match(controller, /VOICE_RECORDING_MAX_MS = 15_000/u);
  assert.match(controller, /VOICE_FEEDBACK_HIDE_MS = 5_000/u);
  assert.match(controller, /fetch\("\/api\/analytics\/voice-command"/u);
  assert.match(controller, /\{ autoHide: true \}/u);
  assert.match(controller, /this\.hideVoiceFeedback\(\)/u);
});

test("every locale includes analytics voice feedback", async () => {
  const keys = [
    "voiceLabel",
    "voiceHint",
    "voiceListening",
    "voiceProcessing",
    "voiceApplied",
    "voiceNoAction",
    "voiceError",
    "voicePermissionError",
    "voiceUnsupported"
  ];
  for (const locale of ["de", "en", "es", "fr", "it", "pt"]) {
    const messages = JSON.parse(await readFile(
      new URL(`src/public/i18n/${locale}.json`, projectRoot),
      "utf8"
    ));
    keys.forEach((key) => assert.equal(typeof messages.analyticsPage[key], "string"));
  }
});
