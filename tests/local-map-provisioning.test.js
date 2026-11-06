import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, readFile, writeFile, rename, chmod, stat, mkdir, symlink, open, utimes } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { PbfWriter } from "pbf";
import { spawnSync } from "node:child_process";
import { getMapDatabaseConfig, runMapCommand, formatMapCommandError, formatMapProgress } from "../src/scripts/prepare-local-maps.js";
import { getLocalMapCoverageBounds, project } from "../src/shared/localThumbnailMapViewport.js";
import { buildMapPlan as buildServiceMapPlan, readMapWorkoutBounds, discoverMapArchive, inspectMapArchive,
  prepareMapArchives, mapArchiveMetadata, compareMapArchiveMetadata } from "../src/services/localMapProvisioningService.js";
import { mapStorageLimit, MAP_STORAGE_MAX_BYTES, readMapStorageUsage, mapStorageCapacity,
  withMapStorageBudget, withMapStorageLock } from "../src/services/localMapStorageService.js";
import { readMapArchiveSet, mapArchiveSetIdentity } from "../src/services/localMapArchiveSetService.js";

test("archive metadata uses only strong bounded ETags and valid HTTP modification dates", () => {
  assert.deepEqual(mapArchiveMetadata(new Headers({ etag: '"version-1"', "last-modified": "Thu, 05 Nov 2026 10:00:00 GMT" })),
    { etag: '"version-1"', lastModified: "2026-11-05T10:00:00.000Z" });
  for (const etag of ['W/"weak"', "unquoted", `"${"a".repeat(257)}"`]) {
    assert.deepEqual(mapArchiveMetadata(new Headers({ etag, "last-modified": "invalid" })), { etag: null, lastModified: null });
  }
});

test("archive comparisons never treat size alone or first observations as installed-version proof", () => {
  const original = { url: "https://download.geofabrik.de/test.mbtiles", etag: '"one"', lastModified: null, bytes: 100 };
  assert.equal(compareMapArchiveMetadata(null, original), "unknown");
  assert.equal(compareMapArchiveMetadata(original, { ...original }), "unchanged");
  assert.equal(compareMapArchiveMetadata(original, { ...original, bytes: 200 }), "unknown");
  assert.equal(compareMapArchiveMetadata(original, { ...original, etag: '"two"' }), "changed");
  assert.equal(compareMapArchiveMetadata(original, { ...original, url: "https://download.geofabrik.de/other.mbtiles" }), "unknown");
  assert.equal(compareMapArchiveMetadata(original, { ...original, etag: null }), "unknown");
  assert.equal(compareMapArchiveMetadata({ ...original, etag: null }, { ...original, etag: null, bytes: 200 }), "unknown");
  const dated = { ...original, etag: null, lastModified: "2026-11-04T10:00:00.000Z" };
  assert.equal(compareMapArchiveMetadata(dated, { ...dated, lastModified: "2026-11-05T10:00:00.000Z" }), "changed");
});

test("update metadata discovery fetches only the official page and HEAD, never archive bytes", async () => {
  const calls = [];
  const archive = await discoverMapArchive(region("west", null, 7, 9), { includeMetadata: true,
    fetchFn: async (url, options) => {
      calls.push({ url, method: options.method || "GET", redirect: options.redirect });
      if (options.method === "HEAD") return new Response(null, { headers: { "content-length": "100", etag: '"revision"',
        "last-modified": "Thu, 05 Nov 2026 10:00:00 GMT" } });
      return new Response('<a href="west-shortbread-1.0.mbtiles">MBTiles</a>');
    } });
  assert.deepEqual(archive, { url: "https://download.geofabrik.de/west-shortbread-1.0.mbtiles", bytes: 100,
    etag: '"revision"', lastModified: "2026-11-05T10:00:00.000Z" });
  assert.deepEqual(calls.map(call => call.method), ["GET", "HEAD"]);
  assert.ok(calls.every(call => call.redirect === "error" && new URL(call.url).hostname === "download.geofabrik.de"));
});

test("global map storage is limited to fifty percent of total volume capacity and one hundred GiB", () => {
  assert.equal(mapStorageLimit(100 * 1024 ** 3), 50 * 1024 ** 3);
  assert.equal(mapStorageLimit(199 * 1024 ** 3), 99.5 * 1024 ** 3);
  assert.equal(mapStorageLimit(200 * 1024 ** 3), MAP_STORAGE_MAX_BYTES);
  assert.equal(mapStorageLimit(1000 * 1024 ** 3), MAP_STORAGE_MAX_BYTES);
  assert.equal(mapStorageLimit(1001), 500);
  for (const capacity of [0, -1, null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => mapStorageLimit(capacity), /capacity is unavailable/);
  }
});

test("map cleanup storage lock does not require capacity or evict cache", async () => {
  await temporary(async dataDirectory => {
    const config = { dataDirectory, cacheRoot: path.join(dataDirectory, "cache") };
    const namespace = path.join(config.cacheRoot, "a".repeat(20));
    await mkdir(namespace, { recursive: true });
    await writeFile(path.join(namespace, "1-1-1.json"), "keep");
    await withMapStorageLock(config, async () => {
      assert.ok((await readdir(dataDirectory)).includes(".maps-storage.lock"));
      assert.equal(await readFile(path.join(namespace, "1-1-1.json"), "utf8"), "keep");
    });
    assert.ok(!(await readdir(dataDirectory)).includes(".maps-storage.lock"));
    await writeFile(path.join(dataDirectory, ".maps-storage.lock"), "busy");
    await assert.rejects(withMapStorageLock(config, async () => assert.fail("must refuse")), /busy/);
  });
});

function region(id, parent, west, east) {
  return { type: "Feature", properties: { id, parent, name: id,
    urls: { pbf: `https://download.geofabrik.de/${id}-latest.osm.pbf` } },
  geometry: { type: "Polygon", coordinates: [[[west, 47], [east, 47], [east, 51], [west, 51], [west, 47]]] } };
}

test("separate map volumes retain individual limits and share one hundred GiB globally", () => {
  const gib = 1024 ** 3;
  const usage = { usedBytes: 90 * gib, cacheBytes: 0, limitBytes: 100 * gib, dataDevice: "data", cacheDevice: "cache",
    cacheEntries: [], volumes: [
      { device: "data", totalBytes: 200 * gib, freeBytes: 140 * gib, usedBytes: 60 * gib, limitBytes: mapStorageLimit(200 * gib) },
      { device: "cache", totalBytes: 60 * gib, freeBytes: 30 * gib, usedBytes: 30 * gib, limitBytes: mapStorageLimit(60 * gib) }
    ] };
  assert.equal(mapStorageCapacity(usage, 10 * gib).fits, true);
  assert.equal(mapStorageCapacity(usage, 11 * gib).fitsAfterCleanup, false);
  assert.equal(mapStorageCapacity(usage, 1, "cache").fits, false);
  usage.volumes[1].usedBytes += 1;
  assert.equal(mapStorageCapacity(usage, 0).fitsAfterCleanup, false);
});

