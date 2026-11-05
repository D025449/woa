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
import { getLocalMapViewport, getLocalMapCoverageBounds } from "../src/shared/localThumbnailMapViewport.js";

const example = { segments: [[[9.1, 48.72], [9.2, 48.78], [9.3, 48.8]]] };

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