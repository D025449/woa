import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { readFile } from "node:fs/promises";

import WorkoutThumbnailService from "../src/services/workoutThumbnailService.js";
import { GeoapifyThumbnailClient } from "../src/services/geoapifyThumbnailService.js";
import GeoapifyThumbnailService from "../src/services/geoapifyThumbnailService.js";
import pool from "../src/services/database.js";
import LocalThumbnailMapService from "../src/services/localThumbnailMapService.js";

test("library observes on-demand candidates and starts requests only near the viewport", async () => {
  const source = await readFile(new URL("../src/public/js/workout-library-view.js", import.meta.url), "utf8");
  assert.match(source, /workout\.has_thumbnail \?/);
  assert.match(source, /style="visibility:hidden;"/);
  const methods = ["bindThumbnailLazyLoad", "loadThumbnailImage", "loadVisibleThumbnailImages"].map(name => {
    const start = source.search(new RegExp(`^  ${name}\\(`, "m"));
    const rest = source.slice(start + 1);
    const next = rest.search(/\n {2}(?:async )?\w+\(/);
    return source.slice(start, start + 1 + next);
  });
  class ImageFixture {
    constructor(top) { this.dataset = { thumbSrc: `/thumbnail/${top}` }; this.src = null; this.top = top; }
    getAttribute() { return this.src; }
    setAttribute(_name, value) { this.src = value; }
    getBoundingClientRect() { return { top: this.top, bottom: this.top + 95, left: 10, right: 162 }; }
  }
  let observed;
  class ObserverFixture {
    constructor(callback) { observed = callback; }
    observe() {}
    unobserve() {}
  }
  const Controller = new Function("HTMLImageElement", "IntersectionObserver", "window", "requestAnimationFrame",
    `return class { ${methods.join("\n")} }`)(ImageFixture, ObserverFixture,
      { IntersectionObserver: ObserverFixture, innerWidth: 800, innerHeight: 600 }, callback => callback());
  const visible = new ImageFixture(20);
  const distant = new ImageFixture(1000);
  const controller = new Controller();
  controller.container = { querySelectorAll: () => [visible, distant] };
  controller.bindThumbnailLazyLoad();
  assert.equal(visible.src, visible.dataset.thumbSrc);
  assert.equal(distant.src, null);
  observed([{ target: distant, isIntersecting: true }]);
  assert.equal(distant.src, distant.dataset.thumbSrc);
});

test("local maps reuse every existing thumbnail without style upgrades or fallback retries", () => {
  const previous = process.env.WOA_THUMBNAIL_MAP_PROVIDER;
  process.env.WOA_THUMBNAIL_MAP_PROVIDER = "local";
  try {
    for (const content of ['<svg/>', '<svg data-map-fallback="outside-coverage"/>', '<svg data-thumbnail-style="1"/>',
      '<svg data-local-map-state="temporary-failure"/>', '<svg data-local-map-state="unknown"/>']) {
      assert.equal(WorkoutThumbnailService.isCurrentRouteThumbnail({ kind: "route", content }, Date.now()), true);
    }
    assert.equal(WorkoutThumbnailService.hasMapBackground({ kind: "route", content: '<svg data-map-provider="local"/>' }), true);
  } finally {
    if (previous === undefined) delete process.env.WOA_THUMBNAIL_MAP_PROVIDER;
    else process.env.WOA_THUMBNAIL_MAP_PROVIDER = previous;
  }
});

test("new local fallbacks distinguish coverage, temporary failures and unsupported routes", async context => {
  const previous = process.env.WOA_THUMBNAIL_MAP_PROVIDER;
  process.env.WOA_THUMBNAIL_MAP_PROVIDER = "local";
  let revision = "a".repeat(64);
  context.mock.method(LocalThumbnailMapService, "getRevision", () => revision);
  try {
    for (const [reason, state] of [["outside-coverage", "missing-coverage"], ["local-map-timeout", "temporary-failure"],
      ["unsupported-route", "unsupported-route"], ["private-value?token=secret", "temporary-failure"]]) {
      context.mock.method(LocalThumbnailMapService, "render", async () => { throw new Error(reason); });
      const payload = await WorkoutThumbnailService.createThumbnailPayloadAsync({ gpsTrack: [[49, 8], [49.1, 8.1]] });
      assert.match(payload.content, new RegExp(`data-local-map-state="${state}"`));
      assert.doesNotMatch(payload.content, /private-value|token=secret/);
      assert.equal(WorkoutThumbnailService.isCurrentRouteThumbnail(payload), true);
      const retryAt = payload.renderStats.mapRetryAt;
      assert.equal(WorkoutThumbnailService.isCurrentRouteThumbnail(payload, Date.now() + 3600000), state !== "temporary-failure");
      if (state === "temporary-failure") assert.equal(WorkoutThumbnailService.isCurrentRouteThumbnail(payload, retryAt), false);
      revision = "b".repeat(64);
      assert.equal(WorkoutThumbnailService.isCurrentRouteThumbnail(payload), state === "unsupported-route");
      revision = "a".repeat(64);
    }
  } finally {
    if (previous === undefined) delete process.env.WOA_THUMBNAIL_MAP_PROVIDER;
    else process.env.WOA_THUMBNAIL_MAP_PROVIDER = previous;
  }
});

test("persisted local temporary failures back off, stop after three attempts and reset on explicit replacement", async context => {
  const previous = process.env.WOA_THUMBNAIL_MAP_PROVIDER;
  process.env.WOA_THUMBNAIL_MAP_PROVIDER = "local";
  let now = Date.now();
  let revision = "a".repeat(64);
  let stored = null;
  let renders = 0;
  context.mock.method(Date, "now", () => now);
  context.mock.method(LocalThumbnailMapService, "getRevision", () => revision);
  context.mock.method(LocalThumbnailMapService, "render", async () => { renders++; throw new Error("local-map-timeout"); });
  context.mock.method(pool, "connect", async () => ({ async query() { return { rows: [] }; }, release() {} }));
  context.mock.method(WorkoutThumbnailService, "getThumbnail", async () => stored);
  context.mock.method(WorkoutThumbnailService, "upsertThumbnail", async (_id, payload) => { stored = { ...payload }; return stored; });
  const create = () => WorkoutThumbnailService.createThumbnailPayloadAsync({ gpsTrack: [[49, 8], [49.1, 8.1]] });
  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      await Promise.all([WorkoutThumbnailService.getOrCreateThumbnail(776, create), WorkoutThumbnailService.getOrCreateThumbnail(776, create)]);
      assert.equal(renders, attempt);
      assert.equal(stored.renderStats.localMapAttempt, attempt);
      assert.match(stored.content, new RegExp(`data-local-map-attempt="${attempt}"`));
      await WorkoutThumbnailService.getOrCreateThumbnail(776, () => assert.fail("must wait before retry"));
      if (attempt < 3) {
        assert.equal(stored.renderStats.mapRetryAt - now, attempt === 1 ? 300000 : 900000);
        now = stored.renderStats.mapRetryAt;
      }
    }
    now += 86400000;
    await WorkoutThumbnailService.getOrCreateThumbnail(776, () => assert.fail("retry limit must remain bounded"));
    assert.equal(stored.renderStats.mapRetryAt, 0);
    await WorkoutThumbnailService.getOrCreateThumbnail(776, create, { replaceExisting: true });
    assert.equal(renders, 4);
    assert.equal(stored.renderStats.localMapAttempt, 1);
    revision = "b".repeat(64);
    await WorkoutThumbnailService.getOrCreateThumbnail(776, create);
    assert.equal(renders, 5);
    assert.equal(stored.renderStats.localMapAttempt, 1);
    assert.equal(stored.renderStats.localMapRevision, revision);
  } finally {
    if (previous === undefined) delete process.env.WOA_THUMBNAIL_MAP_PROVIDER;
    else process.env.WOA_THUMBNAIL_MAP_PROVIDER = previous;
  }
});

