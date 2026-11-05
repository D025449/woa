import express from "express";
import requireAdmin from "../middleware/requireAdmin.js";
import { MAP_OPERATIONS } from "../services/localMapAdminService.js";

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
      const states = await Promise.all(jobs.map(async job => ({ job, state: await job.getState() })));
      const current = states.find(entry => ["active", "waiting", "delayed"].includes(entry.state)) || states[0];
      const completed = states.filter(entry => entry.state === "completed")
        .sort((first, second) => second.job.finishedOn - first.job.finishedOn)[0]?.job;
      const failureTag = String(current?.job.failedReason || "").match(/\[stage=[a-z-]+, code=[A-Z0-9_]+\]/)?.[0] || "";
      return res.json({ ok: true, report: completed?.returnvalue || null, reportJobId: completed ? String(completed.id) : null,
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

  router.post("/prepare", async (req, res, next) => {
    try {
      const { reportJobId, approvedRegions, confirmed } = req.body || {};
      if (confirmed !== true || !/^\d{1,30}$/.test(String(reportJobId || ""))) {
        return res.status(400).json({ error: "Download-Freigabe fehlt." });
      }
      const source = await queue.getJob(String(reportJobId));
      if (!source || !MAP_OPERATIONS.has(source.name) || await source.getState() !== "completed"
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