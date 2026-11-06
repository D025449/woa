import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { readFile } from "node:fs/promises";

import WorkoutThumbnailService from "../src/services/workoutThumbnailService.js";
import { GeoapifyThumbnailClient } from "../src/services/geoapifyThumbnailService.js";
import GeoapifyThumbnailService from "../src/services/geoapifyThumbnailService.js";
import pool from "../src/services/database.js";
import LocalThumbnailMapService from "../src/services/localThumbnailMapService.js";
import { selectGpsBenchmarkSample, createGpsBenchmarkConnection, compareGpsThumbnailPixels } from "../src/scripts/benchmark-gps-thumbnails.js";
import { buildGpsProfileComparison, buildComparisonPage, buildBandProfileThumbnail, buildSegmentProfilePreview } from "../src/scripts/preview-gps-profile-thumbnails.js";
import { load } from "cheerio";

test("non-GPS segment preview reuses band time extent and excludes unapproved types", async () => {
  const metric = WorkoutThumbnailService.createBandProfileThumbnail({ powers: [100, 200, 150], heartRates: [120, 130, 140], speeds: [2, 3, 4] }).content;
  const selected = [
    { id: 1, segmenttype: "auto", structure_kind: "intervals", start_offset: 10, end_offset: 59,
      phases: [{ phase_kind: "work", start_offset: 10, end_offset: 39 }, { phase_kind: "recovery", start_offset: 40, end_offset: 59 }] },
    { id: 2, segmenttype: "manual", structure_kind: "microintervals", start_offset: 20, end_offset: 49,
      phases: [{ phase_kind: "work", start_offset: 20, end_offset: 39 }, { phase_kind: "recovery", start_offset: 40, end_offset: 49 }] },
    { id: 3, segmenttype: "manual", structure_kind: "simple", start_offset: -10, end_offset: 110 },
    ...["auto", "crit", "gps", "unknown"].map(segmenttype => ({ segmenttype, start_offset: 0, end_offset: 100 })),
    { segmenttype: "manual", rowstate: "DEL", start_offset: 0, end_offset: 100 },
    { segmenttype: "manual", start_offset: null, end_offset: 100 }
  ];
  const combined = buildSegmentProfilePreview(metric, selected, 101);
  const parsed = load(combined, { xml: true });
  assert.deepEqual(parsed("[data-segment-header]").map((_, element) => parsed(element).attr("data-segment-header")).get().sort(), ["intervals", "manual", "microintervals"]);
  assert.equal(parsed('[data-segment-area="manual"]').length, 3);
  assert.equal(parsed('[data-segment-area="manual"]').first().attr("x"), "18");
  assert.equal(parsed('[data-segment-area="manual"]').first().attr("width"), "220");
  assert.equal(parsed('[data-segment-area="intervals"]').first().attr("width"), "110");
  assert.equal(parsed('[data-band="speed"]').length, 1);
  assert.equal(parsed('[data-segment-lane="2"]').length, 1);
  const phases = load(buildSegmentProfilePreview(metric, selected, 101, { showPhases: true }), { xml: true });
  assert.equal(phases('[data-phase-opacity="0.28"]').length, 6);
  assert.equal(phases('[data-phase-opacity="0.04"]').length, 6);
  assert.equal(phases('[data-segment-area="manual"]').length, 3);
  assert.doesNotMatch(phases.xml(), /NaN|Infinity/);
  assert.equal(buildSegmentProfilePreview(metric, selected.slice(3), 101), metric);
  assert.equal(buildSegmentProfilePreview(metric, selected, 1), metric);
  const metadata = await sharp(Buffer.from(combined)).metadata();
  assert.equal(metadata.width, 256);
  assert.equal(metadata.height, 160);
  const page = buildComparisonPage([], { segments: true, segmentExamples: [{ id: 1, metric, combined, phases: phases.xml(), demo: true }] });
  assert.match(page, /Layout-Demo/);
  assert.equal((page.match(/data:image\/svg\+xml;base64,/g) || []).length, 6);
});