test("persisted missing-coverage fallbacks are replaced once after local coverage changes", async context => {
  const previous = process.env.WOA_THUMBNAIL_MAP_PROVIDER;
  process.env.WOA_THUMBNAIL_MAP_PROVIDER = "local";
  let revision = "a".repeat(64);
  let stored = null;
  let renders = 0;
  context.mock.method(LocalThumbnailMapService, "getRevision", () => revision);
  context.mock.method(LocalThumbnailMapService, "render", async () => {
    renders++;
    if (revision.startsWith("a")) throw new Error("outside-coverage");
    return { svg: '<svg data-map-provider="local"/>', stats: {} };
  });
  context.mock.method(pool, "connect", async () => ({ async query() { return { rows: [] }; }, release() {} }));
  context.mock.method(WorkoutThumbnailService, "getThumbnail", async () => stored);
  context.mock.method(WorkoutThumbnailService, "upsertThumbnail", async (_id, payload) => { stored = { ...payload }; return stored; });
  const create = () => WorkoutThumbnailService.createThumbnailPayloadAsync({ gpsTrack: [[49, 8], [49.1, 8.1]] });
  try {
    await WorkoutThumbnailService.getOrCreateThumbnail(777, create);
    assert.equal(stored.renderStats.localMapState, "missing-coverage");
    await WorkoutThumbnailService.getOrCreateThumbnail(777, () => assert.fail("unchanged coverage must not retry"));
    assert.equal(renders, 1);
    assert.equal(WorkoutThumbnailService.getThumbnailCacheControl(stored), "private, max-age=60");
    revision = "b".repeat(64);
    await Promise.all([WorkoutThumbnailService.getOrCreateThumbnail(777, create), WorkoutThumbnailService.getOrCreateThumbnail(777, create)]);
    assert.equal(renders, 2);
    assert.equal(WorkoutThumbnailService.hasMapBackground(stored), true);
    revision = "c".repeat(64);
    await WorkoutThumbnailService.getOrCreateThumbnail(777, () => assert.fail("successful images must survive future revisions"));
    assert.equal(renders, 2);
  } finally {
    if (previous === undefined) delete process.env.WOA_THUMBNAIL_MAP_PROVIDER;
    else process.env.WOA_THUMBNAIL_MAP_PROVIDER = previous;
  }
});

