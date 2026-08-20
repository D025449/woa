import assert from "node:assert/strict";
import test from "node:test";

import {
  findSeriesTimeBounds,
  readZoomEventTimeRange,
  resolveAnalyticsTimeRange,
  selectStablePeriodTimestamp,
  snapAnalyticsRangeToGrouping,
  toDateInputValue
} from "../src/public/js/analytics-time-range.js";

test("keeps grouped chart hover on the nearest rendered period", () => {
  const periods = [
    Date.parse("2026-06-01T00:00:00.000Z"),
    Date.parse("2026-07-01T00:00:00.000Z"),
    Date.parse("2026-08-01T00:00:00.000Z")
  ];

  assert.equal(
    selectStablePeriodTimestamp(periods, Date.parse("2026-06-24T00:00:00.000Z")),
    periods[1]
  );
  assert.equal(
    selectStablePeriodTimestamp(periods, Date.parse("2026-07-08T00:00:00.000Z")),
    periods[1]
  );
});

test("uses hysteresis when crossing grouped chart period boundaries", () => {
  const periods = [0, 100, 200];

  assert.equal(selectStablePeriodTimestamp(periods, 154, 100), 100);
  assert.equal(selectStablePeriodTimestamp(periods, 156, 100), 200);
  assert.equal(selectStablePeriodTimestamp(periods, 146, 200), 200);
  assert.equal(selectStablePeriodTimestamp(periods, 144, 200), 100);
});

test("uses the complete shared data range until a slider range is persisted", () => {
  const bounds = {
    start: Date.parse("2024-01-01"),
    end: Date.parse("2026-08-31")
  };

  assert.deepEqual(resolveAnalyticsTimeRange({ mode: "all" }, bounds), bounds);
});

test("expands analytics ranges to complete calendar groups", () => {
  const range = {
    start: Date.parse("2026-08-19T00:00:00.000Z"),
    end: Date.parse("2026-08-23T00:00:00.000Z")
  };

  assert.deepEqual(snapAnalyticsRangeToGrouping(range, "week"), {
    start: Date.parse("2026-08-17T00:00:00.000Z"),
    end: Date.parse("2026-08-23T00:00:00.000Z")
  });
  assert.deepEqual(snapAnalyticsRangeToGrouping(range, "month"), {
    start: Date.parse("2026-08-01T00:00:00.000Z"),
    end: Date.parse("2026-08-31T00:00:00.000Z")
  });
  assert.deepEqual(snapAnalyticsRangeToGrouping(range, "quarter"), {
    start: Date.parse("2026-07-01T00:00:00.000Z"),
    end: Date.parse("2026-09-30T00:00:00.000Z")
  });
});

test("resolves and serializes exact slider-defined analytics dates", () => {
  const range = resolveAnalyticsTimeRange({
    mode: "custom",
    start: "2026-04-12",
    end: "2026-08-17"
  }, {
    start: Date.parse("2020-01-01"),
    end: Date.parse("2026-08-17")
  });

  assert.deepEqual(range, {
    start: Date.parse("2026-04-12"),
    end: Date.parse("2026-08-17")
  });
  assert.equal(toDateInputValue(range.start), "2026-04-12");
});

test("derives shared chart bounds and converts zoom percentages to dates", () => {
  const bounds = findSeriesTimeBounds([{
    data: [
      { value: ["2026-01-01", 10] },
      { value: ["2026-03-01", 20] }
    ]
  }]);
  const range = readZoomEventTimeRange({ start: 25, end: 75 }, bounds);

  assert.deepEqual(bounds, {
    start: Date.parse("2026-01-01"),
    end: Date.parse("2026-03-01")
  });
  assert.equal(range.start, bounds.start + (bounds.end - bounds.start) * 0.25);
  assert.equal(range.end, bounds.start + (bounds.end - bounds.start) * 0.75);
});
