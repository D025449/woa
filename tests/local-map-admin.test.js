import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import express from "express";
import { Job } from "bullmq";
import { createLocalMapAdminRouter } from "../src/routes/localMapAdminRoutes.js";
import { LocalMapAdminController, formatMapBytes } from "../src/public/js/local-map-admin.js";
import { summarizeMapDemand, validateMapApproval, executeMapOperation } from "../src/services/localMapAdminService.js";
import { checkLocalMapUpdates, mapUpdateStateKey, registerMapUpdateSchedule } from "../src/services/localMapUpdateService.js";
import { mkdtemp, writeFile, readFile, readdir, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mapArchiveSetIdentity } from "../src/services/localMapArchiveSetService.js";

test("monthly map schedule is stable, UTC and metadata-only", async () => {
  const calls = [];
  await registerMapUpdateSchedule({ async upsertJobScheduler(...args) { calls.push(args); } }, { enabled: true });
  await registerMapUpdateSchedule({ async upsertJobScheduler(...args) { calls.push(args); } }, { enabled: true });
  assert.deepEqual(calls[0], calls[1]);
  assert.deepEqual(calls[0].slice(0, 2), ["local-map-monthly-updates", { pattern: "0 3 1 * *", tz: "UTC" }]);
  assert.equal(calls[0][2].name, "maps-updates");
  assert.equal(calls[0][2].opts?.deduplication, undefined);
  let removed;
  await registerMapUpdateSchedule({ async removeJobScheduler(id) { removed = id; } }, { enabled: false });
  assert.equal(removed, "local-map-monthly-updates");
});

test("real BullMQ jobs persist map updates through the queue client without downloads or private report data", async () => {
  let stored;
  const state = { version: 1, entries: { private: { baseline: "private-url" } }, report: { checkedAt: "now", regions: [] } };
  const client = { async get() { return null; }, async set(key, value) { stored = { key, value }; } };
  const queue = { name: "ops", qualifiedName: "test:ops", keys: {}, opts: {},
    toKey: key => `test:ops:${key}`, client: Promise.resolve(client) };
  const job = new Job(queue, "maps-updates", {}, {}, "test-update");
  const progress = [];
  job.updateProgress = async value => { progress.push(value); };
  assert.equal(job.client, undefined);
  const result = await executeMapOperation(job, { spawnFn: () => assert.fail("metadata checks must not spawn downloads"),
    checkUpdates: async previous => { assert.deepEqual(previous.entries, {}); return state; } });
  assert.deepEqual(result, state.report);
  assert.equal(stored.key, mapUpdateStateKey("test:ops"));
  assert.deepEqual(JSON.parse(stored.value), state);
  assert.deepEqual(progress, [{ phase: "check-updates" }, { phase: "completed", percent: 100 }]);
  assert.doesNotMatch(JSON.stringify(result), /private/);
});