test("local provider renders GPS only and never calls the external map provider", async context => {
  const previous = process.env.WOA_THUMBNAIL_MAP_PROVIDER;
  process.env.WOA_THUMBNAIL_MAP_PROVIDER = "local";
  context.mock.method(GeoapifyThumbnailService, "getBackground", () => assert.fail("external maps forbidden"));
  let requests = 0;
  context.mock.method(LocalThumbnailMapService, "render", async () => {
    requests++;
    return { svg: '<svg data-map-provider="local"/>', stats: { cache: { memory: 1 } } };
  });
  try {
    const local = await WorkoutThumbnailService.createThumbnailPayloadAsync({ gpsTrack: [[49, 8], [49.1, 8.1]] });
    assert.match(local.content, /data-map-provider="local"/);
    assert.equal(local.width, 320);
    await WorkoutThumbnailService.createThumbnailPayloadAsync({ powers: [100, 200, 150] });
    assert.equal(requests, 1);
    context.mock.method(LocalThumbnailMapService, "render", async () => { throw new Error("outside-coverage"); });
    const fallback = await WorkoutThumbnailService.createThumbnailPayloadAsync({ gpsTrack: [[40, 100], [40.1, 100.1]] });
    assert.equal(fallback.kind, "route");
    assert.equal(WorkoutThumbnailService.hasMapBackground(fallback), false);
  } finally {
    if (previous === undefined) delete process.env.WOA_THUMBNAIL_MAP_PROVIDER;
    else process.env.WOA_THUMBNAIL_MAP_PROVIDER = previous;
  }
});

test("thumbnail persistence serializes creation, commits before returning and reuses stored content", async (context) => {
  const payload = WorkoutThumbnailService.createThumbnailPayload({ gpsTrack: [[49, 8], [49.1, 8.1]] });
  let stored = null;
  let creates = 0;
  const statements = [];
  context.mock.method(pool, "connect", async () => ({
    query: async (sql) => {
      statements.push(sql);
      if (sql.includes("FROM workout_thumbnails")) return { rows: stored ? [stored] : [] };
      if (sql.includes("INSERT INTO workout_thumbnails")) {
        stored = { ...payload, workoutId: 42, updatedAt: new Date().toISOString() };
        return { rows: [stored] };
      }
      return { rows: [] };
    },
    release: () => { statements.push("RELEASE"); }
  }));
  const create = async () => { creates += 1; await Promise.resolve(); return payload; };
  const [first, concurrent] = await Promise.all([
    WorkoutThumbnailService.getOrCreateThumbnail(42, create),
    WorkoutThumbnailService.getOrCreateThumbnail(42, create)
  ]);
  assert.equal(first, concurrent);
  assert.equal(creates, 1);
  assert.equal(first.content, payload.content);
  assert.deepEqual(statements.slice(-2), ["COMMIT", "RELEASE"]);
  assert.ok(statements.find((sql) => sql.includes("pg_advisory_xact_lock")));
  const cached = await WorkoutThumbnailService.getOrCreateThumbnail(42, async () => assert.fail("duplicate map generation"));
  assert.equal(cached.content, payload.content);
  assert.equal(creates, 1);
  await WorkoutThumbnailService.getOrCreateThumbnail(42, create, { replaceExisting: true });
  assert.equal(creates, 2);
});