test("shared storage counts nested roots, partials and rollback data once and trims only raster entries", async () => {
  await temporary(async dataDirectory => {
    const cacheRoot = path.join(dataDirectory, "cache");
    const namespace = path.join(cacheRoot, "a".repeat(20));
    await mkdir(namespace, { recursive: true });
    await writeFile(path.join(dataDirectory, "active.mbtiles"), Buffer.alloc(80));
    await writeFile(path.join(dataDirectory, "download.part"), Buffer.alloc(10));
    await mkdir(path.join(dataDirectory, "rollback"));
    await writeFile(path.join(dataDirectory, "rollback", "old.mbtiles"), Buffer.alloc(10));
    await writeFile(path.join(namespace, "1-1-1.json"), Buffer.alloc(100));
    await writeFile(path.join(namespace, "keep.part"), Buffer.alloc(5));
    const config = { dataDirectory, cacheRoot };
    const statfsFn = async () => ({ blocks: 600, bsize: 1, bavail: 1024 ** 3 });
    const usage = await readMapStorageUsage(config, { statfsFn });
    assert.equal(usage.usedBytes, 205);
    assert.equal(usage.cacheBytes, 100);
    assert.equal(usage.limitBytes, 300);
    assert.equal(mapStorageCapacity(usage, 150).fits, false);
    assert.equal(mapStorageCapacity(usage, 150).fitsAfterCleanup, true);
    await assert.rejects(withMapStorageBudget(config, 150, async () => assert.fail("no eviction allowed"),
      { statfsFn, allowCacheEviction: false }), /storage budget/);
    assert.equal(await readFile(path.join(namespace, "1-1-1.json"), "utf8"), Buffer.alloc(100).toString("utf8"));
    let written = false;
    await withMapStorageBudget(config, 150, async () => { written = true; }, { statfsFn });
    assert.equal(written, true);
    assert.deepEqual(await readdir(namespace), ["keep.part"]);
    assert.equal((await stat(path.join(dataDirectory, "active.mbtiles"))).size, 80);
    assert.equal((await stat(path.join(dataDirectory, "rollback", "old.mbtiles"))).size, 10);
    await assert.rejects(withMapStorageBudget(config, 200, async () => assert.fail("must refuse"), { statfsFn }), /budget/);
    assert.equal((await readdir(dataDirectory)).includes(".maps-storage.lock"), false);
    await symlink(path.join(dataDirectory, "active.mbtiles"), path.join(namespace, "2-2-2.json"));
    await assert.rejects(readMapStorageUsage(config, { statfsFn }), /Symbolic links/);
  });
});

test("preparation refuses a protected full budget before GET and preserves sparse rollback data", async () => {
  await temporary(async dataDirectory => {
    const cacheRoot = path.join(dataDirectory, "cache");
    const usage = await readMapStorageUsage({ dataDirectory, cacheRoot });
    const rollback = path.join(dataDirectory, "rollback");
    await mkdir(rollback);
    const filename = path.join(rollback, "protected.mbtiles");
    const file = await open(filename, "wx");
    try { await file.truncate(usage.limitBytes); } finally { await file.close(); }
    const plan = await buildMapPlan([workout], catalog, { dataDirectory, cacheRoot,
      resolveArchive: async feature => archive(feature) });
    assert.equal(plan.report.storage.fitsAfterCleanup, false);
    await assert.rejects(prepareMapArchives(plan, { fetchFn: async () => assert.fail("budget must reject before GET") }), /storage budget/);
    assert.equal((await stat(filename)).size, usage.limitBytes);
    assert.equal((await readdir(dataDirectory)).some(name => name.endsWith(".lock")), false);
  });
});

test("global cache cleanup evicts oldest tiles across source and style namespaces", async () => {
  await temporary(async dataDirectory => {
    const cacheRoot = path.join(dataDirectory, "cache");
    const oldest = path.join(cacheRoot, "a".repeat(20), "1-1-1.json");
    const newest = path.join(cacheRoot, "b".repeat(20), "1-1-1.json");
    for (const filename of [oldest, newest]) {
      await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(filename, Buffer.alloc(100));
    }
    await utimes(oldest, new Date(1000), new Date(1000));
    await writeFile(path.join(dataDirectory, "protected.mbtiles"), Buffer.alloc(80));
    await withMapStorageBudget({ dataDirectory, cacheRoot }, 100, async () => {},
      { statfsFn: async () => ({ blocks: 600, bsize: 1, bavail: 1024 ** 3 }) });
    await assert.rejects(stat(oldest), { code: "ENOENT" });
    assert.equal((await stat(newest)).size, 100);
  });
});

test("storage locking serializes local writers, rejects external locks and releases on failure", async () => {
  await temporary(async dataDirectory => {
    const config = { dataDirectory, cacheRoot: path.join(dataDirectory, "cache") };
    const order = [];
    await Promise.all([1, 2].map(value => withMapStorageBudget(config, 1, async () => {
      order.push(`start-${value}`);
      await writeFile(path.join(dataDirectory, `${value}.part`), "x");
      order.push(`end-${value}`);
    })));
    const first = order[0] === "start-1" ? 1 : 2;
    const second = first === 1 ? 2 : 1;
    assert.deepEqual(order, [`start-${first}`, `end-${first}`, `start-${second}`, `end-${second}`]);
    await assert.rejects(withMapStorageBudget(config, 0, async () => { throw new Error("probe"); }), /probe/);
    const lockPath = path.join(dataDirectory, ".maps-storage.lock");
    await writeFile(lockPath, "");
    await assert.rejects(withMapStorageBudget(config, 0, async () => assert.fail("must not run")), /storage is busy/);
    assert.equal((await stat(lockPath)).size, 0);
  });
});
const catalog = { type: "FeatureCollection", features: [region("country", null, 7, 11),
  region("west", "country", 7, 9.2), region("east", "country", 9.2, 11)] };
const workout = { id: 1, bounds: { minLng: 9.15, maxLng: 9.25, minLat: 48.7, maxLat: 48.8 }, has_thumbnail: false };
const archive = feature => ({ url: `https://download.geofabrik.de/${feature.properties.id}-shortbread-1.0.mbtiles`, bytes: 100 });

test("automatic demand never escalates unavailable leaf regions to larger parent downloads", async () => {
  await temporary(async dataDirectory => {
    const calls = [];
    const plan = await buildServiceMapPlan([workout, { ...workout, id: 2 }], catalog, {
      dataDirectory, cacheRoot: path.join(dataDirectory, "cache"), allowParentFallback: false,
      resolveArchive: async feature => {
        calls.push(feature.properties.id);
        return feature.properties.id === "west" ? null : archive(feature);
      }
    });
    assert.deepEqual(calls.sort(), ["east", "west"]);
    assert.equal(plan.report.readyToPrepare, false);
    assert.deepEqual(plan.report.unmappedWorkouts, [1, 2]);
    assert.deepEqual(plan.report.unsupportedRegions, [{ id: "west", name: "west", workouts: 2, missingThumbnails: 2 }]);
    assert.deepEqual(plan.report.archives.map(entry => entry.id), ["east"]);
  });
});

