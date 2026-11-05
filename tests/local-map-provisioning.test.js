import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { PbfWriter } from "pbf";
import { spawnSync } from "node:child_process";
import { getMapDatabaseConfig, runMapCommand, formatMapCommandError } from "../src/scripts/prepare-local-maps.js";
import { getLocalMapCoverageBounds, project } from "../src/shared/localThumbnailMapViewport.js";
import { buildMapPlan, readMapWorkoutBounds, discoverMapArchive, inspectMapArchive,
  prepareMapArchives } from "../src/services/localMapProvisioningService.js";

function region(id, parent, west, east) {
  return { type: "Feature", properties: { id, parent, name: id,
    urls: { pbf: `https://download.geofabrik.de/${id}-latest.osm.pbf` } },
  geometry: { type: "Polygon", coordinates: [[[west, 47], [east, 47], [east, 51], [west, 51], [west, 47]]] } };
}
const catalog = { type: "FeatureCollection", features: [region("country", null, 7, 11),
  region("west", "country", 7, 9.2), region("east", "country", 9.2, 11)] };
const workout = { id: 1, bounds: { minLng: 9.15, maxLng: 9.25, minLat: 48.7, maxLat: 48.8 }, has_thumbnail: false };
const archive = feature => ({ url: `https://download.geofabrik.de/${feature.properties.id}-shortbread-1.0.mbtiles`, bytes: 100 });

async function temporary(action) {
  const directory = await mkdtemp(path.join(tmpdir(), "woa-map-provision-"));
  try { await action(directory); } finally { await rm(directory, { recursive: true, force: true }); }
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
    let cancelled = false;
    const body = new ReadableStream({ cancel() { cancelled = true; } });
    await assert.rejects(prepareMapArchives(plan, { fetchFn: async () =>
      new Response(body, { headers: { "content-length": "101" } }) }), /response changed/);
    assert.equal(cancelled, true);
    assert.deepEqual(await readdir(dataDirectory), []);
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