test("update observations latch upstream changes, reset on local replacement and preserve errors conservatively", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "woa-map-updates-"));
  try {
    const filename = path.join(directory, "hessen.mbtiles");
    await writeFile(filename, "not SQLite: metadata checks must never open the archive");
    let etag = '"first"';
    let fail = false;
    const options = { dataDirectory: directory,
      catalogLoader: async () => ({ features: [{ properties: { id: "hessen", name: "Hessen" } }] }),
      resolveArchive: async (_feature, request) => {
        assert.equal(request.includeMetadata, true);
        if (fail) throw new Error("private-path-and-token");
        return { url: "https://download.geofabrik.de/hessen.mbtiles", bytes: 100, etag, lastModified: null };
      } };
    let state = await checkLocalMapUpdates(undefined, options);
    assert.equal(state.report.regions[0].status, "unknown");
    state = await checkLocalMapUpdates(state, options);
    assert.equal(state.report.regions[0].status, "unchanged");
    etag = '"second"';
    state = await checkLocalMapUpdates(state, options);
    assert.equal(state.report.regions[0].status, "changed");
    state = await checkLocalMapUpdates(state, options);
    assert.equal(state.report.regions[0].status, "changed");
    fail = true;
    state = await checkLocalMapUpdates(state, options);
    assert.equal(state.report.regions[0].status, "error");
    assert.doesNotMatch(JSON.stringify(state.report), /private-path|https:|fingerprint/);
    fail = false;
    state = await checkLocalMapUpdates(state, options);
    assert.equal(state.report.regions[0].status, "changed");
    await writeFile(filename, "replacement");
    state = await checkLocalMapUpdates(state, options);
    assert.equal(state.report.regions[0].status, "unknown");
    assert.ok(state.report.regions.every(region => region.installedVersion === "unverified"));
    assert.equal(await readFile(filename, "utf8"), "replacement");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("empty inventories make no network calls, unsupported archives stay unknown and symlinks are not followed", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "woa-map-updates-"));
  try {
    const empty = await checkLocalMapUpdates(undefined, { dataDirectory: directory,
      catalogLoader: async () => assert.fail("empty inventory must not fetch metadata") });
    assert.deepEqual(empty.report.regions, []);
    await writeFile(path.join(directory, "hessen.mbtiles"), "protected");
    await writeFile(path.join(directory, "download.part"), "protected partial");
    const result = await checkLocalMapUpdates(undefined, { dataDirectory: directory,
      catalogLoader: async () => ({ features: ["hessen", "alias"].map(id => ({ properties: { id, name: id } })) }),
      resolveArchive: async feature => { assert.equal(feature.properties.id, "hessen"); return null; } });
    assert.deepEqual(result.report.regions.map(region => [region.id, region.status]), [["hessen", "unavailable"]]);
    await symlink(path.join(directory, "hessen.mbtiles"), path.join(directory, "alias.mbtiles"));
    await assert.rejects(checkLocalMapUpdates(undefined, { dataDirectory: directory,
      catalogLoader: async () => assert.fail("symlink inventory must fail before network") }), /regular file|symlink/);
    assert.deepEqual((await readdir(directory)).sort(), ["alias.mbtiles", "download.part", "hessen.mbtiles"]);
    assert.equal(await readFile(path.join(directory, "hessen.mbtiles"), "utf8"), "protected");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

const report = {
  gpsWorkouts: 3, missingThumbnails: 2, missingBounds: [], unsupportedBounds: [], unmappedWorkouts: [],
  invalidUnneededArchives: [], archiveCountAfterPrepare: 2, archiveLimit: 16,
  freeDiskBytes: 1000000000, readyToPrepare: true,
  archives: [
    { id: "hessen", name: "Hessen", existingValid: true, existingBytes: 100, downloadBytes: 110,
      workouts: 3, missingThumbnails: 2, url: "https://private-value", filename: "private-value" },
    { id: "alsace", name: "Alsace", existingValid: false, downloadBytes: 200, workouts: 1, missingThumbnails: 1 }
  ]
};

test("admin map demand summarizes regions without exposing source URLs or workout identities", () => {
  const summary = summarizeMapDemand(report, new Date("2026-11-05T12:00:00Z"));
  assert.equal(summary.checkedAt, "2026-11-05T12:00:00.000Z");
  assert.deepEqual(summary.regions.map(region => region.status), ["available", "missing"]);
  assert.equal(summary.downloadBytes, 200);
  assert.equal(summary.gpsWorkouts, 3);
  assert.doesNotMatch(JSON.stringify(summary), /private-value|filename|https:/);
  assert.equal(summary.missingTileWorkouts, null);
  assert.equal(summary.regions[0].integrityChecked, true);
  const sampled = summarizeMapDemand({ ...report, inspectionMode: "sample" });
  assert.equal(sampled.regions[0].status, "available");
  assert.equal(sampled.regions[0].integrityChecked, false);
  assert.equal(sampled.readyToActivate, false);
  const prepared = summarizeMapDemand({ ...report, preparation: { created: ["alsace"], uncoveredWorkouts: [], readyToActivate: true } });
  assert.equal(prepared.downloadBytes, 0);
  assert.equal(prepared.readyToActivate, true);
  assert.ok(prepared.regions.every(region => region.status === "available"));
  assert.ok(prepared.regions.every(region => region.integrityChecked));
  assert.equal(summarizeMapDemand({ ...report, preparation: { uncoveredWorkouts: [42] } }).missingTileWorkouts, 1);
  const storage = { usedBytes: 150, limitBytes: 300, cacheBytes: 50, availableBytes: 150,
    fits: true, fitsAfterCleanup: true };
  const finalStorage = summarizeMapDemand({ ...report, storage: { ...storage, usedBytes: 100 },
    preparation: { storage, uncoveredWorkouts: [] } });
  assert.deepEqual(finalStorage.storage, storage);
});

test("map approval cannot add unapproved regions or inject command arguments", () => {
  assert.doesNotThrow(() => validateMapApproval(report, ["alsace"]));
  for (const ids of [[], ["hessen"], ["--env-file"], ["../alsace"], ["https://evil.invalid"]]) {
    assert.throws(() => validateMapApproval(report, ids), /approval|demand changed/);
  }
});

test("install jobs send private snapshots over bounded stdin to the CLI using a real BullMQ Job", async () => {
  const snapshot = { version: 1, report: { checkedAt: new Date().toISOString(), identity: "a".repeat(64),
    regions: [{ id: "hessen", canInstall: true }] }, entries: { hessen: { current: {
    url: "https://download.geofabrik.de/hessen-shortbread-1.0.mbtiles", bytes: 100, etag: '"private-validator"' } } } };
  const queue = { name: "ops", qualifiedName: "test:ops", keys: {}, opts: {}, toKey: key => `test:ops:${key}`,
    client: Promise.resolve({ async get() { return JSON.stringify(snapshot); } }) };
  const job = new Job(queue, "maps-install", { checkedAt: snapshot.report.checkedAt, approvedRegions: ["hessen"] }, {}, "install");
  job.updateProgress = async () => {};
  let input;
  const result = await executeMapOperation(job, { spawnFn: (_executable, args, options) => {
    assert.equal(args[2], "install");
    assert.equal(options.stdio[0], "pipe");
    assert.doesNotMatch(args.join(" "), /private-validator|https:/);
    const child = new EventEmitter();
    const stdin = Object.assign(new EventEmitter(), { end(value) {
      input = JSON.parse(value);
      setImmediate(() => {
        child.stdout.emit("data", Buffer.from(JSON.stringify({ lifecycle: { activeSet: "installed", installed: ["hessen"] } })));
        child.emit("close", 0);
      });
    } });
    Object.assign(child, { stdin, stdout: new EventEmitter(), stderr: new EventEmitter(), kill() {} });
    return child;
  } });
  assert.deepEqual(input.snapshot, snapshot);
  assert.deepEqual(input.approvedRegions, ["hessen"]);
  assert.equal(result.activeSet, "installed");
  assert.doesNotMatch(JSON.stringify(result), /private-validator|https:/);
});

test("install API requires explicit fresh exact approval and never exposes private validators", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "woa-map-install-api-"));
  const previousDirectory = process.env.WOA_MAP_DATA_DIR;
  process.env.WOA_MAP_DATA_DIR = directory;
  try {
    await writeFile(path.join(directory, "hessen.mbtiles"), "local inventory only");
    const snapshot = { version: 1, report: { checkedAt: new Date().toISOString(), identity: mapArchiveSetIdentity(directory),
      regions: [{ id: "hessen", canInstall: true }] }, entries: { hessen: { current: { bytes: 100, etag: '"private"' } } } };
    const added = [];
    const queue = { client: Promise.resolve({ async get() { return JSON.stringify(snapshot); } }), async getJobs() { return []; },
      async add(...args) { added.push(args); return { id: 2 }; } };
    await withMapApi(queue, async url => {
      const headers = { "x-admin": "yes", "content-type": "application/json", origin: new URL(url).origin };
      const payload = { checkedAt: snapshot.report.checkedAt, approvedRegions: ["hessen"], confirmed: true };
      for (const body of [{ ...payload, confirmed: false }, { ...payload, approvedRegions: ["other"] },
        { ...payload, checkedAt: "old" }, { ...payload, approvedRegions: ["hessen", "hessen"] }]) {
        assert.ok((await fetch(`${url}/install`, { method: "POST", headers, body: JSON.stringify(body) })).status >= 400);
      }
      assert.equal((await fetch(`${url}/install`, { method: "POST", headers: { ...headers, origin: "https://evil.invalid" },
        body: JSON.stringify(payload) })).status, 403);
      assert.equal(added.length, 0);
      assert.equal((await fetch(`${url}/install`, { method: "POST", headers, body: JSON.stringify(payload) })).status, 202);
      assert.equal(added[0][0], "maps-install");
      assert.doesNotMatch(JSON.stringify(added), /private/);
      assert.equal((await fetch(`${url}/rollback`, { method: "POST", headers,
        body: JSON.stringify({ confirmed: true, previousSet: "missing", expectedIdentity: snapshot.report.identity }) })).status, 409);
    });
  } finally {
    if (previousDirectory === undefined) delete process.env.WOA_MAP_DATA_DIR;
    else process.env.WOA_MAP_DATA_DIR = previousDirectory;
    await rm(directory, { recursive: true, force: true });
  }
});