async function temporary(action) {
  const directory = await mkdtemp(path.join(tmpdir(), "woa-map-provision-"));
  try { await action(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test("automatic preparation refuses existing archives that become invalid after planning before any GET", async () => {
  await temporary(async directory => {
    const filename = path.join(directory, "west.mbtiles");
    await tinyArchive(filename, true);
    const plan = await buildMapPlan([workout], catalog, { dataDirectory: directory,
      resolveArchive: async feature => archive(feature) });
    await writeFile(filename, "corrupted after planning");
    await assert.rejects(prepareMapArchives(plan, { versioned: true, missingOnly: true,
      fetchFn: async () => assert.fail("automatic repair must never download") }), /cannot replace an existing archive/);
    assert.equal(await readFile(filename, "utf8"), "corrupted after planning");
  });
});

function buildMapPlan(workouts, regions, options) {
  return buildServiceMapPlan(workouts, regions, { cacheRoot: path.join(options.dataDirectory, "raster-cache"), ...options });
}

test("map planning uses complete edge tile coverage, leaf regions and cached discoveries", async () => {
  await temporary(async dataDirectory => {
    const calls = [];
    const result = await buildMapPlan([workout, { ...workout, id: 2, has_thumbnail: true }], catalog,
      { dataDirectory, resolveArchive: async feature => { calls.push(feature.properties.id); return archive(feature); } });
    assert.deepEqual(result.report.archives.map(entry => entry.id), ["east", "west"]);
    assert.deepEqual(calls.sort(), ["east", "west"]);
    assert.equal(result.report.archives[0].workouts, 2);
    assert.equal(result.report.archives[0].missingThumbnails, 1);
    assert.equal(result.report.downloadBytes, 200);
    assert.equal(result.report.readyToPrepare, true);
    assert.deepEqual(await readdir(dataDirectory), []);
  });
});

test("unavailable small extracts use a supported parent without redundant child downloads", async () => {
  await temporary(async dataDirectory => {
    const result = await buildMapPlan([workout], catalog, { dataDirectory,
      resolveArchive: async feature => feature.properties.id === "west" ? null : archive(feature) });
    assert.deepEqual(result.report.archives.map(entry => entry.id), ["country"]);
    assert.equal(result.report.archives[0].workouts, 1);
  });
});

test("an overlapping unavailable aggregate does not invalidate covered regional extracts", async () => {
  await temporary(async dataDirectory => {
    const overlapping = { ...catalog, features: [...catalog.features, region("aggregate", null, 7, 11)] };
    const result = await buildMapPlan([workout], overlapping, { dataDirectory,
      resolveArchive: async feature => feature.properties.id === "aggregate" ? null : archive(feature) });
    assert.equal(result.report.readyToPrepare, true);
    assert.deepEqual(result.report.unmappedWorkouts, []);
    const incomplete = await buildMapPlan([workout], overlapping, { dataDirectory,
      resolveArchive: async feature => feature.properties.id === "east" ? archive(feature) : null });
    assert.equal(incomplete.report.readyToPrepare, false);
    assert.deepEqual(incomplete.report.unmappedWorkouts, [1]);
  });
});

test("missing and unsupported bounding boxes and unmapped workouts prevent preparation", async () => {
  await temporary(async dataDirectory => {
    const result = await buildMapPlan([{ ...workout, bounds: null },
      { ...workout, id: 2, bounds: { ...workout.bounds, minLng: -179, maxLng: 179 } },
      { ...workout, id: 3, bounds: { minLng: 140, maxLng: 141, minLat: 35, maxLat: 36 } }], catalog,
      { dataDirectory, resolveArchive: async feature => archive(feature) });
    assert.deepEqual(result.report.missingBounds, [1]);
    assert.deepEqual(result.report.unsupportedBounds, [2]);
    assert.deepEqual(result.report.unmappedWorkouts, [3]);
    assert.equal(result.report.readyToPrepare, false);
    await assert.rejects(prepareMapArchives(result), /Incomplete map plan/);
  });
});

test("database inventory uses only SELECT in an explicit read-only transaction", async () => {
  const statements = [];
  const client = { async query(sql) { statements.push(sql); return { rows: [workout] }; } };
  assert.deepEqual(await readMapWorkoutBounds(client), [workout]);
  assert.equal(statements[0], "BEGIN READ ONLY");
  assert.match(statements[2], /^SELECT w.id/);
  assert.match(statements[2], /center\(w.gps_bounds\)/);
  assert.equal(statements.at(-1), "COMMIT");
  assert.ok(statements.every(sql => !/INSERT|UPDATE|DELETE|CREATE|ALTER|DROP/.test(sql)));
});

test("official HTML links are parsed and external download URLs rejected", async () => {
  const feature = catalog.features[1];
  const result = await discoverMapArchive(feature, { fetchFn: async (_url, options) => options.method === "HEAD"
    ? new Response(null, { headers: { "content-length": "123" } })
    : new Response('<a href="west-shortbread-1.0.mbtiles">Map</a>') });
  assert.equal(result.bytes, 123);
  assert.equal(result.url, "https://download.geofabrik.de/west-shortbread-1.0.mbtiles");
  await assert.rejects(discoverMapArchive(feature, { fetchFn: async () =>
    new Response('<a href="https://untrusted.invalid/west-shortbread-1.0.mbtiles">Map</a>') }), /Invalid Geofabrik URL/);
});

async function tinyArchive(filename, coverWorkout = false) {
  const database = new DatabaseSync(filename);
  database.exec("CREATE TABLE metadata(name TEXT,value TEXT); CREATE TABLE tiles(zoom_level INTEGER,tile_column INTEGER,tile_row INTEGER,tile_data BLOB);");
  database.prepare("INSERT INTO metadata VALUES('format','pbf')").run();
  const writer = new PbfWriter();
  writer.writeMessage(3, (_, layer) => {
    layer.writeStringField(1, "land");
    layer.writeMessage(2, (_value, feature) => {
      feature.writeVarintField(3, 1);
      feature.writePackedVarint(4, [9, 4096, 4096]);
    }, null);
    layer.writeVarintField(5, 4096);
    layer.writeVarintField(15, 2);
  }, null);
  const tile = writer.finish();
  const insert = database.prepare("INSERT INTO tiles VALUES(?,?,?,?)");
  if (coverWorkout) {
    const coverage = getLocalMapCoverageBounds(workout.bounds);
    const count = 2 ** coverage.zoom;
    const [minX, minY] = project([coverage.minLng, coverage.maxLat]);
    const [maxX, maxY] = project([coverage.maxLng, coverage.minLat]);
    for (let tileX = Math.round(minX * count); tileX < Math.round(maxX * count); tileX++) {
      for (let tileY = Math.round(minY * count); tileY < Math.round(maxY * count); tileY++) {
        insert.run(coverage.zoom, tileX, count - 1 - tileY, tile);
      }
    }
  } else insert.run(0, 0, 0, tile);
  database.close();
  return readFile(filename);
}

test("sample inspection skips only the SQLite integrity scan and retains format checks", async context => {
  await temporary(async directory => {
    const filename = path.join(directory, "east.mbtiles");
    await tinyArchive(filename);
    const queries = [];
    const prepare = DatabaseSync.prototype.prepare;
    context.mock.method(DatabaseSync.prototype, "prepare", function (sql) {
      queries.push(sql);
      return prepare.call(this, sql);
    });
    assert.equal((await inspectMapArchive(filename, { fullIntegrityCheck: false })).valid, true);
    assert.equal(queries.includes("PRAGMA quick_check"), false);
    assert.ok(queries.some(sql => sql.includes("metadata")));
    assert.ok(queries.some(sql => sql.includes("tile_data")));
    assert.equal((await inspectMapArchive(filename)).valid, true);
    assert.equal(queries.filter(sql => sql === "PRAGMA quick_check").length, 1);
    const database = new DatabaseSync(filename);
    database.exec("UPDATE metadata SET value='png' WHERE name='format'");
    database.close();
    assert.equal((await inspectMapArchive(filename, { fullIntegrityCheck: false })).valid, false);
  });
});

test("sample plans cannot bypass full archive inspections during preparation", async () => {
  await temporary(async dataDirectory => {
    for (const id of ["east", "west"]) await tinyArchive(path.join(dataDirectory, `${id}.mbtiles`), true);
    const plan = await buildMapPlan([workout], catalog, { dataDirectory, inspectionMode: "sample",
      resolveArchive: async feature => archive(feature) });
    assert.equal(plan.report.inspectionMode, "sample");
    assert.ok(plan.report.archives.every(entry => entry.existingValid && !entry.integrityChecked));
    const calls = [];
    const prepared = await prepareMapArchives(plan, { inspectArchive: async filename => {
      calls.push(filename);
      return inspectMapArchive(filename);
    }, fetchFn: async () => assert.fail("must reuse valid archives") });
    assert.equal(calls.length, 2);
    assert.deepEqual(prepared.reused, ["east", "west"]);
    assert.equal(prepared.readyToActivate, true);
  });
});

test("a refreshed archive size cannot exceed the shared budget or trigger another GET", async () => {
  await temporary(async directory => {
    const body = await tinyArchive(path.join(directory, "fixture"));
    const dataDirectory = path.join(directory, "maps");
    const cacheRoot = path.join(directory, "cache");
    await mkdir(dataDirectory);
    const usage = await readMapStorageUsage({ dataDirectory, cacheRoot });
    const protectedFile = path.join(dataDirectory, "rollback.bin");
    const file = await open(protectedFile, "wx");
    try { await file.truncate(usage.limitBytes - 2 * body.length); } finally { await file.close(); }
    const plan = await buildMapPlan([workout], catalog, { dataDirectory, cacheRoot,
      resolveArchive: async feature => ({ ...archive(feature), bytes: body.length }) });
    assert.equal(plan.report.storage.fits, true);
    const calls = [];
    await assert.rejects(prepareMapArchives(plan, { fetchFn: async (_url, options) => {
      calls.push(options.method || "GET");
      return new Response(options.method === "HEAD" ? null : body,
        { headers: { "content-length": String(body.length + 1) } });
    } }), /storage budget/);
    assert.deepEqual(calls, ["GET", "HEAD"]);
    assert.deepEqual(await readdir(dataDirectory), ["rollback.bin"]);
    assert.equal((await stat(protectedFile)).size, usage.limitBytes - 2 * body.length);
  });
});

test("prepare validates and atomically installs archives, then reuses without GET", async () => {
  await temporary(async directory => {
    const body = await tinyArchive(path.join(directory, "fixture"));
    const dataDirectory = path.join(directory, "maps");
    const result = await buildMapPlan([workout], catalog, { dataDirectory,
      resolveArchive: async feature => ({ ...archive(feature), bytes: body.length }) });
    let calls = 0;
    const prepared = await prepareMapArchives(result, { fetchFn: async () => {
      calls++; return new Response(body, { headers: { "content-length": String(body.length) } });
    } });
    assert.equal(calls, 2);
    assert.deepEqual(prepared.created, ["east", "west"]);
    assert.deepEqual(prepared.uncoveredWorkouts, [1]);
    assert.equal(prepared.readyToActivate, false);
    assert.equal((await inspectMapArchive(path.join(dataDirectory, "east.mbtiles"))).valid, true);
    const repeated = await prepareMapArchives(result, { fetchFn: async () => assert.fail("must reuse valid archive") });
    assert.deepEqual(repeated.reused, ["east", "west"]);
    assert.deepEqual((await readdir(dataDirectory)).sort(), ["east.mbtiles", "west.mbtiles"]);
  });
});

test("unchanged valid planned archives are fully inspected once and only stat-checked under the lock", async () => {
  await temporary(async dataDirectory => {
    await tinyArchive(path.join(dataDirectory, "east.mbtiles"), true);
    await tinyArchive(path.join(dataDirectory, "west.mbtiles"), true);
    const inspected = [];
    const inspectArchive = async filename => {
      inspected.push(filename);
      return inspectMapArchive(filename);
    };
    const plan = await buildMapPlan([workout], catalog, { dataDirectory, inspectArchive,
      resolveArchive: async feature => archive(feature) });
    assert.equal(inspected.length, 2);
    const progress = [];
    const result = await prepareMapArchives(plan, { inspectArchive, onProgress: event => progress.push(event),
      fetchFn: async () => assert.fail("must reuse valid archives") });
    assert.equal(inspected.length, 2);
    assert.deepEqual(result.reused, ["east", "west"]);
    assert.equal(result.readyToActivate, true);
    assert.equal(progress.filter(event => event.phase === "check-file-state").length, 2);
    assert.equal(progress.some(event => event.phase === "inspect-required"), false);
  });
});

test("changed, replaced or removed planned files are fully rechecked before reuse or repair", async context => {
  for (const kind of ["rewrite", "replace", "remove", "corrupt", "metadata"]) await context.test(kind, async () => {
    await temporary(async dataDirectory => {
      const filename = path.join(dataDirectory, "east.mbtiles");
      const body = await tinyArchive(filename, true);
      await tinyArchive(path.join(dataDirectory, "west.mbtiles"), true);
      const plan = await buildMapPlan([workout], catalog, { dataDirectory,
        resolveArchive: async feature => ({ ...archive(feature), bytes: body.length }) });
      if (kind === "rewrite") await writeFile(filename, body);
      else if (kind === "replace") {
        const replacement = path.join(dataDirectory, "replacement");
        await writeFile(replacement, body);
        await rename(replacement, filename);
      } else if (kind === "remove") await rm(filename);
      else if (kind === "corrupt") await writeFile(filename, Buffer.alloc(body.length));
      else {
        const before = await stat(filename, { bigint: true });
        await chmod(filename, Number(before.mode & 0o777n) ^ 0o100);
        const after = await stat(filename, { bigint: true });
        assert.equal(after.mtimeNs, before.mtimeNs);
        assert.notEqual(after.ctimeNs, before.ctimeNs);
      }
      const inspected = [];
      let gets = 0;
      const result = await prepareMapArchives(plan, { inspectArchive: async current => {
        inspected.push(current);
        return inspectMapArchive(current);
      }, fetchFn: async () => {
        gets++;
        return new Response(body, { headers: { "content-length": String(body.length) } });
      } });
      const repaired = kind === "remove" || kind === "corrupt";
      assert.equal(inspected[0], filename);
      assert.equal(inspected.length, repaired ? 2 : 1);
      if (repaired) assert.match(inspected[1], /east\.mbtiles\..+\.part$/);
      assert.equal(gets, repaired ? 1 : 0);
      assert.deepEqual(result.created, repaired ? ["east"] : []);
      assert.deepEqual(result.reused, repaired ? ["west"] : ["east", "west"]);
      assert.equal(result.readyToActivate, true);
      assert.deepEqual(await readFile(filename), body);
      assert.deepEqual((await readdir(dataDirectory)).sort(), ["east.mbtiles", "west.mbtiles"]);
    });
  });
});

test("serialized plans cannot reuse private in-process inspection results", async () => {
  await temporary(async dataDirectory => {
    await tinyArchive(path.join(dataDirectory, "east.mbtiles"), true);
    await tinyArchive(path.join(dataDirectory, "west.mbtiles"), true);
    const plan = await buildMapPlan([workout], catalog, { dataDirectory,
      resolveArchive: async feature => archive(feature) });
    const serialized = JSON.stringify(plan);
    assert.doesNotMatch(serialized, /fingerprint/);
    const inspected = [];
    const result = await prepareMapArchives(JSON.parse(serialized), { inspectArchive: async filename => {
      inspected.push(filename);
      return inspectMapArchive(filename);
    }, fetchFn: async () => assert.fail("must reuse valid archives after full check") });
    assert.deepEqual(inspected.map(filename => path.basename(filename)), ["east.mbtiles", "west.mbtiles"]);
    assert.equal(result.readyToActivate, true);
  });
});

test("failed downloads remove their own temporary files and preserve existing content", async () => {
  await temporary(async dataDirectory => {
    await writeFile(path.join(dataDirectory, "east.mbtiles"), "old invalid content");
    const result = await buildMapPlan([workout], catalog, { dataDirectory, resolveArchive: async feature => archive(feature) });
    await assert.rejects(prepareMapArchives(result, { fetchFn: async () =>
      new Response(Buffer.alloc(100), { headers: { "content-length": "100" } }) }), /validation/);
    assert.equal(await readFile(path.join(dataDirectory, "east.mbtiles"), "utf8"), "old invalid content");
    assert.deepEqual(await readdir(dataDirectory), ["east.mbtiles"]);
  });
});

test("prepare confirms every viewport tile before reporting readiness", async () => {
  await temporary(async directory => {
    const body = await tinyArchive(path.join(directory, "fixture"), true);
    const plan = await buildMapPlan([workout], catalog, { dataDirectory: path.join(directory, "maps"),
      resolveArchive: async feature => ({ ...archive(feature), bytes: body.length }) });
    const result = await prepareMapArchives(plan, { fetchFn: async () =>
      new Response(body, { headers: { "content-length": String(body.length) } }) });
    assert.equal(result.readyToActivate, true);
    assert.deepEqual(result.uncoveredWorkouts, []);
  });
});

test("preparation respects existing locks and refuses insufficient disk space before GET", async () => {
  await temporary(async dataDirectory => {
    const plan = await buildMapPlan([workout], catalog, { dataDirectory,
      resolveArchive: async feature => ({ ...archive(feature), bytes: 10 ** 15 }) });
    const fetchFn = async () => assert.fail("must not download");
    await writeFile(path.join(dataDirectory, ".maps-prepare.lock"), "existing process");
    await assert.rejects(prepareMapArchives(plan, { fetchFn }), /already locked/);
    assert.equal(await readFile(path.join(dataDirectory, ".maps-prepare.lock"), "utf8"), "existing process");
    await rm(path.join(dataDirectory, ".maps-prepare.lock"));
    await assert.rejects(prepareMapArchives(plan, { fetchFn }), /Insufficient map disk/);
    assert.deepEqual(await readdir(dataDirectory), []);
  });
});

test("plans respect the renderer archive limit including unrelated existing files", async () => {
  await temporary(async dataDirectory => {
    for (let index = 0; index < 17; index++) await writeFile(path.join(dataDirectory, `${index}.mbtiles`), "fixture");
    const plan = await buildMapPlan([], catalog, { dataDirectory, inspectArchive: async () => ({ valid: true, bytes: 7 }) });
    assert.equal(plan.report.archiveCountAfterPrepare, 17);
    assert.equal(plan.report.readyToPrepare, false);
    await assert.rejects(prepareMapArchives(plan), /Incomplete map plan/);
  });
});

test("an empty GPS inventory cannot activate a renderer without any archives", async () => {
  await temporary(async dataDirectory => {
    const plan = await buildMapPlan([], catalog, { dataDirectory });
    const result = await prepareMapArchives(plan, { fetchFn: async () => assert.fail("no download needed") });
    assert.equal(result.readyToActivate, false);
    assert.deepEqual(result.created, []);
  });
});

test("changed download sizes cancel the body and leave no partial files", async () => {
  await temporary(async dataDirectory => {
    const plan = await buildMapPlan([workout], catalog, { dataDirectory, resolveArchive: async feature => archive(feature) });
    let cancelled = 0;
    let heads = 0;
    await assert.rejects(prepareMapArchives(plan, { fetchFn: async (_url, options) => {
      if (options.method === "HEAD") {
        heads++;
        return new Response(null, { headers: { "content-length": "100" } });
      }
      return new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { "content-length": "101" } });
    } }), error => {
      assert.match(error.message, /archive=east, http=200, expectedBytes=100, reportedBytes=101/);
      assert.match(error.message, /body=present, encoding=none, reason=size-mismatch/);
      assert.match(formatMapCommandError(error), /archive=east/);
      return true;
    });
    assert.equal(cancelled, 3);
    assert.equal(heads, 2);
    assert.deepEqual(await readdir(dataDirectory), []);
  });
});

test("archive response diagnostics distinguish HTTP, missing data and encoding without raw headers", async context => {
  const cases = [
    { name: "HTTP rejection", status: 503, headers: { "content-length": "100" }, expected: /http=503.*reason=http-status/ },
    { name: "missing length", headers: {}, expected: /reportedBytes=missing.*reason=missing-length/ },
    { name: "missing body", body: null, headers: { "content-length": "100" }, expected: /body=missing.*reason=missing-body/ },
    { name: "unexpected gzip", headers: { "content-length": "100", "content-encoding": "gzip" }, expected: /encoding=gzip, reason=content-encoding/ },
    { name: "unrecognized encoding", headers: { "content-length": "100", "content-encoding": "private-header-value" }, expected: /encoding=other, reason=content-encoding/ },
    { name: "invalid length", headers: { "content-length": "private-header-value" }, expected: /reportedBytes=invalid.*reason=size-mismatch/ }
  ];
  for (const entry of cases) await context.test(entry.name, async () => {
    await temporary(async dataDirectory => {
      const plan = await buildMapPlan([workout], catalog, { dataDirectory, resolveArchive: async feature => archive(feature) });
      await assert.rejects(prepareMapArchives(plan, { fetchFn: async () => new Response(entry.body === null ? null : "private-body-value",
        { status: entry.status || 200, headers: entry.headers }) }), error => {
        assert.match(error.message, entry.expected);
        assert.match(error.message, /archive=east/);
        assert.doesNotMatch(error.message, /private-header-value|private-body-value|https?:\/\//);
        return true;
      });
      assert.deepEqual(await readdir(dataDirectory), []);
    });
  });
});

test("changed archive sizes refresh HEAD and install only a matching validated response with progress", async () => {
  await temporary(async dataDirectory => {
    const body = await tinyArchive(path.join(dataDirectory, "west.mbtiles"), true);
    const progress = [];
    const onProgress = event => progress.push(event);
    const plan = await buildMapPlan(Array.from({ length: 101 }, (_, index) => ({ ...workout, id: index + 1 })), catalog,
      { dataDirectory, resolveArchive: async feature => archive(feature), onProgress });
    let gets = 0;
    let heads = 0;
    let cancelled = 0;
    const result = await prepareMapArchives(plan, { onProgress, fetchFn: async (_url, options) => {
      assert.equal(options.cache, "no-store");
      if (options.method === "HEAD") {
        heads++;
        return new Response(null, { headers: { "content-length": String(body.length) } });
      }
      gets++;
      return new Response(gets === 1 ? new ReadableStream({ cancel() { cancelled++; } }) : body,
        { headers: { "content-length": String(body.length) } });
    } });
    assert.equal(gets, 2);
    assert.equal(heads, 1);
    assert.equal(cancelled, 1);
    assert.deepEqual(result.created, ["east"]);
    assert.deepEqual(result.reused, ["west"]);
    assert.equal(result.readyToActivate, true);
    assert.deepEqual(await readFile(path.join(dataDirectory, "east.mbtiles")), body);
    assert.equal(plan.report.archives[0].downloadBytes, 100);
    assert.deepEqual(progress.filter(event => event.phase === "download-request").map(event => event.attempt), [1, 2]);
    for (const phase of ["discover-archive", "plan-bounds", "inspect-existing", "inspect-required", "reuse", "refresh-size", "verify-download", "installed"]) {
      assert.ok(progress.some(event => event.phase === phase), phase);
    }
    assert.deepEqual(progress.filter(event => event.phase === "download").map(event => event.bytes), [0, body.length]);
    assert.deepEqual(progress.filter(event => event.phase === "coverage").map(event => event.completed), [0, 100, 101]);
    assert.ok(progress.findIndex(event => event.phase === "verify-download") < progress.findIndex(event => event.phase === "installed"));
    assert.deepEqual((await readdir(dataDirectory)).sort(), ["east.mbtiles", "west.mbtiles"]);
  });
});

test("refreshed metadata cannot bypass encoding, size or available-space checks", async context => {
  const cases = [
    { name: "HTTP error", status: 503, headers: { "content-length": "101" }, expected: /size-mismatch/ },
    { name: "missing length", headers: {}, expected: /size-mismatch/ },
    { name: "invalid length", headers: { "content-length": "private-header-value" }, expected: /size-mismatch/ },
    { name: "unsafe length", headers: { "content-length": "9007199254740992" }, expected: /size-mismatch/ },
    { name: "encoded archive", headers: { "content-length": "101", "content-encoding": "gzip" }, expected: /size-mismatch/ },
    { name: "insufficient space", headers: { "content-length": "1000000000000000" }, expected: /Insufficient map disk/ }
  ];
  for (const entry of cases) await context.test(entry.name, async () => {
    await temporary(async dataDirectory => {
      const plan = await buildMapPlan([workout], catalog, { dataDirectory, resolveArchive: async feature => archive(feature) });
      let gets = 0;
      let heads = 0;
      await assert.rejects(prepareMapArchives(plan, { fetchFn: async (_url, options) => {
        if (options.method === "HEAD") {
          heads++;
          return new Response(null, { status: entry.status || 200, headers: entry.headers });
        }
        gets++;
        return new Response("changed", { headers: { "content-length": "101" } });
      } }), entry.expected);
      assert.equal(gets, 1);
      assert.equal(heads, 1);
      assert.deepEqual(await readdir(dataDirectory), []);
    });
  });
});

test("refreshed downloads still reject truncated, oversized and invalid SQLite content", async context => {
  for (const kind of ["truncated", "oversized", "invalid-sqlite"]) await context.test(kind, async () => {
    await temporary(async directory => {
      const body = await tinyArchive(path.join(directory, "fixture"));
      const dataDirectory = path.join(directory, "maps");
      const plan = await buildMapPlan([workout], catalog, { dataDirectory, resolveArchive: async feature => archive(feature) });
      let gets = 0;
      await assert.rejects(prepareMapArchives(plan, { fetchFn: async (_url, options) => {
        if (options.method === "HEAD") return new Response(null, { headers: { "content-length": String(body.length) } });
        gets++;
        const content = gets === 1 ? "changed" : kind === "truncated" ? body.subarray(0, -1)
          : kind === "oversized" ? Buffer.concat([body, Buffer.alloc(1)]) : Buffer.alloc(body.length);
        return new Response(content, { headers: { "content-length": String(body.length) } });
      } }), kind === "oversized" ? /exceeded planned size/ : /validation/);
      assert.equal(gets, 2);
      assert.deepEqual(await readdir(dataDirectory), []);
    });
  });
});

test("cancellation interrupts size refresh and cleans the preparation lock", async () => {
  await temporary(async dataDirectory => {
    const plan = await buildMapPlan([workout], catalog, { dataDirectory, resolveArchive: async feature => archive(feature) });
    const controller = new AbortController();
    let gets = 0;
    await assert.rejects(prepareMapArchives(plan, { signal: controller.signal, fetchFn: async (_url, options) => {
      if (options.method === "HEAD") {
        controller.abort();
        options.signal.throwIfAborted();
      }
      gets++;
      return new Response("changed", { headers: { "content-length": "101" } });
    } }), { name: "AbortError" });
    assert.equal(gets, 1);
    assert.deepEqual(await readdir(dataDirectory), []);
  });
});

test("progress formatting exposes phase, counters and percentages without unsafe archive names", () => {
  assert.equal(formatMapProgress({ phase: "download", archive: "europe/france/lorraine", bytes: 75, totalBytes: 100 }),
    "[maps] download archive=europe/france/lorraine 75/100 bytes (75.0%)");
  assert.equal(formatMapProgress({ phase: "download-request", archive: "east", attempt: 2 }),
    "[maps] download-request archive=east attempt=2/3");
  assert.equal(formatMapProgress({ phase: "coverage", completed: 100, total: 101 }), "[maps] coverage 100/101");
  assert.equal(formatMapProgress({ phase: "private-value\n", archive: "https://private-value" }), "[maps] progress archive=unknown");
});

test("CLI prepare keeps JSON on stdout and emits all progress on stderr without live services", async () => {
  await temporary(async directory => {
    const filename = path.join(directory, "fixture");
    const body = await tinyArchive(filename, true);
    const envFile = path.join(directory, ".env.development");
    await writeFile(envFile, `DB_NAME=fixture_db\nDB_USER=fixture_user\nWOA_MAP_DATA_DIR=${path.join(directory, "maps")}\nWOA_MAP_CACHE_DIR=${path.join(directory, "maps-cache")}\n`);
    const script = `import { readFile } from "node:fs/promises";
      import { DatabaseSync } from "node:sqlite";
      import { runMapCommand } from "./src/scripts/prepare-local-maps.js";
      const body = await readFile(${JSON.stringify(filename)});
      if (process.env.TEST_MAP_QUICK) {
        const prepare = DatabaseSync.prototype.prepare;
        DatabaseSync.prototype.prepare = function(sql) {
          if (sql === "PRAGMA quick_check") throw new Error("Full inspection must not run in quick mode");
          return prepare.call(this, sql);
        };
      }
      await runMapCommand([process.env.TEST_MAP_QUICK ? "plan" : "prepare", "--env-file", ${JSON.stringify(envFile)}, "--json",
        ...(process.env.TEST_MAP_QUICK ? ["--quick"] : []),
        ...(process.env.TEST_MAP_APPROVAL ? ["--approved-regions", process.env.TEST_MAP_APPROVAL] : [])], {
        clientFactory: () => ({ async connect() {}, async end() {}, async query() { return { rows: [${JSON.stringify(workout)}] }; } }),
        fetchFn: async (url, options) => {
          if (options.method === "HEAD") return new Response(null, { headers: { "content-length": "${body.length}" } });
          if (url.endsWith(".json")) return new Response(JSON.stringify(${JSON.stringify(catalog)}));
          if (url.endsWith(".html")) return new Response('<a href="' + url.replace(/\\.html$/, "-shortbread-1.0.mbtiles") + '">Map</a>');
          return new Response(body, { headers: { "content-length": "${body.length}" } });
        }
      });`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.preparation.readyToActivate, true);
    assert.deepEqual(report.preparation.created, ["east", "west"]);
    assert.doesNotMatch(result.stdout, /\[maps\]/);
    for (const phase of ["database-read", "catalog", "plan", "inspect-required", "download-request", "download", "verify-download", "installed", "coverage"]) {
      assert.match(result.stderr, new RegExp(`\\[maps\\] ${phase}`));
    }
    assert.match(result.stderr, /100\.0%/);
    const quick = spawnSync(process.execPath, ["--input-type=module", "-e", script],
      { encoding: "utf8", env: { ...process.env, TEST_MAP_QUICK: "1" } });
    assert.equal(quick.status, 0, quick.stderr);
    const quickReport = JSON.parse(quick.stdout);
    assert.equal(quickReport.inspectionMode, "sample");
    assert.ok(quickReport.archives.every(entry => entry.existingValid && !entry.integrityChecked));
    assert.equal(quickReport.downloadBytes, 0);
    assert.equal(quickReport.preparation, undefined);
    assert.doesNotMatch(quick.stderr, /\[maps\] (?:download-request|coverage)/);
    const rejected = spawnSync(process.execPath, ["--input-type=module", "-e", script],
      { encoding: "utf8", env: { ...process.env, TEST_MAP_APPROVAL: "unapproved-region" } });
    assert.equal(rejected.status, 0, rejected.stderr);
    await rm(path.join(directory, "maps"), { recursive: true });
    const blocked = spawnSync(process.execPath, ["--input-type=module", "-e", script],
      { encoding: "utf8", env: { ...process.env, TEST_MAP_APPROVAL: "west" } });
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /Map demand changed or approval invalid/);
    assert.equal(blocked.stdout, "");
    assert.doesNotMatch(blocked.stderr, /\[maps\] download-request/);
  });
});