test("thumbnail generation allows six concurrent jobs and queues the seventh", async (context) => {
  context.mock.method(console, "info", () => {});
  context.mock.method(pool, "connect", async () => ({
    query: async () => ({ rows: [] }),
    release: () => {}
  }));
  let releaseJobs;
  const gate = new Promise((resolve) => { releaseJobs = resolve; });
  let active = 0;
  let maximumActive = 0;
  let started = 0;
  const jobs = Array.from({ length: 7 }, (_, index) => WorkoutThumbnailService.getOrCreateThumbnail(100 + index, async () => {
    started += 1;
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await gate;
    active -= 1;
    return null;
  }));
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(started, 6);
    assert.equal(maximumActive, 6);
  } finally {
    releaseJobs();
    await Promise.all(jobs);
  }
  assert.equal(started, 7);
  assert.equal(maximumActive, 6);
});

test("failed thumbnail persistence rolls back and does not leave an in-flight cached result", async (context) => {
  const statements = [];
  context.mock.method(pool, "connect", async () => ({
    query: async (sql) => {
      statements.push(sql);
      if (sql.includes("FROM workout_thumbnails")) return { rows: [] };
      if (sql.includes("INSERT INTO workout_thumbnails")) throw new Error("write failed");
      return { rows: [] };
    },
    release: () => { statements.push("RELEASE"); }
  }));
  let creates = 0;
  const create = async () => {
    creates += 1;
    return WorkoutThumbnailService.createThumbnailPayload({ gpsTrack: [[49, 8], [49.1, 8.1]] });
  };
  await assert.rejects(WorkoutThumbnailService.getOrCreateThumbnail(43, create), /write failed/);
  await assert.rejects(WorkoutThumbnailService.getOrCreateThumbnail(43, create), /write failed/);
  assert.equal(creates, 2);
  assert.deepEqual(statements.slice(-2), ["ROLLBACK", "RELEASE"]);
});

const mapViewport = { longitude: 8.5, latitude: 49.5, zoom: 10 };

test("Geoapify uses the Free credit budget while respecting a lower configured image cap", async () => {
  for (const [options, expectedLimit] of [[{}, 1000], [{ dailyLimit: () => 125 }, 125]]) {
    let reservations = 0;
    const client = new GeoapifyThumbnailClient({
      apiKey: () => "test-only-key",
      ...options,
      reserve: async (key, limit) => {
        assert.equal(limit, expectedLimit);
        reservations += 1;
        return -2;
      },
      fetchImpl: async () => assert.fail("exhausted budget must not fetch")
    });
    assert.equal(await client.getBackground(mapViewport), null);
    assert.equal(reservations, 1);
  }
});

test("Geoapify skips requests without configuration or budget", async () => {
  for (const options of [{ apiKey: () => "" }, { dailyLimit: () => 0 }, { reserve: async () => -1 }]) {
    const client = new GeoapifyThumbnailClient({
      apiKey: () => "test-only-key", reserve: async () => 0, pause: async () => {},
      fetchImpl: async () => { assert.fail("unexpected request"); }, ...options
    });
    assert.equal(await client.getBackground(mapViewport), null);
  }
});

test("Geoapify bounds requests and returns a self-contained 320x200 WebP", async () => {
  const png = await sharp({ create: { width: 320, height: 200, channels: 3, background: "#87bd82" } }).png().toBuffer();
  const client = new GeoapifyThumbnailClient({
    apiKey: () => "test-only-key", dailyLimit: () => 99999,
    reserve: async (key, limit) => { assert.equal(limit, 1000); return 0; },
    pause: async () => { assert.fail("unexpected pause"); },
    fetchImpl: async (url, options) => {
      assert.equal(url.origin, "https://maps.geoapify.com");
      assert.equal(url.searchParams.get("center"), "lonlat:8.5000000,49.5000000");
      assert.equal(url.searchParams.has("geometry"), false);
      assert.equal(options.redirect, "error");
      return new Response(png, { headers: { "content-type": "image/png" } });
    }
  });
  const data = await client.getBackground(mapViewport);
  assert.match(data, /^data:image\/webp;base64,/);
  assert.doesNotMatch(data, /test-only-key/);
  const metadata = await sharp(Buffer.from(data.split(",")[1], "base64")).metadata();
  assert.equal(metadata.width, 320);
  assert.equal(metadata.height, 200);
  assert.equal(metadata.format, "webp");
});

