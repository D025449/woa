import assert from "node:assert/strict";
import test from "node:test";

import {
  formatAnalysisPeriod,
  formatAnalysisPeriodValue,
  getISOWeekStartDate,
  mapSharedGrouping,
  resolveAnalysisPeriod,
  resolveCalendarAnalysisPeriod,
  resolvePreviousAnalysisPeriod
} from "../src/public/js/analytics-period.js";

test("maps one shared grouping to both analytics APIs", () => {
  assert.deepEqual(mapSharedGrouping("week"), {
    shared: "week",
    loadModel: "week",
    powerCurve: "year_week"
  });
  assert.deepEqual(mapSharedGrouping("quarter"), {
    shared: "quarter",
    loadModel: "quarter",
    powerCurve: "year_quarter"
  });
});

test("resolves clicked analytics points to exclusive UTC periods", () => {
  const month = resolveAnalysisPeriod("2026-08-01", "month");
  assert.equal(month.start, "2026-08-01T00:00:00.000Z");
  assert.equal(month.end, "2026-09-01T00:00:00.000Z");

  const quarter = resolveAnalysisPeriod("2026-07-01", "quarter");
  assert.equal(quarter.start, "2026-07-01T00:00:00.000Z");
  assert.equal(quarter.end, "2026-10-01T00:00:00.000Z");
});

test("resolves programmatic analytics clicks from millisecond timestamps", () => {
  const timestamp = Date.UTC(2026, 6, 1);
  assert.deepEqual(resolveAnalysisPeriod(timestamp, "month"), {
    start: "2026-07-01T00:00:00.000Z",
    end: "2026-08-01T00:00:00.000Z",
    startMs: timestamp,
    endMs: Date.UTC(2026, 7, 1)
  });
});

test("resolves the previous completed calendar period", () => {
  assert.equal(
    resolveCalendarAnalysisPeriod(Date.UTC(2026, 7, 18), "quarter", 0).start,
    "2026-07-01T00:00:00.000Z"
  );
  assert.deepEqual(resolvePreviousAnalysisPeriod(Date.UTC(2026, 7, 18), "week", 1), {
    start: "2026-08-10T00:00:00.000Z",
    end: "2026-08-17T00:00:00.000Z",
    startMs: Date.UTC(2026, 7, 10),
    endMs: Date.UTC(2026, 7, 17)
  });
  assert.equal(
    resolvePreviousAnalysisPeriod(Date.UTC(2026, 7, 18), "month", 2).start,
    "2026-06-01T00:00:00.000Z"
  );
});

test("maps ISO weeks to UTC Mondays independently of the browser timezone", () => {
  assert.equal(getISOWeekStartDate(2026, 33), "2026-08-10");
  assert.equal(getISOWeekStartDate(2026, 1), "2025-12-29");
});

test("formats analytics periods by their grouping semantics", () => {
  assert.equal(
    formatAnalysisPeriod(resolveAnalysisPeriod("2025-10-01", "quarter"), "quarter", "de"),
    "Q4 2025"
  );
  assert.equal(formatAnalysisPeriodValue("2026-01-01", "year", "de"), "2026");
  assert.equal(formatAnalysisPeriodValue("2026-08-01", "year_month", "de"), "Aug. 2026");
  assert.equal(
    formatAnalysisPeriodValue("2026-08-10", "year_week", "de"),
    "10. Aug. 2026 - 16. Aug. 2026"
  );
});