test("real cleanup and retirement CLI commands require stored approval and never fetch upstream", async () => {
  await temporary(async directory => {
    await tinyArchive(path.join(directory, "west.mbtiles"), true);
    const envFile = path.join(directory, ".env.development");
    await writeFile(envFile, `DB_NAME=fixture_db\nDB_USER=fixture_user\nWOA_MAP_DATA_DIR=${directory}\nWOA_MAP_CACHE_DIR=${path.join(directory, "cache")}\n`);
    const script = `import { runMapCommand } from "./src/scripts/prepare-local-maps.js";
      await runMapCommand([process.env.TEST_MAP_COMMAND, "--env-file", ${JSON.stringify(envFile)}, "--json"], {
        clientFactory: () => ({ async connect() {
          if (process.env.TEST_MAP_COMMAND.startsWith("cleanup")) throw new Error("Cleanup must not connect to DB");
        }, async end() {}, async query() { return { rows: [] }; } }),
        fetchFn: async () => { throw new Error("No upstream requests allowed"); }
      });`;
    const run = (command, input = "") => spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8", input, env: { ...process.env, TEST_MAP_COMMAND: command }
    });
    const planned = run("retire-scan");
    assert.equal(planned.status, 0, planned.stderr);
    const retirement = JSON.parse(planned.stdout).retirement;
    assert.deepEqual(retirement.regions.map(region => region.id), ["west"]);
    const retired = run("retire", JSON.stringify({ snapshot: retirement, identity: retirement.identity }));
    assert.equal(retired.status, 0, retired.stderr);
    assert.deepEqual(JSON.parse(retired.stdout).lifecycle.retired, ["west"]);
    const protectedScan = run("cleanup-scan");
    assert.equal(protectedScan.status, 0, protectedScan.stderr);
    assert.deepEqual(JSON.parse(protectedScan.stdout).cleanup.files, []);
    await writeFile(path.join(directory, "orphan.mbtiles"), "old unused archive");
    const cleanupScan = run("cleanup-scan");
    assert.equal(cleanupScan.status, 0, cleanupScan.stderr);
    const cleanup = JSON.parse(cleanupScan.stdout).cleanup;
    const rejected = run("cleanup", JSON.stringify({ snapshot: cleanup, identity: "stale" }));
    assert.equal(rejected.status, 1);
    assert.ok((await readdir(directory)).includes("orphan.mbtiles"));
    const cleaned = run("cleanup", JSON.stringify({ snapshot: cleanup, identity: cleanup.identity }));
    assert.equal(cleaned.status, 0, cleaned.stderr);
    assert.equal(JSON.parse(cleaned.stdout).lifecycle.removedFiles, 1);
    assert.ok((await readdir(directory)).includes("west.mbtiles"));
    assert.ok(!(await readdir(directory)).includes("orphan.mbtiles"));
  });
});