test("Geoapify rejects invalid images and pauses after repeated errors or immediately on HTTP 429", async () => {
  const wrongSize = await sharp({ create: { width: 32, height: 20, channels: 3, background: "white" } }).png().toBuffer();
  for (const response of [
    new Response("error", { status: 503 }),
    new Response("html", { headers: { "content-type": "text/html" } }),
    new Response("not png", { headers: { "content-type": "image/png" } }),
    new Response("big", { headers: { "content-type": "image/png", "content-length": "999999" } }),
    new Response(Buffer.alloc(512 * 1024 + 1), { headers: { "content-type": "image/png" } }),
    new Response(wrongSize, { headers: { "content-type": "image/png" } }),
    new Response("quota", { status: 429 })
  ]) {
    let calls = 0;
    let pauseMs = 0;
    const client = new GeoapifyThumbnailClient({
      apiKey: () => "test-only-key", reserve: async () => 0,
      pause: async (key, duration) => { pauseMs = duration; },
      fetchImpl: async () => { calls += 1; return response.clone(); }
    });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      assert.equal(await client.getBackground(mapViewport), null);
    }
    assert.equal(calls, response.status === 429 ? 1 : 3);
    assert.ok(pauseMs > 0);
  }
});

test("Geoapify fails closed without Redis and aborts stalled provider requests", async () => {
  const unavailable = new GeoapifyThumbnailClient({
    apiKey: () => "test-only-key",
    reserve: async () => { throw new Error("Redis offline"); },
    pause: async () => {},
    fetchImpl: async () => { assert.fail("unexpected request"); }
  });
  assert.equal(await unavailable.getBackground(mapViewport), null);
  const stalled = new GeoapifyThumbnailClient({
    apiKey: () => "test-only-key", reserve: async () => 0, pause: async () => {}, timeoutMs: 5,
    fetchImpl: async (url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })
  });
  assert.equal(await stalled.getBackground(mapViewport), null);
});

test("provider failures log safe diagnostics without leaking error text", async (context) => {
  const warnings = [];
  context.mock.method(console, "warn", (...args) => { warnings.push(args); });
  let details;
  const client = new GeoapifyThumbnailClient({
    apiKey: () => "secret-test-token",
    reserve: async () => 0,
    pause: async () => {},
    fetchImpl: async () => { throw new Error("https://provider.invalid/?apiKey=secret-test-token"); }
  });
  assert.equal(await client.getBackground(mapViewport, {
    workoutId: 85045,
    onFallback: (value) => { details = value; }
  }), null);
  assert.equal(await client.getBackground(mapViewport), null);
  assert.equal(warnings.length, 2);
  assert.equal(warnings[0][0], "[thumbnail] map.failed");
  assert.equal(warnings[0][1].workoutId, 85045);
  assert.equal(warnings[0][1].reason, "network-error");
  assert.equal(warnings[0][1].globalPause, false);
  assert.equal(details.reason, "network-error");
  assert.doesNotMatch(JSON.stringify(warnings), /secret-test-token|provider\.invalid|apiKey/);
});

test("a single timeout does not block another workout and successful responses reset failures", async (context) => {
  context.mock.method(console, "warn", () => {});
  const png = await sharp({ create: { width: 320, height: 200, channels: 3, background: "white" } }).png().toBuffer();
  let calls = 0;
  const client = new GeoapifyThumbnailClient({
    apiKey: () => "test-only-key", reserve: async () => 0, timeoutMs: 5,
    pause: async () => assert.fail("single timeout must not pause all maps"),
    fetchImpl: async (url, { signal }) => {
      calls += 1;
      if (calls === 1) return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      return new Response(png, { headers: { "content-type": "image/png" } });
    }
  });
  assert.equal(new GeoapifyThumbnailClient().timeoutMs, 15000);
  assert.equal(await client.getBackground(mapViewport, { workoutId: 85051 }), null);
  assert.equal(client.pausedUntil, 0);
  assert.equal(client.consecutiveFailures, 1);
  assert.match(await client.getBackground(mapViewport, { workoutId: 85052 }), /^data:image\/webp;base64,/);
  assert.equal(calls, 2);
  assert.equal(client.consecutiveFailures, 0);
});

test("only three consecutive failures open the shared circuit and a success breaks the streak", async (context) => {
  context.mock.method(console, "warn", () => {});
  const png = await sharp({ create: { width: 320, height: 200, channels: 3, background: "white" } }).png().toBuffer();
  let calls = 0;
  let pauses = 0;
  const client = new GeoapifyThumbnailClient({
    apiKey: () => "test-only-key", reserve: async () => 0,
    pause: async () => { pauses += 1; },
    fetchImpl: async () => {
      calls += 1;
      if (calls === 3) return new Response(png, { headers: { "content-type": "image/png" } });
      throw new Error("transient error");
    }
  });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await client.getBackground(mapViewport);
    assert.equal(pauses, 0);
  }
  await client.getBackground(mapViewport);
  assert.equal(pauses, 1);
  assert.equal(client.consecutiveFailures, 3);
  await client.getBackground(mapViewport);
  assert.equal(calls, 6);
});

