import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import express from "express";
import { createLocalMapAdminRouter } from "../src/routes/localMapAdminRoutes.js";
import { LocalMapAdminController, formatMapBytes } from "../src/public/js/local-map-admin.js";
import { summarizeMapDemand, validateMapApproval, executeMapOperation } from "../src/services/localMapAdminService.js";

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