test("production thumbnail bands select altitude fallbacks and preserve constant valid heights", () => {
  const base = { powers: [100, 200, 150], heartRates: [120, 130, 140], speeds: [2, 3, 4] };
  const gps = WorkoutThumbnailService.createBandProfileThumbnail({ ...base, gps: true });
  assert.match(gps.content, /data-band="power"/);
  assert.match(gps.content, /data-band="heartRate"/);
  assert.doesNotMatch(gps.content, /data-band="speed"/);
  const flatGps = WorkoutThumbnailService.createBandProfileThumbnail({ ...base, gps: true, altitudes: [0, 0, 0] });
  assert.match(flatGps.content, /data-band="altitude"/);
  assert.doesNotMatch(flatGps.content, /data-band="heartRate"/);
  const indoor = WorkoutThumbnailService.createBandProfileThumbnail(base);
  assert.match(indoor.content, /data-band="power"/);
  assert.match(indoor.content, /data-band="heartRate"/);
  assert.match(indoor.content, /data-band="speed"/);
  const height = WorkoutThumbnailService.createBandProfileThumbnail({ ...base, altitudes: [-10, -10, -10] });
  assert.match(height.content, /data-band="altitude"/);
  assert.doesNotMatch(height.content, /data-band="speed"/);
  assert.doesNotMatch(height.content, /NaN|Infinity|stroke="#/);
  assert.equal(WorkoutThumbnailService.createBandProfileThumbnail({ altitudes: [NaN, NaN], powers: [0, 0] }), null);
});

test("standard thumbnail phases render for indoor and GPS without changing the route layers", async () => {
  const segments = [{ id: 1, segmenttype: "auto", structure_kind: "intervals", start_offset: 10, end_offset: 59,
    phases: [{ phase_kind: "work", start_offset: 10, end_offset: 39 }, { phase_kind: "recovery", start_offset: 40, end_offset: 59 }] },
    { segmenttype: "crit", start_offset: 10, end_offset: 59 }];
  const options = { powers: Array(101).fill(200), heartRates: Array(101).fill(130), speeds: Array(101).fill(5), segments };
  const indoor = WorkoutThumbnailService.createThumbnailPayload({ ...options, workoutType: "indoor" });
  assert.equal(indoor.kind, "indoor-profile");
  assert.equal(load(indoor.content, { xml: true })('[data-phase-opacity="0.28"]').length, 3);
  assert.match(indoor.content, /data-band="speed"/);
  assert.doesNotMatch(indoor.content, /data-segment-header="criticalPower"|data-preview/);
  const gps = await WorkoutThumbnailService.createThumbnailPayloadAsync({ ...options, gpsTrack: [[49, 8], [49.01, 8.01]] }, {
    renderRoute: async () => ({ kind: "route", mimeType: "image/svg+xml", width: 320, height: 200,
      content: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect/><image data-map-provider="local"/><circle id="endpoint"/><text y="188">OpenStreetMap contributors</text></svg>' })
  });
  const parsed = load(gps.content, { xml: true });
  assert.equal(parsed('[data-phase-opacity="0.28"]').length, 2);
  assert.equal(parsed('[data-phase-opacity="0.04"]').length, 2);
  assert.equal(parsed('[data-route-profile-bands]').length, 1);
  assert.equal(parsed('[data-route-profile-bands] rect[fill="#f8fafc"]').length, 0);
  assert.ok(gps.content.indexOf('data-route-profile-bands') > gps.content.indexOf('data-map-provider'));
  assert.ok(gps.content.indexOf('data-route-profile-bands') < gps.content.indexOf('id="endpoint"'));
  assert.match(gps.content, /OpenStreetMap contributors/);
  assert.doesNotMatch(gps.content, /NaN|Infinity|data-segment-header="criticalPower"/);
});

test("thumbnail segment loading scopes parents by owner and reads ordered stored phases", async () => {
  const rows = [{ id: 1, structure_kind: "intervals", phases: [{ position: 0, phase_kind: "work" }] }];
  let query;
  let parameters;
  const result = await WorkoutThumbnailService.loadWorkoutSegmentsForThumbnail(123, "owner", {
    async query(sql, values) { query = sql; parameters = values; return { rows }; }
  });
  assert.equal(result, rows);
  assert.deepEqual(parameters, [123, "owner"]);
  assert.match(query, /ws\.wid = \$1 AND ws\.uid = \$2/);
  assert.match(query, /ORDER BY phase\.position/);
  assert.match(query, /phase\.segment_id = ws\.id/);
  assert.doesNotMatch(query, /INSERT|UPDATE|DELETE/i);
});

test("GPS band preview fills separate power and altitude bands without data outlines", async () => {
  const metric = '<svg><path stroke="#2563eb" d="M 18 134 L 238 18"/></svg>';
  const altitude = '<svg><path stroke="none" d="M 14 90 L 242 30 L 242 146 L 14 146 Z"/></svg>';
  const bands = buildBandProfileThumbnail(metric, altitude);
  assert.match(bands, /data-band="power"/);
  assert.match(bands, /data-band="altitude"/);
  assert.match(bands, /fill="#2563eb" fill-opacity="0.26" stroke="none"/);
  assert.match(bands, /fill="#38bdf8" fill-opacity="0.3" stroke="none"/);
  assert.ok(bands.includes(`translate(18 0) scale(${220 / 228} 1) translate(-14 0)`));
  const route = '<svg><image data-map-provider="local"/><circle id="endpoint"/></svg>';
  const combined = buildGpsProfileComparison(route, bands, { bands: true });
  assert.match(combined, /data-preview-profile="bands"/);
  assert.match(combined, /fill="#ffffff" fill-opacity="0.6"/);
  assert.doesNotMatch(combined, /data-band-label/);
  assert.ok(combined.indexOf('data-preview-profile') < combined.indexOf('id="endpoint"'));
  assert.throws(() => buildBandProfileThumbnail('<svg/>', altitude), /Power and altitude profiles required/);
});

test("GPS profile preview reuses metric curves below route markers and outside attribution", async () => {
  const route = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><image data-map-provider="local"/><circle id="endpoint"/><text y="188">OpenStreetMap contributors</text></svg>';
  const metric = '<svg xmlns="http://www.w3.org/2000/svg"><rect/><path stroke="#2563eb" d="M 18 90 L 238 20"/><path stroke="#cbd5e1"/><text>PWR</text></svg>';
  const combined = buildGpsProfileComparison(route, metric);
  assert.match(combined, /data-preview-profile="metrics"/);
  assert.match(combined, /fill="#ffffff" fill-opacity="0.88"/);
  assert.ok(combined.indexOf('data-preview-profile') < combined.indexOf('id="endpoint"'));
  assert.match(combined, /y="128".*height="48"/);
  assert.match(combined, /vector-effect="non-scaling-stroke"/);
  assert.doesNotMatch(combined, /#cbd5e1|PWR/);
  assert.match(combined, /OpenStreetMap contributors/);
  const page = buildComparisonPage([{ id: 1, route, combined, metric }]);
  assert.equal((page.match(/data:image\/svg\+xml;base64,/g) || []).length, 6);
  assert.throws(() => buildGpsProfileComparison('<svg/>', metric), /Local map background required/);
});

test("GPS benchmark pixel comparison detects changed colors, alpha and dimensions", async () => {
  const image = (color, opacity = 1, width = 2) => `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="2"><rect width="2" height="2" fill="${color}" opacity="${opacity}"/></svg>`;
  const reference = image("#ff0000");
  const same = await compareGpsThumbnailPixels(reference, reference);
  assert.equal(same.identicalPixels, true);
  assert.equal(same.identicalSvg, true);
  assert.equal(same.referencePixelHash, same.candidatePixelHash);
  for (const changed of [image("#00ff00"), image("#ff0000", 0.5), image("#ff0000", 1, 3)]) {
    assert.equal((await compareGpsThumbnailPixels(reference, changed)).identicalPixels, false);
  }
});

test("GPS benchmark samples track sizes without duplicates and writes only a verified temporary thumbnail table", async () => {
  const rows = Array.from({ length: 10 }, (_, index) => ({ id: index + 1 }));
  assert.deepEqual(selectGpsBenchmarkSample(rows, 3).map(row => row.id), [1, 6, 10]);
  assert.deepEqual(selectGpsBenchmarkSample(rows.slice(0, 2), 6).map(row => row.id), [1, 2]);
  const statements = [];
  const connection = await createGpsBenchmarkConnection({ async connect() { return {
    async query(sql, values) { statements.push({ sql, values }); return { rows: sql.includes("to_regclass") ? [{ isolated: true }] : [] }; },
    release() { statements.push({ sql: "RELEASE" }); }
  }; } }, "fixture");
  await connection.query("BEGIN");
  await connection.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", ["woa:thumbnail:1"]);
  await connection.query("COMMIT");
  connection.release();
  assert.match(statements[1].sql, /CREATE TEMP TABLE workout_thumbnails/);
  assert.match(statements[1].sql, /ON COMMIT DROP/);
  assert.doesNotMatch(statements[1].sql, /serial|nextval|LIKE|public\./i);
  assert.match(statements[3].values[0], /^woa:gps-benchmark:fixture:/);
  assert.equal(statements.at(-2).sql, "COMMIT");
});

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
  for (const key of ["generationQueueMs", "dbConnectionWaitMs", "transactionBeginMs", "advisoryLockMs", "lockedLookupMs",
    "payloadCreateMs", "persistThumbnailMs", "dbConnectionHeldMs", "generationEndToEndMs"]) {
    assert.ok(Number.isFinite(first.generationProfile[key]) && first.generationProfile[key] >= 0, key);
  }
  assert.ok(first.generationProfile.dbConnectionHeldMs >= first.generationProfile.payloadCreateMs);
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

test("indoor thumbnail renders power, heart rate, and altitude bands without GPS", () => {
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
  assert.match(thumbnail.content, /data-band="power"/);
  assert.match(thumbnail.content, /data-band="heartRate"/);
  assert.match(thumbnail.content, /data-band="altitude"/);
  assert.ok(thumbnail.content.indexOf('data-band="power"') < thumbnail.content.indexOf('data-band="heartRate"'));
  assert.ok(thumbnail.content.indexOf('data-band="heartRate"') < thumbnail.content.indexOf('data-band="altitude"'));
  assert.doesNotMatch(thumbnail.content, /data-band="cadence"|stroke="#/);
});

test("workout without GPS uses metric bands", () => {
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
  assert.match(thumbnail.content, /data-band="power"/);
  assert.match(thumbnail.content, /data-band="heartRate"/);
  assert.match(thumbnail.content, /data-band="altitude"/);
  assert.doesNotMatch(thumbnail.content, /data-band="cadence"|stroke="#/);
});

test("GPS band integration keeps map and attribution, fills missing altitude with HR and avoids duplicate overlays", async () => {
  const options = { gpsTrack: [[49, 8], [49.01, 8.01]], powers: [100, 200, 150], heartRates: [120, 130, 125] };
  const result = await WorkoutThumbnailService.createThumbnailPayloadAsync(options, { renderRoute: async () => ({
    kind: "route", width: 320, height: 200, mimeType: "image/svg+xml",
    content: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200"/><image data-map-provider="local"/><circle id="endpoint"/><text y="188">OpenStreetMap contributors</text></svg>'
  }) });
  assert.match(result.content, /data-band="power"/);
  assert.match(result.content, /data-band="heartRate"/);
  assert.match(result.content, /fill="#ffffff" fill-opacity="0.6"/);
  assert.match(result.content, /OpenStreetMap contributors/);
  assert.ok(result.content.indexOf('data-route-profile-bands') > result.content.indexOf('data-map-provider'));
  assert.ok(result.content.indexOf('data-route-profile-bands') < result.content.indexOf('id="endpoint"'));
  const fallback = await WorkoutThumbnailService.createThumbnailPayloadAsync(options, { renderRoute: async () => null });
  assert.equal((fallback.content.match(/data-route-profile-bands=/g) || []).length, 1);
  const missing = WorkoutThumbnailService.createThumbnailPayload({ workoutObject: {
    length: 3, getPowerAt: () => 100, getHrAt: () => 120, getAltitudeAt: () => null, getSpeedAt: () => 3
  } });
  assert.match(missing.content, /data-band="speed"/);
  assert.doesNotMatch(missing.content, /data-band="altitude"/);
});