test("daily budget exhaustion defers retries until the next UTC day without a provider request", async () => {
  let details;
  const client = new GeoapifyThumbnailClient({
    apiKey: () => "test-only-key",
    reserve: async () => -2,
    fetchImpl: async () => assert.fail("unexpected request")
  });
  assert.equal(await client.getBackground(mapViewport, { onFallback: (value) => { details = value; } }), null);
  assert.equal(details.reason, "daily-limit");
  assert.equal(new Date(details.retryAt).getUTCHours(), 0);
  assert.ok(details.retryAt > Date.now());
});

test("async thumbnail generation preserves the old route on missing maps and provider failures", async () => {
  const options = { gpsTrack: [[49, 8], [49.1, 8.1]] };
  const fallback = WorkoutThumbnailService.createThumbnailPayload(options);
  assert.deepEqual(await WorkoutThumbnailService.createThumbnailPayloadAsync(options, {
    renderRoute: async () => null
  }), fallback);
  assert.deepEqual(await WorkoutThumbnailService.createThumbnailPayloadAsync(options, {
    renderRoute: async () => { throw new Error("provider unavailable"); }
  }), fallback);
  const mapped = { ...fallback, content: "<svg>map</svg>" };
  assert.equal(await WorkoutThumbnailService.createThumbnailPayloadAsync(options, {
    renderRoute: async () => mapped
  }), mapped);
});

test("async thumbnail generation never requests a map for indoor or non-GPS workouts", async () => {
  for (const options of [
    { workoutType: "indoor", gpsTrack: [[49, 8], [49.1, 8.1]], powers: [100, 200] },
    { powers: [100, 200] }
  ]) {
    assert.deepEqual(await WorkoutThumbnailService.createThumbnailPayloadAsync(options, {
      renderRoute: async () => { assert.fail("unexpected map request"); }
    }), WorkoutThumbnailService.createThumbnailPayload(options));
  }
});

