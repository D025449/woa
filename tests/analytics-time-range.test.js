import assert from "node:assert/strict";
import test from "node:test";

import {
  findSeriesTimeBounds,
  readZoomEventTimeRange,
  resolveAnalyticsTimeRange,
  toDateInputValue
} from "../src/public/js/analytics-time-range.js";

test("uses the complete shared data range until a slider range is persisted", () => {
  const bounds = {
    start: Date.parse("2024-01-01"),
    end: Date.parse("2026-08-31")
  };

  assert.deepEqual(resolveAnalyticsTimeRange({ mode: "all" }, bounds), bounds);
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