test("map operations run the existing CLI out of process and expose only structured progress", async () => {
  const progress = [];
  const job = { name: "maps-prepare", data: { approvedRegions: ["alsace"] }, async updateProgress(value) { progress.push(value); } };
  let args;
  const result = await executeMapOperation(job, { spawnFn: (_executable, selected) => {
    args = selected;
    const child = new EventEmitter();
    Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(), kill() {} });
    setImmediate(() => {
      child.stderr.emit("data", Buffer.from("private-error-details\n[maps] download archive=alsace 100/200 bytes (50.0%)\n"));
      child.stdout.emit("data", Buffer.from(JSON.stringify(report)));
      child.emit("close", 0);
    });
    return child;
  } });
  assert.equal(args[0], "--");
  assert.equal(args.includes("--quick"), false);
  assert.deepEqual(args.slice(-2), ["--approved-regions", "alsace"]);
  assert.ok(progress.some(value => value.phase === "download" && value.percent === 50));
  assert.doesNotMatch(JSON.stringify(progress), /private-error-details/);
  assert.equal(result.downloadBytes, 200);
});

test("admin map scans request quick inspection while keeping tile coverage unknown", async () => {
  let args;
  const result = await executeMapOperation({ name: "maps-scan", data: {}, async updateProgress() {} }, {
    spawnFn: (_executable, selected) => {
      args = selected;
      const child = new EventEmitter();
      Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(), kill() {} });
      setImmediate(() => {
        child.stdout.emit("data", Buffer.from(JSON.stringify({ ...report, inspectionMode: "sample" })));
        child.emit("close", 0);
      });
      return child;
    }
  });
  assert.equal(args[2], "plan");
  assert.ok(args.includes("--quick"));
  assert.equal(result.regions[0].integrityChecked, false);
  assert.equal(result.missingTileWorkouts, null);
  assert.equal(result.readyToActivate, false);
});