test("import demand CLI persists manual demand, installs missing regions atomically and reuses them offline", async () => {
  await temporary(async directory => {
    const fixture = path.join(directory, "fixture");
    const body = await tinyArchive(fixture, true);
    const maps = path.join(directory, "maps");
    const envFile = path.join(directory, ".env.development");
    const script = `import { readFile } from "node:fs/promises";
      import { runMapCommand } from "./src/scripts/prepare-local-maps.js";
      const body = await readFile(${JSON.stringify(fixture)});
      await runMapCommand(["demand", "--env-file", ${JSON.stringify(envFile)}, "--json"], {
        clientFactory: () => ({ async connect() {}, async end() {}, async query() { return { rows: [${JSON.stringify(workout)}] }; } }),
        fetchFn: async (url, options) => {
          if (options.method === "HEAD") return new Response(null, { headers: { "content-length": String(body.length) } });
          if (url.endsWith(".json")) return new Response(JSON.stringify(${JSON.stringify(catalog)}));
          if (url.endsWith(".html")) return new Response('<a href="' + url.replace(/\\.html$/, "-shortbread-1.0.mbtiles") + '">Map</a>');
          if (process.env.TEST_REFUSE_DOWNLOAD) throw new Error("archive GET forbidden");
          return new Response(body, { headers: { "content-length": String(body.length) } });
        }
      });`;
    const configure = automatic => writeFile(envFile, `DB_NAME=fixture_db\nDB_USER=fixture_user\nWOA_THUMBNAIL_MAP_PROVIDER=local\nWOA_MAP_AUTO_DOWNLOAD=${automatic ? "1" : "0"}\nWOA_MAP_DATA_DIR=${maps}\nWOA_MAP_CACHE_DIR=${path.join(directory, "cache")}\n`);
    const run = refuse => spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8", env: { ...process.env, TEST_REFUSE_DOWNLOAD: refuse ? "1" : "" }
    });
    await configure(false);
    const manual = run(true);
    assert.equal(manual.status, 0, manual.stderr);
    assert.equal(JSON.parse(manual.stdout).demand.downloadState, "manual");
    assert.doesNotMatch(manual.stderr, /\[maps\] download-request/);
    assert.equal(readMapArchiveSet(maps).active.archives.length, 0);
    assert.equal(JSON.parse(await readFile(path.join(maps, "map-regional-demand.json"), "utf8")).report.regions.length, 2);
    await configure(true);
    const failed = run(true);
    assert.equal(failed.status, 1);
    assert.equal(JSON.parse(await readFile(path.join(maps, "map-regional-demand.json"), "utf8")).report.downloadState, "failed");
    assert.equal(readMapArchiveSet(maps).active.archives.length, 0);
    const automatic = run(false);
    assert.equal(automatic.status, 0, automatic.stderr);
    const demand = JSON.parse(automatic.stdout).demand;
    assert.equal(demand.downloadState, "available");
    assert.equal(demand.readyToActivate, true);
    assert.deepEqual(demand.regions.map(region => region.status), ["available", "available"]);
    assert.equal(readMapArchiveSet(maps).managed, true);
    assert.equal(readMapArchiveSet(maps).previous.archives.length, 0);
    assert.doesNotMatch(JSON.stringify(demand), /filename|https:|workoutId/);
    const reused = run(true);
    assert.equal(reused.status, 0, reused.stderr);
    assert.equal(JSON.parse(reused.stdout).demand.downloadBytes, 0);
    assert.doesNotMatch(reused.stderr, /\[maps\] download-request/);
    assert.equal(readMapArchiveSet(maps).active.archives.length, 2);
  });
});

