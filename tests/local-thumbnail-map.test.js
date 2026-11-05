import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, readFile, writeFile, rm, rename, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";
import { EventEmitter } from "node:events";
import { PbfWriter } from "pbf";
import sharp from "sharp";
import { LocalMapRenderer, project } from "../src/services/localThumbnailMapRenderer.js";
import { LocalThumbnailMapClient } from "../src/services/localThumbnailMapService.js";
import { readMapArchiveSet, MAP_ARCHIVE_MANIFEST, activateMapArchiveSet, mapArchiveSetIdentity } from "../src/services/localMapArchiveSetService.js";
import { getLocalMapViewport, getLocalMapCoverageBounds } from "../src/shared/localThumbnailMapViewport.js";
import { prepareMapArchives } from "../src/services/localMapProvisioningService.js";
import { rollbackMapArchives, installMapArchiveUpdates, validateMapInstallation } from "../src/services/localMapLifecycleService.js";
import { checkLocalMapUpdates } from "../src/services/localMapUpdateService.js";

const example = { segments: [[[9.1, 48.72], [9.2, 48.78], [9.3, 48.8]]] };

test("installations require fresh exact approval and matching GET metadata before activation", async () => {
  await fixture(async config => {
    const body = await readFile(path.join(config.dataDirectory, "fixture.mbtiles"));
    const snapshot = { report: { checkedAt: new Date().toISOString(), identity: mapArchiveSetIdentity(config.dataDirectory),
      regions: [{ id: "fixture", canInstall: true }] }, entries: { fixture: { current: {
      url: "https://download.geofabrik.de/fixture-shortbread-1.0.mbtiles", bytes: body.length, etag: '"approved"', lastModified: null } } } };
    assert.throws(() => validateMapInstallation(snapshot, ["other"]), /approval/);
    assert.throws(() => validateMapInstallation(snapshot, ["fixture"], Date.now() + 3600001), /approval/);
    await assert.rejects(installMapArchiveUpdates(snapshot, ["fixture"], [], { config,
      fetchFn: async () => new Response(body, { headers: { "content-length": String(body.length), etag: '"changed"' } }) }), /differs/);
    assert.equal(readMapArchiveSet(config.dataDirectory).managed, false);
    await assert.rejects(installMapArchiveUpdates(snapshot, ["fixture"], [{ id: 1,
      bounds: { minLat: 0, maxLat: 0.1, minLng: 0, maxLng: 0.1 } }], { config,
      fetchFn: async () => new Response(body, { headers: { "content-length": String(body.length), etag: '"approved"' } }) }), /coverage/);
    assert.equal(readMapArchiveSet(config.dataDirectory).managed, false);
    const installed = await installMapArchiveUpdates(snapshot, ["fixture"], [], { config,
      fetchFn: async () => new Response(body, { headers: { "content-length": String(body.length), etag: '"approved"' } }) });
    assert.deepEqual(installed.installed, ["fixture"]);
    assert.equal(readMapArchiveSet(config.dataDirectory).active.id, installed.activeSet);
    const observed = await checkLocalMapUpdates(undefined, { dataDirectory: config.dataDirectory,
      catalogLoader: async () => ({ features: [{ properties: { id: "fixture", name: "Fixture" } }] }),
      resolveArchive: async () => snapshot.entries.fixture.current });
    assert.equal(observed.report.regions[0].installedVersion, "recorded");
    assert.equal(observed.report.regions[0].status, "unchanged");
    assert.equal(observed.report.regions[0].canInstall, false);
    await assert.rejects(installMapArchiveUpdates(snapshot, ["fixture"], [], { config,
      fetchFn: async () => assert.fail("stale set must not download") }), /changed/);
  });
});

