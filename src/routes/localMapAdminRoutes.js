import express from "express";
import requireAdmin from "../middleware/requireAdmin.js";
import { MAP_OPERATIONS } from "../services/localMapAdminService.js";
import { mapUpdateStateKey, readMapUpdateState } from "../services/localMapUpdateService.js";
import { getLocalThumbnailMapConfig } from "../config/storagePaths.js";
import { readMapArchiveSet, mapArchiveSetIdentity } from "../services/localMapArchiveSetService.js";
import { validateMapInstallation } from "../services/localMapLifecycleService.js";
import { readMapDemand } from "../services/localMapDemandService.js";

export function createLocalMapAdminRouter({ queue, authorize = requireAdmin }) {
  const router = express.Router();
  router.use(authorize);
  router.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.use((req, res, next) => {
    if (req.method === "GET") return next();
    try {
      const origin = new URL(req.get("origin"));
      if (!["http:", "https:"].includes(origin.protocol) || origin.host !== req.get("host")) throw new Error();
    } catch { return res.status(403).json({ error: "Anfrage muss von derselben Website stammen." }); }
    return next();
  });

  router.get("/", async (_req, res, next) => {
    try {
      const jobs = (await queue.getJobs(["active", "waiting", "delayed", "completed", "failed"], 0, 49))
        .filter(job => MAP_OPERATIONS.has(job.name)).sort((first, second) => second.timestamp - first.timestamp);
      const states = (await Promise.all(jobs.map(async job => ({ job, state: await job.getState() }))))
        .filter(entry => !(entry.job.name === "maps-updates" && entry.job.data?.scheduled === true && entry.state === "delayed"));
      const current = states.find(entry => ["active", "waiting", "delayed"].includes(entry.state)) || states[0];
      const completed = states.filter(entry => entry.state === "completed" && ["maps-scan", "maps-prepare"].includes(entry.job.name))
        .sort((first, second) => second.job.finishedOn - first.job.finishedOn)[0]?.job;
      const demand = readMapDemand();
      const storedReport = demand && (!completed?.returnvalue || Date.parse(demand.checkedAt) > Date.parse(completed.returnvalue.checkedAt));
      const updates = await readMapUpdateState(await queue.client, mapUpdateStateKey(queue.qualifiedName));
      const directory = getLocalThumbnailMapConfig().dataDirectory;
      const manifest = readMapArchiveSet(directory, { checkFiles: false });
      const lifecycle = { identity: mapArchiveSetIdentity(directory), activeSet: manifest.active.id,
        previousSet: manifest.previous?.id || null };
      const failureTag = String(current?.job.failedReason || "").match(/\[stage=[a-z-]+, code=[A-Z0-9_]+\]/)?.[0] || "";
      return res.json({ ok: true, report: storedReport ? demand : completed?.returnvalue || null,
        reportJobId: !storedReport && completed ? String(completed.id) : null,
        automaticDownloads: getLocalThumbnailMapConfig().automaticDownloads,
        updates: updates.report || null,
        lifecycle,
        job: current ? { id: String(current.job.id), operation: current.job.name, state: current.state,
          progress: current.job.progress || null,
          error: current.state === "failed" ? `Kartenoperation fehlgeschlagen. ${failureTag} Server-Diagnose erforderlich.` : null } : null });
    } catch (error) { return next(error); }
  });

  router.post("/scan", async (req, res, next) => {
    try {
      const job = await queue.add("maps-scan", { requestedBy: String(req.user.id) },
        { deduplication: { id: "local-map-operation" } });
      return res.status(202).json({ ok: true, jobId: String(job.id) });
    } catch (error) { return next(error); }
  });

  router.post("/updates", async (req, res, next) => {
    try {
      const job = await queue.add("maps-updates", { requestedBy: String(req.user.id) },
        { deduplication: { id: "local-map-operation" } });
      return res.status(202).json({ ok: true, jobId: String(job.id) });
    } catch (error) { return next(error); }
  });

  router.post("/install", async (req, res, next) => {
    try {
      const { checkedAt, approvedRegions, confirmed } = req.body || {};
      if (confirmed !== true) return res.status(400).json({ error: "Installationsfreigabe fehlt." });
      const snapshot = await readMapUpdateState(await queue.client, mapUpdateStateKey(queue.qualifiedName));
      try {
        validateMapInstallation(snapshot, approvedRegions);
        if (checkedAt !== snapshot.report.checkedAt || mapArchiveSetIdentity(getLocalThumbnailMapConfig().dataDirectory) !== snapshot.report.identity) throw new Error();
      } catch { return res.status(409).json({ error: "Updates erneut prüfen und freigeben." }); }
      const job = await queue.add("maps-install", { requestedBy: String(req.user.id), checkedAt, approvedRegions },
        { deduplication: { id: "local-map-operation" } });
      return res.status(202).json({ ok: true, jobId: String(job.id) });
    } catch (error) { return next(error); }
  });

  router.post("/rollback", async (req, res, next) => {
    try {
      const { confirmed, expectedIdentity, previousSet } = req.body || {};
      if (confirmed !== true) return res.status(400).json({ error: "Rollback-Freigabe fehlt." });
      const directory = getLocalThumbnailMapConfig().dataDirectory;
      const manifest = readMapArchiveSet(directory, { checkFiles: false });
      if (!manifest.previous || previousSet !== manifest.previous.id || expectedIdentity !== mapArchiveSetIdentity(directory)) {
        return res.status(409).json({ error: "Rollback-Ziel geändert; Ansicht aktualisieren." });
      }
      const job = await queue.add("maps-rollback", { requestedBy: String(req.user.id), expectedIdentity, previousSet },
        { deduplication: { id: "local-map-operation" } });
      return res.status(202).json({ ok: true, jobId: String(job.id) });
    } catch (error) { return next(error); }
  });

  router.post("/prepare", async (req, res, next) => {
    try {
      const { reportJobId, approvedRegions, confirmed } = req.body || {};
      if (confirmed !== true || !/^\d{1,30}$/.test(String(reportJobId || ""))) {
        return res.status(400).json({ error: "Download-Freigabe fehlt." });
      }
      const source = await queue.getJob(String(reportJobId));
      if (!source || !["maps-scan", "maps-prepare"].includes(source.name) || await source.getState() !== "completed"
        || !Number.isFinite(source.finishedOn) || Date.now() - source.finishedOn > 3600000) {
        return res.status(409).json({ error: "Kartenbedarf erneut prüfen und freigeben." });
      }
      const snapshot = source.returnvalue;
      const missing = snapshot?.regions?.filter(region => region.status === "missing").map(region => region.id) || [];
      if (!snapshot?.readyToPrepare || !missing.length || !Array.isArray(approvedRegions)
        || approvedRegions.length !== missing.length || new Set(approvedRegions).size !== missing.length
        || approvedRegions.some(id => !missing.includes(id))) {
        return res.status(409).json({ error: "Freigabe passt nicht zum geprüften Kartenbedarf." });
      }
      const job = await queue.add("maps-prepare", { requestedBy: String(req.user.id), approvedRegions, reportJobId: String(source.id) },
        { deduplication: { id: "local-map-operation" } });
      return res.status(202).json({ ok: true, jobId: String(job.id) });
    } catch (error) { return next(error); }
  });

  router.use((_error, _req, res, _next) => res.status(503).json({ error: "Kartenverwaltung momentan nicht erreichbar." }));
  return router;
}