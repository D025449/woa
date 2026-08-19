import assert from "node:assert/strict";
import test from "node:test";

import { AnalyticsOverviewCache } from "../src/services/analyticsOverviewCache.js";

test("analytics overview cache expires and evicts compressed buffers by LRU order", () => {
  let now = 1_000;
  const cache = new AnalyticsOverviewCache({ maxBytes: 6, ttlMs: 100, now: () => now });
  cache.set(1, "week", Buffer.from("aaa"));
  cache.set(1, "month", Buffer.from("bbb"));
  assert.equal(cache.get(1, "week").toString(), "aaa");

  cache.set(2, "week", Buffer.from("ccc"));
  assert.equal(cache.get(1, "month"), null);
  assert.equal(cache.totalBytes, 6);

  now += 101;
  assert.equal(cache.get(1, "week"), null);
  assert.equal(cache.get(2, "week"), null);
  assert.equal(cache.totalBytes, 0);
});

test("user invalidation removes every grouping and rejects an in-flight stale result", () => {
  const cache = new AnalyticsOverviewCache({ maxBytes: 100, ttlMs: 100 });
  const revision = cache.revision(7);
  cache.set(7, "week", Buffer.from("week"), revision);
  cache.set(7, "month", Buffer.from("month"), revision);
  cache.set(8, "week", Buffer.from("other"));

  cache.invalidateUser(7);
  assert.equal(cache.get(7, "week"), null);
  assert.equal(cache.get(7, "month"), null);
  assert.equal(cache.get(8, "week").toString(), "other");
  assert.equal(cache.set(7, "year", Buffer.from("stale"), revision), false);
});