test("versioned preparation retains active bytes on failure and records a validated replacement separately", async () => {
  await fixture(async config => {
    const original = await readFile(path.join(config.dataDirectory, "fixture.mbtiles"));
    const plan = { report: { ...config, readyToPrepare: true, archives: [{ id: "fixture", filename: "fixture.mbtiles",
      url: "https://download.geofabrik.de/fixture-shortbread-1.0.mbtiles", downloadBytes: original.length }] }, coverage: [] };
    await assert.rejects(prepareMapArchives(plan, { versioned: true, forceRegions: ["fixture"],
      fetchFn: async () => new Response(Buffer.alloc(original.length), { headers: { "content-length": String(original.length) } }) }), /validation/);
    assert.deepEqual(await readFile(path.join(config.dataDirectory, "fixture.mbtiles")), original);
    assert.equal(readMapArchiveSet(config.dataDirectory).managed, false);
    const result = await prepareMapArchives(plan, { versioned: true, forceRegions: ["fixture"],
      fetchFn: async () => new Response(original, { headers: { "content-length": String(original.length), etag: '"installed"' } }) });
    assert.equal(result.readyToActivate, true);
    const manifest = readMapArchiveSet(config.dataDirectory);
    assert.equal(manifest.active.id, result.activeSet);
    assert.match(manifest.active.archives[0].filename, /^versions\//);
    assert.match(manifest.active.archives[0].sha256, /^[a-f0-9]{64}$/);
    assert.equal(manifest.active.archives[0].source.etag, '"installed"');
    assert.equal(manifest.previous.archives[0].filename, "fixture.mbtiles");
    assert.deepEqual(await readFile(path.join(config.dataDirectory, "fixture.mbtiles")), original);
    const renderer = new LocalMapRenderer(config);
    try { assert.equal(renderer.archives.length, 1); } finally { renderer.close(); }
    let request = { expectedIdentity: mapArchiveSetIdentity(config.dataDirectory), previousSet: manifest.previous.id };
    await assert.rejects(rollbackMapArchives(request, [{ id: 1,
      bounds: { minLat: 0, maxLat: 0.1, minLng: 0, maxLng: 0.1 } }], { config }), /coverage/);
    assert.equal(readMapArchiveSet(config.dataDirectory).active.id, manifest.active.id);
    await rm(path.join(config.dataDirectory, manifest.active.archives[0].filename));
    assert.throws(() => new LocalMapRenderer(config), /ENOENT/);
    request = { ...request, expectedIdentity: mapArchiveSetIdentity(config.dataDirectory) };
    const rolledBack = await rollbackMapArchives(request, [], { config });
    assert.equal(rolledBack.rolledBack, true);
    assert.equal(readMapArchiveSet(config.dataDirectory).active.id, manifest.previous.id);
    await assert.rejects(rollbackMapArchives(request, [], { config }), /changed/);
    await writeFile(path.join(config.dataDirectory, manifest.active.archives[0].filename), "corrupt retired target");
    await assert.rejects(rollbackMapArchives({ expectedIdentity: mapArchiveSetIdentity(config.dataDirectory),
      previousSet: manifest.active.id }, [], { config }), /changed|checksum/);
    assert.equal(readMapArchiveSet(config.dataDirectory).active.id, manifest.previous.id);
  });
});

test("atomic activation changes the worker revision and rejects a stale active-set identity", async () => {
  await fixture(async config => {
    const original = readMapArchiveSet(config.dataDirectory);
    const identity = mapArchiveSetIdentity(config.dataDirectory);
    await activateMapArchiveSet(config, { ...original.active, id: "activated-set" }, identity);
    assert.notEqual(mapArchiveSetIdentity(config.dataDirectory), identity);
    assert.equal(readMapArchiveSet(config.dataDirectory).previous.id, original.active.id);
    await assert.rejects(activateMapArchiveSet(config, original.active, identity), /changed/);
    assert.equal(readMapArchiveSet(config.dataDirectory).active.id, "activated-set");
    assert.ok(!(await readdir(config.dataDirectory)).some(name => name.endsWith(".part") || name.endsWith(".lock")));
  });
});

test("archive manifests select one complete set and fail closed without mixing legacy files", async () => {
  await fixture(async config => {
    const legacy = readMapArchiveSet(config.dataDirectory);
    assert.match(legacy.active.id, /^legacy-/);
    const manifest = { version: 1, active: { ...legacy.active, id: "test-set" }, previous: legacy.active };
    await writeFile(path.join(config.dataDirectory, MAP_ARCHIVE_MANIFEST), JSON.stringify(manifest));
    await writeFile(path.join(config.dataDirectory, "unrelated.mbtiles"), "not an active archive");
    const renderer = new LocalMapRenderer(config);
    try { assert.equal(renderer.archives.length, 1); } finally { renderer.close(); }
    manifest.active.archives[0].filename = "../escape.mbtiles";
    await writeFile(path.join(config.dataDirectory, MAP_ARCHIVE_MANIFEST), JSON.stringify(manifest));
    assert.throws(() => new LocalMapRenderer(config), /Invalid archive set path/);
  });
});

test("stored bounding boxes reproduce renderer viewports and include all edge tiles", () => {
  const bounds = { minLat: 48.72, maxLat: 48.8, minLng: 9.1, maxLng: 9.3 };
  const viewport = getLocalMapViewport(bounds);
  assert.deepEqual(LocalMapRenderer.prototype.viewport(example), viewport);
  const [minX, maxY] = project([bounds.minLng, bounds.minLat]);
  const [maxX, minY] = project([bounds.maxLng, bounds.maxLat]);
  assert.equal(viewport.world, Math.min(256 * 2 ** 18, 272 / (maxX - minX), 142 / (maxY - minY)));
  const coverage = getLocalMapCoverageBounds(bounds);
  assert.ok(coverage.minLat < bounds.minLat && coverage.maxLat > bounds.maxLat);
  assert.ok(coverage.minLng < bounds.minLng && coverage.maxLng > bounds.maxLng);
  assert.ok(coverage.tiles > 0);
  assert.throws(() => getLocalMapViewport({ ...bounds, minLat: NaN }), /Unsupported/);
  assert.throws(() => getLocalMapViewport({ ...bounds, minLng: -179, maxLng: 179 }), /Unsupported/);
});

function tileFixture() {
  const writer = new PbfWriter();
  for (const layer of [
    { name: "land", properties: { kind: "forest" }, type: 3, geometry: [9, 0, 0, 26, 8192, 0, 0, 8192, 8191, 0, 15] },
    { name: "streets", properties: { kind: "primary" }, type: 2, geometry: [9, 0, 0, 10, 8192, 8192] },
    { name: "place_labels", properties: { kind: "town", name: "Testort" }, type: 1, geometry: [9, 4096, 4096] }
  ]) {
    writer.writeMessage(3, (entry, output) => {
      output.writeStringField(1, entry.name);
      const tags = Object.keys(entry.properties).flatMap((_, index) => [index, index]);
      output.writeMessage(2, (_, feature) => {
        feature.writePackedVarint(2, tags);
        feature.writeVarintField(3, entry.type);
        feature.writePackedVarint(4, entry.geometry);
      }, null);
      for (const key of Object.keys(entry.properties)) output.writeStringField(3, key);
      for (const value of Object.values(entry.properties)) output.writeMessage(4,
        (text, property) => property.writeStringField(1, text), value);
      output.writeVarintField(5, 4096);
      output.writeVarintField(15, 2);
    }, layer);
  }
  return gzipSync(writer.finish());
}

async function fixture(action) {
  const directory = await mkdtemp(path.join(tmpdir(), "woa-local-map-"));
  const database = new DatabaseSync(path.join(directory, "fixture.mbtiles"));
  database.exec("CREATE TABLE metadata (name TEXT,value TEXT); CREATE TABLE tiles (zoom_level INTEGER,tile_column INTEGER,tile_row INTEGER,tile_data BLOB,PRIMARY KEY(zoom_level,tile_column,tile_row));");
  database.prepare("INSERT INTO metadata VALUES ('format','pbf')").run();
  const insert = database.prepare("INSERT INTO tiles VALUES (?,?,?,?)");
  const data = tileFixture();
  for (const zoom of [10, 11, 12]) {
    const [worldX, worldY] = project([9.2, 48.78]);
    for (let offsetX = -4; offsetX <= 4; offsetX++) for (let offsetY = -4; offsetY <= 4; offsetY++) {
      insert.run(zoom, Math.floor(worldX * 2 ** zoom) + offsetX,
        2 ** zoom - 1 - Math.floor(worldY * 2 ** zoom) - offsetY, data);
    }
  }
  database.close();
  const config = { dataDirectory: directory, cacheRoot: path.join(directory, "cache") };
  try { await action(config); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test("local map raster cache persists across renderer recreation and keeps routes separate", async () => {
  await fixture(async config => {
    const renderer = new LocalMapRenderer(config);
    let first;
    try { first = await renderer.render(example); assert.ok(first.stats.cache.built > 0); }
    finally { renderer.close(); }
    const restarted = new LocalMapRenderer(config);
    try {
      restarted.renderVector = () => { throw new Error("must reuse raster cache"); };
      const disk = await restarted.render(example);
      const memory = await restarted.render({ ...example, routeColor: "#112233" });
      assert.equal(disk.stats.cache.built, 0);
      assert.ok(disk.stats.cache.disk > 0);
      assert.ok(memory.stats.cache.memory > 0);
      assert.deepEqual(disk.background, first.background);
      assert.deepEqual(memory.background, first.background);
      assert.notEqual(memory.svg, disk.svg);
      assert.match(memory.svg, /data-map-provider="local"/);
      assert.match(memory.svg, /OpenStreetMap contributors/);
      const metadata = await sharp(memory.background).metadata();
      assert.equal(metadata.width, 320);
      assert.equal(metadata.height, 200);
    } finally { restarted.close(); }
  });
});

test("local raster cache repairs corrupt images, isolates styles and enforces limits", async () => {
  await fixture(async config => {
    const renderer = new LocalMapRenderer(config);
    try {
      await renderer.render(example);
      const filename = path.join(renderer.cacheDirectory, (await readdir(renderer.cacheDirectory))[0]);
      const stored = JSON.parse(await readFile(filename, "utf8"));
      stored.png = Buffer.from("corrupt PNG").toString("base64");
      await writeFile(filename, JSON.stringify(stored));
      renderer.clearMemory();
      const repaired = await renderer.render(example);
      assert.equal(repaired.stats.cache.built, 1);
      const different = new LocalMapRenderer({ ...config, cacheVersion: "test-other", maxMemoryBytes: 1, maxDiskBytes: 1 });
      try {
        assert.notEqual(renderer.cacheId, different.cacheId);
        await different.render(example);
        assert.equal(different.memoryBytes, 0);
        assert.deepEqual(await readdir(different.cacheDirectory), []);
      } finally { different.close(); }
      await assert.rejects(renderer.render({ segments: [[[140, 35], [140.1, 35.1]]] }), /No local tiles/);
    } finally { renderer.close(); }
  });
});

test("rendering retains the map in memory when another process holds the global storage lock", async () => {
  await fixture(async config => {
    const lockPath = path.join(config.dataDirectory, ".maps-storage.lock");
    await writeFile(lockPath, "");
    const renderer = new LocalMapRenderer(config);
    try {
      const result = await renderer.render(example);
      assert.match(result.svg, /data-map-provider="local"/);
      assert.ok(result.stats.cache.built > 0);
      assert.deepEqual(await readdir(renderer.cacheDirectory), []);
      assert.ok(renderer.memoryBytes > 0);
      assert.equal((await stat(lockPath)).size, 0);
    } finally { renderer.close(); }
  });
});

test("local map worker renders offline and survives idle reuse without database access", async () => {
  await fixture(async config => {
    const client = new LocalThumbnailMapClient();
    try {
      const first = await client.render(example, config);
      const second = await client.render(example, config);
      assert.match(first.svg, /data-map-provider="local"/);
      assert.equal(second.stats.cache.built, 0);
      assert.ok(second.stats.cache.memory > 0);
    } finally { client.close(); }
  });
});

test("local archive revisions ignore partials and detect additions, rewrites and removals", async () => {
  await fixture(async config => {
    const client = new LocalThumbnailMapClient();
    try {
      const initial = client.getRevision(config, 0);
      assert.match(initial, /^[a-f0-9]{64}$/);
      const filename = path.join(config.dataDirectory, "new.mbtiles");
      await writeFile(`${filename}.part`, "partial");
      assert.equal(client.getRevision(config, 5000), initial);
      await writeFile(filename, "first");
      assert.equal(client.getRevision(config, 5001), initial);
      const added = client.getRevision(config, 10000);
      assert.notEqual(added, initial);
      await writeFile(filename, "other");
      const changed = client.getRevision(config, 15000);
      assert.notEqual(changed, added);
      await rm(filename);
      assert.equal(client.getRevision(config, 20000), initial);
      const unavailable = client.getRevision({ ...config, dataDirectory: path.join(config.dataDirectory, "missing") }, 25000);
      assert.match(unavailable, /^[a-f0-9]{64}$/);
      assert.notEqual(unavailable, initial);
    } finally { client.close(); }
  });
});

test("atomic archive replacement starts a new raster namespace even with the same size and mtime", async () => {
  await fixture(async config => {
    const filename = path.join(config.dataDirectory, "fixture.mbtiles");
    const details = await stat(filename);
    const initial = new LocalMapRenderer(config);
    let cacheId;
    try { await initial.render(example); cacheId = initial.cacheId; }
    finally { initial.close(); }
    const replacement = `${filename}.replacement`;
    await writeFile(replacement, await readFile(filename));
    await utimes(replacement, details.atime, details.mtime);
    await rename(replacement, filename);
    const updated = new LocalMapRenderer(config);
    try {
      assert.notEqual(updated.cacheId, cacheId);
      const rendered = await updated.render(example);
      assert.ok(rendered.stats.cache.built > 0);
      assert.equal(rendered.stats.cache.disk, 0);
    } finally { updated.close(); }
  });
});

test("archive changes reopen an idle worker after completing the active job", async context => {
  const workers = [];
  let revision = "first";
  const client = new LocalThumbnailMapClient({ workerFactory: () => {
    const worker = new EventEmitter();
    Object.assign(worker, { terminated: false, ref() {}, unref() {}, terminate() { this.terminated = true; },
      postMessage(message) { this.message = message; } });
    workers.push(worker);
    return worker;
  } });
  context.mock.method(client, "getRevision", () => revision);
  try {
    const active = client.render(example);
    revision = "second";
    const queued = client.render(example);
    assert.equal(workers.length, 1);
    assert.equal(workers[0].terminated, false);
    workers[0].emit("message", { id: workers[0].message.id, result: { svg: "old-completed" } });
    assert.equal((await active).svg, "old-completed");
    assert.equal(workers[0].terminated, true);
    assert.equal(workers.length, 2);
    workers[0].emit("exit", 0);
    workers[1].emit("message", { id: workers[1].message.id, result: { svg: "new" } });
    assert.equal((await queued).svg, "new");
    const reused = client.render(example);
    assert.equal(workers.length, 2);
    workers[1].emit("message", { id: workers[1].message.id, result: { svg: "reused" } });
    assert.equal((await reused).svg, "reused");
  } finally { client.close(); }
});

test("worker distinguishes unsupported routes from missing tile coverage", async () => {
  await fixture(async config => {
    const client = new LocalThumbnailMapClient();
    try {
      await assert.rejects(client.render({ segments: [[[9, 86], [9.1, 86.1]]] }, config), /^Error: unsupported-route$/);
      await assert.rejects(client.render({ segments: [[[140, 35], [140.1, 35.1]]] }, config), /^Error: outside-coverage$/);
      assert.match((await client.render(example, config)).svg, /data-map-provider="local"/);
    } finally { client.close(); }
  });
});

test("worker queue is bounded and restarts after failure", async () => {
  const workers = [];
  const client = new LocalThumbnailMapClient({ maxPending: 2, workerFactory: () => {
    const worker = new EventEmitter();
    Object.assign(worker, { ref() {}, unref() {}, terminate() {}, postMessage(message) { this.message = message; } });
    workers.push(worker);
    return worker;
  } });
  try {
    const first = client.render(example);
    const queued = client.render(example);
    await assert.rejects(client.render(example), /busy/);
    workers[0].emit("message", { id: workers[0].message.id, result: { svg: "first" } });
    assert.equal((await first).svg, "first");
    workers[0].emit("error", new Error("private error details"));
    await assert.rejects(queued, /worker-error/);
    const restarted = client.render(example);
    workers[1].emit("message", { id: workers[1].message.id, result: { svg: "restarted" } });
    assert.equal((await restarted).svg, "restarted");
  } finally { client.close(); }
});

test("a stalled worker times out active and queued jobs without leaving pending work", async () => {
  const client = new LocalThumbnailMapClient({ timeoutMs: 10, workerFactory: () => {
    const worker = new EventEmitter();
    return Object.assign(worker, { ref() {}, unref() {}, terminate() {}, postMessage() {} });
  } });
  try {
    await Promise.all([
      assert.rejects(client.render(example), /local-map-timeout/),
      assert.rejects(client.render(example), /local-map-timeout/)
    ]);
    assert.equal(client.worker, null);
    assert.equal(client.active, null);
    assert.deepEqual(client.queue, []);
  } finally { client.close(); }
});