async function withMapApi(queue, action) {
  queue.client ||= Promise.resolve({ async get() { return null; } });
  const app = express();
  app.use(express.json());
  app.use("/maps", createLocalMapAdminRouter({ queue, authorize: (req, res, next) => {
    if (req.get("x-admin") !== "yes") return res.status(403).json({ error: "Admin role required" });
    req.user = { id: 1 };
    return next();
  } }));
  const server = await new Promise(resolve => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
  try { await action(`http://127.0.0.1:${server.address().port}/maps`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test("map API requires admin access and same-origin mutation and returns only map jobs", async () => {
  const snapshot = summarizeMapDemand(report);
  const source = { id: "1", name: "maps-scan", timestamp: 1, finishedOn: Date.now(), returnvalue: snapshot,
    async getState() { return "completed"; } };
  const added = [];
  const queue = { async getJobs() { return [{ ...source, name: "create", returnvalue: { secret: true } }, source]; },
    async getJob() { return source; }, async add(...args) { added.push(args); return { id: 2 }; } };
  await withMapApi(queue, async url => {
    assert.equal((await fetch(url)).status, 403);
    const headers = { "x-admin": "yes", "content-type": "application/json", origin: new URL(url).origin };
    const response = await fetch(url, { headers });
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.equal(body.reportJobId, "1");
    assert.doesNotMatch(JSON.stringify(body), /secret/);
    assert.equal((await fetch(`${url}/scan`, { method: "POST", headers: { ...headers, origin: "https://evil.invalid" } })).status, 403);
    assert.equal(added.length, 0);
    assert.equal((await fetch(`${url}/scan`, { method: "POST", headers })).status, 202);
    assert.equal(added[0][0], "maps-scan");
    assert.equal(added[0][2].deduplication.id, "local-map-operation");
    assert.equal((await fetch(`${url}/prepare`, { method: "POST", headers,
      body: JSON.stringify({ reportJobId: "1", approvedRegions: ["alsace"], confirmed: true }) })).status, 202);
    assert.deepEqual(added[1][1].approvedRegions, ["alsace"]);
    for (const payload of [
      { reportJobId: "1", approvedRegions: ["alsace"], confirmed: false },
      { reportJobId: "1", approvedRegions: ["alsace", "hessen"], confirmed: true },
      { reportJobId: "1", approvedRegions: ["../alsace"], confirmed: true }
    ]) assert.ok((await fetch(`${url}/prepare`, { method: "POST", headers, body: JSON.stringify(payload) })).status >= 400);
    source.finishedOn = Date.now() - 3600001;
    assert.equal((await fetch(`${url}/prepare`, { method: "POST", headers,
      body: JSON.stringify({ reportJobId: "1", approvedRegions: ["alsace"], confirmed: true }) })).status, 409);
  });
});

test("update API preserves demand approvals and reads durable results even after job expiry", async () => {
  const updates = { checkedAt: "2026-11-05T12:00:00Z", regions: [{ id: "hessen", name: "Hessen", status: "unknown" }] };
  const source = { id: "1", name: "maps-scan", timestamp: 1, finishedOn: Date.now(), returnvalue: summarizeMapDemand(report),
    async getState() { return "completed"; } };
  const update = { ...source, id: "2", name: "maps-updates", timestamp: 2, finishedOn: Date.now() + 1, returnvalue: updates };
  const monthly = { ...update, id: "3", timestamp: 3, data: { scheduled: true }, async getState() { return "delayed"; } };
  const added = [];
  const queue = { qualifiedName: "test:ops", client: Promise.resolve({ async get(key) {
    assert.equal(key, mapUpdateStateKey("test:ops"));
    return JSON.stringify({ version: 1, entries: { private: "private-url" }, report: updates });
  } }), async getJobs() { return [monthly, update, source]; }, async getJob() { return update; },
  async add(...args) { added.push(args); return { id: 3 }; } };
  await withMapApi(queue, async url => {
    const headers = { "x-admin": "yes", "content-type": "application/json", origin: new URL(url).origin };
    const body = await (await fetch(url, { headers })).json();
    assert.equal(body.reportJobId, "1");
    assert.equal(body.job.id, "2");
    assert.equal(body.job.state, "completed");
    assert.deepEqual(body.updates, updates);
    assert.doesNotMatch(JSON.stringify(body), /private-url/);
    assert.equal((await fetch(`${url}/updates`, { method: "POST", headers: { ...headers, origin: "https://evil.invalid" } })).status, 403);
    assert.equal((await fetch(`${url}/updates`, { method: "POST", headers })).status, 202);
    assert.equal(added[0][0], "maps-updates");
    assert.equal(added[0][2].deduplication.id, "local-map-operation");
    assert.equal((await fetch(`${url}/prepare`, { method: "POST", headers,
      body: JSON.stringify({ reportJobId: "2", approvedRegions: ["alsace"], confirmed: true }) })).status, 409);
    queue.getJobs = async () => [];
    assert.deepEqual((await (await fetch(url, { headers })).json()).updates, updates);
  });
});

test("admin map controls require explicit approval, capacity and a completed plan", () => {
  const elements = new Map();
  const controller = new LocalMapAdminController({ querySelector(selector) {
    if (!elements.has(selector)) elements.set(selector, { checked: false, disabled: false, textContent: "" });
    return elements.get(selector);
  } });
  controller.controls();
  assert.equal(controller.element("confirm").disabled, true);
  controller.report = summarizeMapDemand(report);
  controller.controls();
  assert.equal(controller.element("confirm").disabled, false);
  assert.equal(controller.element("prepare").disabled, true);
  controller.element("confirm").checked = true;
  controller.controls();
  assert.equal(controller.element("prepare").disabled, false);
  controller.busy = true;
  controller.controls();
  assert.equal(controller.element("prepare").disabled, true);
  assert.equal(controller.element("scan").disabled, true);
  controller.busy = false;
  controller.report.storage = { fits: false, fitsAfterCleanup: false };
  controller.controls();
  assert.equal(controller.element("prepare").disabled, true);
  controller.report.storage.fitsAfterCleanup = true;
  controller.controls();
  assert.equal(controller.element("prepare").disabled, false);
  controller.report.freeDiskBytes = 0;
  controller.controls();
  assert.equal(controller.element("prepare").disabled, false);
  controller.report.storage = null;
  controller.controls();
  assert.equal(controller.element("prepare").disabled, true);
  controller.report.freeDiskBytes = 1000000000;
  controller.report.readyToPrepare = false;
  controller.controls();
  assert.equal(controller.element("prepare").disabled, true);
  controller.updates = { checkedAt: new Date().toISOString(), identity: "current", regions: [{ id: "hessen", canInstall: true, bytes: 100 }] };
  controller.lifecycle = { identity: "current", previousSet: "prior" };
  controller.controls();
  assert.equal(controller.element("install-confirm").disabled, false);
  assert.equal(controller.element("install").disabled, true);
  controller.element("install-confirm").checked = true;
  controller.element("rollback-confirm").checked = true;
  controller.controls();
  assert.equal(controller.element("install").disabled, false);
  assert.equal(controller.element("rollback").disabled, false);
  controller.lifecycle.identity = "changed";
  controller.controls();
  assert.equal(controller.element("install").disabled, true);
  controller.lifecycle.previousSet = null;
  controller.controls();
  assert.equal(controller.element("rollback").disabled, true);
  assert.equal(formatMapBytes(1024 ** 3), "1,00 GiB");
});

test("failed map child processes do not expose raw stdout or stderr", async () => {
  await assert.rejects(executeMapOperation({ name: "maps-scan", data: {}, async updateProgress() {} }, { spawnFn: () => {
    const child = new EventEmitter();
    Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(), kill() {} });
    setImmediate(() => {
      child.stdout.emit("data", Buffer.from("private-path-and-token"));
      child.stderr.emit("data", Buffer.from("private-path-and-token [stage=prepare, code=ENOSPC]\n"));
      child.emit("close", 1);
    });
    return child;
  } }), error => {
    assert.match(error.message, /Map operation failed/);
    assert.match(error.message, /stage=prepare, code=ENOSPC/);
    assert.doesNotMatch(error.message, /private-path-and-token/);
    return true;
  });
});