test("map thumbnail preserves GPS gaps, segment colors and Mercator alignment", async (context) => {
  let viewport;
  const raster = await sharp({ create: { width: 320, height: 200, channels: 3, background: "#87bd82" } }).webp().toBuffer();
  context.mock.method(GeoapifyThumbnailService, "getBackground", async (value) => {
    viewport = value;
    return `data:image/webp;base64,${raster.toString("base64")}`;
  });
  const thumbnail = await WorkoutThumbnailService.createThumbnailPayloadAsync({
    gpsTrackSegments: [[[49, 8], [49.1, 8.1]], [[49.2, 8.2], [49.3, 8.3]]],
    segmentOverlays: [{ segmenttype: "gps", segments: [[{ lat: 49, lng: 8 }, { lat: 49.1, lng: 8.1 }]] }]
  });
  assert.match(thumbnail.content, /data-map-provider="geoapify"/);
  assert.match(thumbnail.content, /data:image\/webp;base64,/);
  assert.equal((thumbnail.content.match(/<path id="route-/g) || []).length, 2);
  assert.match(thumbnail.content, /data-segment-type="gps"[^>]+stroke="#22a957"/);
  assert.match(thumbnail.content, /OpenStreetMap contributors/);
  assert.match(thumbnail.content, /Powered by.*Geoapify.*OpenMapTiles/);
  assert.equal(WorkoutThumbnailService.isCurrentRouteThumbnail(thumbnail), true);
  const firstPoint = thumbnail.content.match(/id="route-0" d="M ([\d.]+) ([\d.]+)/);
  const mercator = (latitude) => Math.log(Math.tan(Math.PI / 4 + latitude * Math.PI / 360)) * 180 / Math.PI;
  const pixelsPerDegree = 512 * 2 ** viewport.zoom / 360 / 1.25;
  assert.ok(Math.abs(Number(firstPoint[1]) - (128 + (8 - viewport.longitude) * pixelsPerDegree)) < 0.1);
  assert.ok(Math.abs(Number(firstPoint[2]) - (80 - (mercator(49) - mercator(viewport.latitude)) * pixelsPerDegree)) < 0.1);
});

test("fallbacks store safe failure codes and explicit retry times without credentials", async (context) => {
  const retryAt = Date.now() + 300000;
  context.mock.method(GeoapifyThumbnailService, "getBackground", async (viewport, { onFallback, workoutId }) => {
    assert.equal(workoutId, 85045);
    onFallback({ reason: "http-503", retryAt });
    return null;
  });
  const payload = await WorkoutThumbnailService.createThumbnailPayloadAsync({ workoutId: 85045, gpsTrack: [[49, 8], [49.1, 8.1]] });
  assert.match(payload.content, /data-map-fallback="http-503"/);
  assert.match(payload.content, new RegExp(`data-map-retry-at="${retryAt}"`));
  assert.equal(payload.renderStats.mapFallbackReason, "http-503");
  assert.doesNotMatch(payload.content, /apiKey|test-only-key/);
  assert.equal(WorkoutThumbnailService.isCurrentRouteThumbnail(payload, retryAt - 1), true);
  assert.equal(WorkoutThumbnailService.isCurrentRouteThumbnail(payload, retryAt), false);
});

test("expired stored fallbacks are replaced once and the resulting map stays cached", async (context) => {
  const fallback = WorkoutThumbnailService.createThumbnailPayload({ gpsTrack: [[49, 8], [49.1, 8.1]] });
  const mapped = { ...fallback, content: fallback.content.replace("<svg ", '<svg data-map-provider="geoapify" ') };
  let stored = { ...fallback, updatedAt: new Date(Date.now() - 600000) };
  context.mock.method(pool, "connect", async () => ({
    query: async (sql) => {
      if (sql.includes("FROM workout_thumbnails")) return { rows: [stored] };
      if (sql.includes("INSERT INTO workout_thumbnails")) {
        stored = { ...mapped, updatedAt: new Date() };
        return { rows: [stored] };
      }
      return { rows: [] };
    },
    release: () => {}
  }));
  let creates = 0;
  const create = async () => { creates += 1; return mapped; };
  await Promise.all([
    WorkoutThumbnailService.getOrCreateThumbnail(44, create),
    WorkoutThumbnailService.getOrCreateThumbnail(44, create)
  ]);
  await WorkoutThumbnailService.getOrCreateThumbnail(44, async () => assert.fail("duplicate provider request"));
  assert.equal(creates, 1);
  assert.equal(WorkoutThumbnailService.hasMapBackground(stored), true);
});

test("route thumbnail projects all GPS segments into shared bounds", () => {
  const thumbnail = WorkoutThumbnailService.createThumbnailPayload({
    gpsTrackSegments: [
      [[49, 8], [49.1, 8.1]],
      [[49.8, 8.8], [49.9, 8.9]]
    ]
  });

  const paths = [...thumbnail.content.matchAll(/<path d="([^"]+)"/g)]
    .map((match) => match[1]);

  assert.equal(paths.length, 2);

  const firstEnd = paths[0].match(/L ([\d.]+) ([\d.]+)$/);
  const secondStart = paths[1].match(/^M ([\d.]+) ([\d.]+)/);

  assert.ok(firstEnd);
  assert.ok(secondStart);
  assert.ok(Number(secondStart[1]) > Number(firstEnd[1]));
  assert.ok(Number(secondStart[2]) < Number(firstEnd[2]));
});

test("route thumbnail overlays workout and GPS segment ranges in Leaflet colors", () => {
  const thumbnail = WorkoutThumbnailService.createThumbnailPayload({
    gpsTrackSegments: [
      [[49, 8], [49.1, 8.1], [49.2, 8.2]]
    ],
    segmentOverlays: [
      {
        segmenttype: "auto",
        segments: [[
          { lat: 49, lng: 8 },
          { lat: 49.1, lng: 8.1 }
        ]]
      },
      {
        segmenttype: "gps",
        segments: [[
          { lat: 49.1, lng: 8.1 },
          { lat: 49.2, lng: 8.2 }
        ]]
      },
      {
        segmenttype: "crit",
        segments: [[
          { lat: 49.05, lng: 8.05 },
          { lat: 49.15, lng: 8.15 }
        ]]
      },
      {
        segmenttype: "manual",
        segments: [[
          { lat: 49.02, lng: 8.02 },
          { lat: 49.12, lng: 8.12 }
        ]]
      }
    ]
  });

  assert.match(thumbnail.content, /data-segment-type="auto"[^>]+stroke="#2587df"/);
  assert.match(thumbnail.content, /data-segment-type="gps"[^>]+stroke="#22a957"/);
  assert.match(thumbnail.content, /data-segment-type="crit"[^>]+stroke="#f59e0b"/);
  assert.match(thumbnail.content, /data-segment-type="manual"[^>]+stroke="#ef4444"/);
  assert.ok(
    thumbnail.content.indexOf('stroke="#ff4d4f"')
      < thumbnail.content.indexOf('data-segment-type="auto"')
  );
  assert.doesNotMatch(thumbnail.content, /data-segment-label|<text/);
  assert.match(thumbnail.content, /data-thumbnail-style="3"/);
  assert.equal(WorkoutThumbnailService.isCurrentRouteThumbnail({ ...thumbnail, updatedAt: new Date() }), true);
});

test("fallbacks retry after five minutes while successful maps and profiles remain cached", () => {
  const now = Date.parse("2026-11-04T16:00:00Z");
  const fallback = {
    ...WorkoutThumbnailService.createThumbnailPayload({ gpsTrack: [[49, 8], [49.1, 8.1]] }),
    updatedAt: new Date(now - 299999).toISOString()
  };
  assert.equal(WorkoutThumbnailService.isCurrentRouteThumbnail(fallback, now), true);
  assert.equal(WorkoutThumbnailService.isCurrentRouteThumbnail(fallback, now + 1), false);
  assert.equal(WorkoutThumbnailService.getThumbnailCacheControl(fallback), "private, max-age=60");
  const map = { ...fallback, content: fallback.content.replace("<svg ", '<svg data-map-provider="geoapify" ') };
  assert.equal(WorkoutThumbnailService.isCurrentRouteThumbnail(map, now + 365 * 86400000), true);
  assert.equal(WorkoutThumbnailService.getThumbnailCacheControl(map), "private, max-age=31536000, immutable");
  assert.equal(WorkoutThumbnailService.getThumbnailCacheControl({ kind: "metrics-profile" }), "private, max-age=31536000, immutable");
});

test("only stale route thumbnails require regeneration", () => {
  assert.equal(WorkoutThumbnailService.isCurrentRouteThumbnail({
    kind: "route",
    content: "<svg></svg>"
  }), false);
  assert.equal(WorkoutThumbnailService.isCurrentRouteThumbnail({
    kind: "metrics-profile",
    content: "<svg></svg>"
  }), true);
});

test("route thumbnail removes sub-pixel GPS points while preserving endpoints", () => {
  const gpsTrack = Array.from({ length: 101 }, (_, index) => [
    49 + (index / 1000),
    8 + (index / 1000)
  ]);
  const thumbnail = WorkoutThumbnailService.createThumbnailPayload({ gpsTrack });

  assert.equal(thumbnail.renderStats.routeInputPointCount, 101);
  assert.equal(thumbnail.renderStats.routeRenderedPointCount, 2);
  assert.match(
    thumbnail.content,
    /<path d="M [\d.]+ [\d.]+ L [\d.]+ [\d.]+" fill="none" stroke="#ff4d4f"/
  );
});

test("indoor thumbnail renders power, heart rate, and cadence without altitude or GPS", () => {
  const workoutObject = {
    length: 240,
    getAltitudeAt: (index) => 400 + (index % 5),
    getPowerAt: (index) => 180 + (index % 40),
    getHrAt: (index) => 130 + (index % 15),
    getCadenceAt: (index) => 80 + (index % 10)
  };
  const thumbnail = WorkoutThumbnailService.createThumbnailPayload({
    workoutType: "indoor",
    gpsTrack: [[49, 8], [50, 9]],
    workoutObject
  });

  assert.equal(thumbnail.kind, "indoor-profile");
  assert.match(thumbnail.content, /stroke="#2563eb"/);
  assert.match(thumbnail.content, /stroke="#16a34a"/);
  assert.match(thumbnail.content, /stroke="#f59e0b"/);
  assert.ok(thumbnail.content.indexOf('stroke="#f59e0b"') < thumbnail.content.indexOf('stroke="#16a34a"'));
  assert.ok(thumbnail.content.indexOf('stroke="#16a34a"') < thumbnail.content.indexOf('stroke="#2563eb"'));
  assert.match(thumbnail.content, /stroke="#2563eb" stroke-width="1\.5"/);
  assert.match(thumbnail.content, /stroke="#16a34a" stroke-width="1\.2"/);
  assert.match(thumbnail.content, /stroke="#f59e0b" stroke-width="1\.1"/);
  assert.doesNotMatch(thumbnail.content, /stroke="#dc2626"/);
  assert.doesNotMatch(thumbnail.content, /rgba\(15, 118, 110/);
});

test("workout without GPS uses the compact metrics thumbnail", () => {
  const workoutObject = {
    length: 120,
    getAltitudeAt: (index) => 300 + index,
    getPowerAt: (index) => 150 + (index % 50),
    getHrAt: (index) => 120 + (index % 20),
    getCadenceAt: (index) => 75 + (index % 15)
  };
  const thumbnail = WorkoutThumbnailService.createThumbnailPayload({
    workoutType: "unknown",
    workoutObject
  });

  assert.equal(thumbnail.kind, "metrics-profile");
  assert.match(thumbnail.content, /stroke="#2563eb"/);
  assert.match(thumbnail.content, /stroke="#16a34a"/);
  assert.match(thumbnail.content, /stroke="#f59e0b"/);
  assert.doesNotMatch(thumbnail.content, /stroke="#0f766e"/);
});