test("lifecycle CLI consumes real bounded stdin and installs then rolls back without live services", async () => {
  await temporary(async directory => {
    const maps = path.join(directory, "maps");
    await mkdir(maps);
    const filename = path.join(maps, "west.mbtiles");
    const body = await tinyArchive(filename, true);
    const envFile = path.join(directory, ".env.development");
    await writeFile(envFile, `DB_NAME=fixture_db\nDB_USER=fixture_user\nWOA_MAP_DATA_DIR=${maps}\nWOA_MAP_CACHE_DIR=${path.join(directory, "cache")}\n`);
    const snapshot = { version: 1, report: { checkedAt: new Date().toISOString(), identity: mapArchiveSetIdentity(maps),
      regions: [{ id: "west", canInstall: true }] }, entries: { west: { current: {
      url: "https://download.geofabrik.de/west-shortbread-1.0.mbtiles", bytes: body.length, etag: '"approved"', lastModified: null } } } };
    const script = `import {readFile} from "node:fs/promises";
      import {runMapCommand} from "./src/scripts/prepare-local-maps.js";
      const body = await readFile(${JSON.stringify(filename)});
      await runMapCommand([process.env.TEST_MAP_ROLLBACK ? "rollback" : "install", "--env-file", ${JSON.stringify(envFile)}, "--json"], {
        clientFactory: () => ({async connect(){},async end(){},async query(){return {rows:[]};}}),
        fetchFn: async () => {if(process.env.TEST_MAP_ROLLBACK)throw new Error("rollback must not fetch");
          return new Response(body,{headers:{"content-length":String(body.length),etag:'"approved"'}});}
      });`;
    const installed = spawnSync(process.execPath, ["--input-type=module", "-e", script],
      { encoding: "utf8", input: JSON.stringify({ snapshot, approvedRegions: ["west"] }) });
    assert.equal(installed.status, 0, installed.stderr);
    assert.deepEqual(JSON.parse(installed.stdout).lifecycle.installed, ["west"]);
    assert.match(installed.stderr, /activate-set/);
    const manifest = readMapArchiveSet(maps);
    const rolledBack = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8",
      env: { ...process.env, TEST_MAP_ROLLBACK: "1" }, input: JSON.stringify({ expectedIdentity: mapArchiveSetIdentity(maps), previousSet: manifest.previous.id }) });
    assert.equal(rolledBack.status, 0, rolledBack.stderr);
    assert.equal(JSON.parse(rolledBack.stdout).lifecycle.rolledBack, true);
    assert.equal(readMapArchiveSet(maps).active.id, manifest.previous.id);
  });
});

test("CLI requires explicit environment selection before connecting or downloading", () => {
  const result = spawnSync(process.execPath, ["--", "src/scripts/prepare-local-maps.js", "plan"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /explicit --env-file/);
  assert.equal(result.stdout, "");
  const help = spawnSync(process.execPath, ["--", "src/scripts/prepare-local-maps.js", "prepare", "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: npm run maps:plan/);
  assert.match(help.stdout, /--quick/);
  const quickPrepare = spawnSync(process.execPath, ["--", "src/scripts/prepare-local-maps.js", "prepare",
    "--env-file", "not-read.env", "--quick"], { encoding: "utf8" });
  assert.equal(quickPrepare.status, 1);
  assert.match(quickPrepare.stderr, /prepare requires full archive checks/);
  assert.doesNotMatch(quickPrepare.stderr, /\[maps\]/);
});

test("standalone production config uses the same active database pointer as PM2", async () => {
  await temporary(async directory => {
    const pointer = path.join(directory, "active-database.env");
    await writeFile(pointer, "DB_NAME=cwa24_prod_restore_20261105_090000\n");
    const environment = { DB_NAME: "cwa24_prod", DB_USER: "fixture_user", DB_PASSWORD: "fixture-secret",
      BACKUP_ACTIVE_DATABASE_FILE: pointer };
    const config = getMapDatabaseConfig(environment, path.join(directory, ".env.production"));
    assert.equal(config.database, "cwa24_prod_restore_20261105_090000");
    assert.equal(config.host, "localhost");
    assert.equal(config.password, "fixture-secret");
    assert.equal(getMapDatabaseConfig(environment, ".env.development").database, "cwa24_prod");
    assert.equal(getMapDatabaseConfig({ ...environment, NODE_ENV: "production" }, "custom.env").database, config.database);
    assert.equal(getMapDatabaseConfig({ ...environment, BACKUP_ACTIVE_DATABASE_FILE: path.join(directory, "absent") }, ".env.production").database, "cwa24_prod");
  });
});

test("command resolves pointer before connect and exposes only safe stage/code on failure", async () => {
  await temporary(async directory => {
    const previous = { ...process.env };
    try {
      const pointer = path.join(directory, "active-database.env");
      const envFile = path.join(directory, ".env.production");
      await writeFile(pointer, "DB_NAME=cwa24_prod_restore_20261105_090000\n");
      await writeFile(envFile, `DB_NAME=cwa24_prod\nDB_USER=fixture_user\nDB_PASSWORD=fixture-secret\nBACKUP_ACTIVE_DATABASE_FILE=${pointer}\n`);
      let config;
      let closed = false;
      await assert.rejects(runMapCommand(["plan", "--env-file", envFile], { clientFactory: selected => {
        config = selected;
        return { async connect() { throw Object.assign(new Error("fixture-secret connection details"), { code: "3D000" }); },
          async end() { closed = true; } };
      } }), error => {
        assert.match(formatMapCommandError(error), /stage=database-connect, code=3D000/);
        assert.doesNotMatch(formatMapCommandError(error), /fixture-secret|connection details/);
        return true;
      });
      assert.equal(config.database, "cwa24_prod_restore_20261105_090000");
      assert.equal(closed, true);
      await assert.rejects(runMapCommand(["plan", "--env-file", envFile], { clientFactory: () => ({
        async connect() {}, async query() { throw Object.assign(new Error("fixture-secret"), { code: "42501" }); }, async end() {}
      }) }), error => {
        assert.match(formatMapCommandError(error), /stage=database-read, code=42501/);
        assert.doesNotMatch(formatMapCommandError(error), /fixture-secret/);
        return true;
      });
    } finally { process.env = previous; }
  });
});

test("diagnostics do not print arbitrary error codes, stages, messages or nested causes", () => {
  const result = formatMapCommandError({ stage: "fixture-secret", code: "fixture-secret", message: "fixture-secret" });
  assert.equal(result, "Map command failed [stage=arguments, code=UNKNOWN]");
  assert.equal(formatMapCommandError({ cause: { code: "ECONNREFUSED", message: "fixture-secret" } }),
    "Map command failed [stage=arguments, code=ECONNREFUSED]");
});

test("CLI diagnoses missing environment files and invalid pointers without exposing contents", async () => {
  await temporary(async directory => {
    const envFile = path.join(directory, ".env.production");
    const absent = spawnSync(process.execPath, ["--", "src/scripts/prepare-local-maps.js", "plan", "--env-file", envFile], { encoding: "utf8" });
    assert.equal(absent.status, 1);
    assert.match(absent.stderr, /stage=environment, code=ENOENT/);
    assert.equal(absent.stdout, "");
    const pointer = path.join(directory, "active-database.env");
    await writeFile(pointer, "DB_NAME=fixture-secret;invalid\n");
    await writeFile(envFile, `DB_NAME=cwa24_prod\nDB_USER=fixture_user\nDB_PASSWORD=fixture-secret\nBACKUP_ACTIVE_DATABASE_FILE=${pointer}\n`);
    const invalid = spawnSync(process.execPath, ["--", "src/scripts/prepare-local-maps.js", "plan", "--env-file", envFile], { encoding: "utf8" });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /stage=runtime-database, code=UNKNOWN/);
    assert.doesNotMatch(invalid.stderr, /fixture-secret|fixture_user/);
    assert.equal(invalid.stdout, "");
  });
});