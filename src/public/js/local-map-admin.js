const phases = {
  starting: "Auftrag wird gestartet", "database-connect": "Datenbankverbindung", "database-read": "GPS-Bedarf ermitteln",
  catalog: "Regionskatalog", plan: "Planung", "plan-bounds": "GPS-Abdeckung planen", "discover-archive": "Region prüfen",
  "inspect-existing": "Vorhandenes Archiv prüfen", "check-file-state": "Dateistand prüfen", "inspect-required": "Archiv validieren",
  "storage-budget": "Speicherbudget prüfen", "cleanup-cache": "Rastercache bereinigen",
  "check-updates": "Upstream-Metadaten prüfen",
  "activate-set": "Archivsatz aktivieren", "verify-rollback": "Rollback-Archiv prüfen",
  reuse: "Archiv wiederverwenden", "download-request": "Download anfordern", "refresh-size": "Dateigröße neu abgleichen",
  download: "Download", "verify-download": "Download prüfen", installed: "Archiv installiert", coverage: "Kachelabdeckung prüfen",
  completed: "Abgeschlossen"
};

export function formatMapBytes(bytes) {
  return Number.isFinite(bytes) ? `${(bytes / 1024 ** 3).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} GiB` : "–";
}

export class LocalMapAdminController {
  constructor(root) {
    this.root = root;
    this.report = null;
    this.updates = null;
    this.lifecycle = null;
    this.reportJobId = null;
    this.busy = false;
    this.timer = null;
  }

  element(id) { return this.root.querySelector(`#local-map-${id}`); }

  async request(path = "", body = null) {
    const response = await fetch(`/admin/accounts/maps${path}`, {
      credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(15000), method: body === null ? "GET" : "POST",
      ...(body === null ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || "Kartenverwaltung momentan nicht erreichbar.");
    return value;
  }

  controls() {
    const missing = this.report?.regions.filter(region => region.status === "missing") || [];
    const space = this.report && (this.report.storage ? this.report.storage.fitsAfterCleanup
      : this.report.freeDiskBytes >= this.report.downloadBytes * 1.05 + 256 * 1024 ** 2);
    const budget = !this.report?.storage || this.report.storage.fitsAfterCleanup;
    const allowed = !this.busy && Boolean(this.reportJobId) && this.report?.readyToPrepare && missing.length > 0 && space && budget;
    this.element("scan").disabled = this.busy;
    this.element("updates").disabled = this.busy;
    const candidates = this.updates?.regions.filter(region => region.canInstall) || [];
    const installable = !this.busy && candidates.length > 0 && this.lifecycle?.identity === this.updates?.identity
      && Date.now() - Date.parse(this.updates.checkedAt) <= 3600000;
    this.element("install-confirm").disabled = !installable;
    this.element("install").disabled = !installable || !this.element("install-confirm").checked;
    this.element("install-label").textContent = candidates.length
      ? `${candidates.length} ${candidates.length === 1 ? "Region" : "Regionen"} · ${formatMapBytes(candidates.reduce((sum, region) => sum + region.bytes, 0))} zur Installation freigeben`
      : "Installation freigeben";
    const rollback = !this.busy && Boolean(this.lifecycle?.previousSet);
    this.element("rollback-confirm").disabled = !rollback;
    this.element("rollback").disabled = !rollback || !this.element("rollback-confirm").checked;
    this.element("confirm").disabled = !allowed;
    this.element("prepare").disabled = !allowed || !this.element("confirm").checked;
    this.element("confirm-label").textContent = missing.length
      ? `${missing.length} ${missing.length === 1 ? "Region" : "Regionen"} · ${formatMapBytes(this.report.downloadBytes)} freigeben`
      : "Download freigeben";
  }

  renderReport(report) {
    this.report = report;
    this.element("workouts").textContent = report ? report.gpsWorkouts.toLocaleString("de-DE") : "–";
    this.element("archives").textContent = report ? `${report.archiveCount}/${report.archiveLimit}` : "–";
    this.element("download").textContent = formatMapBytes(report?.downloadBytes);
    this.element("disk").textContent = formatMapBytes(report?.freeDiskBytes);
    this.element("storage").textContent = report?.storage
      ? `${formatMapBytes(report.storage.usedBytes)} / ${formatMapBytes(report.storage.limitBytes)}` : "–";
    this.element("regions").replaceChildren();
    for (const region of report?.regions || []) {
      const row = document.createElement("tr");
      const state = region.status === "unsupported" ? "Kein direktes Kartenarchiv" : region.status !== "available" ? "Fehlt" : region.integrityChecked === true ? "Vorhanden · Integrität geprüft"
        : region.integrityChecked === false ? "Vorhanden · Stichprobe geprüft" : "Vorhanden";
      const values = [region.name, state, formatMapBytes(region.bytes),
        region.workouts.toLocaleString("de-DE"), region.missingThumbnails.toLocaleString("de-DE")];
      values.forEach((value, index) => {
        const cell = document.createElement("td");
        cell.textContent = value;
        if (index >= 2) cell.className = "text-end";
        if (index === 0) cell.className = "admin-map-region-name";
        if (index === 1) {
          const status = document.createElement("span");
          status.className = `admin-map-state${region.status === "available" ? " is-available" : ""}`;
          status.textContent = value;
          cell.replaceChildren(status);
        }
        row.append(cell);
      });
      this.element("regions").append(row);
    }
    this.element("empty").classList.toggle("d-none", Boolean(report?.regions.length));
    this.element("empty").textContent = report ? "Keine Regionen ermittelt." : "Kein Prüfergebnis vorhanden.";
    this.element("checked").textContent = report ? new Date(report.checkedAt).toLocaleString("de-DE") : "";
    this.element("checked").dateTime = report?.checkedAt || "";
  }

  status(message, error = false) {
    this.element("status").textContent = message;
    this.element("status").classList.toggle("is-error", error);
  }

  renderUpdates(report) {
    this.updates = report;
    const labels = { changed: "Upstream geändert", unchanged: "Metadaten unverändert", unknown: "Versionsstand unklar",
      unavailable: "Upstream nicht verfügbar", error: "Prüfung fehlgeschlagen" };
    this.element("update-regions").replaceChildren();
    for (const region of report?.regions || []) {
      const row = document.createElement("tr");
      const values = [region.name, labels[region.status] || labels.unknown,
        region.installedVersion === "recorded" ? "Stand erfasst" : "Nicht belegt", formatMapBytes(region.bytes),
        region.lastModified ? new Date(region.lastModified).toLocaleString("de-DE") : "–"];
      for (const [index, value] of values.entries()) {
        const cell = document.createElement("td");
        cell.textContent = value;
        if (index === 3) cell.className = "text-end";
        row.append(cell);
      }
      this.element("update-regions").append(row);
    }
    this.element("update-empty").classList.toggle("d-none", Boolean(report?.regions.length));
    this.element("update-empty").textContent = report ? "Keine lokalen Archive vorhanden." : "Kein Update-Prüfergebnis vorhanden.";
    this.element("update-checked").textContent = report ? new Date(report.checkedAt).toLocaleString("de-DE") : "";
    this.element("update-checked").dateTime = report?.checkedAt || "";
  }

  async refresh() {
    clearTimeout(this.timer);
    try {
      const value = await this.request();
      if (this.reportJobId !== value.reportJobId) this.element("confirm").checked = false;
      this.reportJobId = value.reportJobId;
      this.renderReport(value.report);
      this.renderUpdates(value.updates);
      if (this.lifecycle?.identity !== value.lifecycle?.identity) {
        this.element("install-confirm").checked = false;
        this.element("rollback-confirm").checked = false;
      }
      this.lifecycle = value.lifecycle || null;
      this.element("active-set").textContent = this.lifecycle?.activeSet || "–";
      this.element("previous-set").textContent = this.lifecycle?.previousSet || "–";
      const job = value.job;
      this.busy = Boolean(job && ["active", "waiting", "delayed"].includes(job.state));
      this.element("job").classList.toggle("d-none", !this.busy);
      if (this.busy) {
        const progress = job.progress || {};
        const phase = phases[progress.phase] || "Wartet auf Ops-Worker";
        this.element("phase").textContent = `${phase}${progress.archive ? ` · ${progress.archive}` : ""}${progress.completed !== null && progress.completed !== undefined ? ` · ${progress.completed}/${progress.total}` : ""}`;
        if (Number.isFinite(progress.percent)) this.element("progress").value = progress.percent;
        else this.element("progress").removeAttribute("value");
        this.status(job.operation === "maps-updates" ? "Kartenupdates werden geprüft."
          : job.operation === "maps-install" ? "Kartenupdate wird installiert."
            : job.operation === "maps-rollback" ? "Rollback wird geprüft."
          : ["maps-scan", "maps-demand"].includes(job.operation) ? "Kartenbedarf wird geprüft." : "Kartenmaterial wird bereitgestellt.");
      } else if (job?.state === "failed") this.status(job.error, true);
      else if (!value.report) this.status("Noch nicht geprüft.");
      else {
        const report = value.report;
        const issues = report.missingBounds + report.unsupportedBounds + report.unmappedWorkouts + report.invalidArchives + (report.missingTileWorkouts || 0);
        const coverage = report.missingTileWorkouts == null ? "Kachelabdeckung nicht geprüft" : `${report.missingTileWorkouts} mit Kachellücken`;
        this.status(issues ? `Prüfprobleme: ${report.missingBounds} ohne GPS-Grenzen · ${report.unsupportedBounds} nicht unterstützt · ${report.unmappedWorkouts} ohne Region · ${report.invalidArchives} ungültige Archive · ${coverage}`
          : report.readyToActivate ? "Kartenmaterial bereit · keine fehlenden Kacheln."
            : report.downloadBytes > 0 ? report.downloadState === "failed" ? "Automatischer Download fehlgeschlagen · Server-Diagnose erforderlich."
              : value.automaticDownloads && report.downloadState === "blocked" ? "Automatischer Download gesperrt · Kartenbedarf prüfen."
                : this.reportJobId ? "Fehlende Regionen warten auf Freigabe." : "Fehlende Regionen · für manuelle Freigabe erneut prüfen."
              : "Regionsarchive vorhanden · Kachelabdeckung nicht geprüft.", issues > 0);
        if (report.storage && !report.storage.fitsAfterCleanup) {
          this.status("Speicherbudget oder Freiplatzreserve reicht nicht aus · neue Downloads gesperrt.", true);
        }
      }
      this.element("automatic").textContent = value.automaticDownloads ? "Automatische Downloads: aktiv" : "Automatische Downloads: aus";
      this.controls();
      if (this.busy) this.timer = setTimeout(() => this.refresh(), 2000);
    } catch (error) {
      this.status(error.message, true);
      this.busy = false;
      this.element("confirm").checked = false;
      this.controls();
    }
  }

  async start(operation) {
    const approvedRegions = this.report?.regions.filter(region => region.status === "missing").map(region => region.id) || [];
    if (this.busy || operation === "prepare" && !this.element("confirm").checked) return;
    if (operation === "install" && !this.element("install-confirm").checked
      || operation === "rollback" && !this.element("rollback-confirm").checked) return;
    this.busy = true;
    this.controls();
    try {
      const body = operation === "prepare" ? { reportJobId: this.reportJobId, approvedRegions, confirmed: true }
        : operation === "install" ? { checkedAt: this.updates.checkedAt,
          approvedRegions: this.updates.regions.filter(region => region.canInstall).map(region => region.id), confirmed: true }
          : operation === "rollback" ? { expectedIdentity: this.lifecycle.identity, previousSet: this.lifecycle.previousSet, confirmed: true } : {};
      await this.request(`/${operation}`, body);
      this.element("confirm").checked = false;
      this.element("install-confirm").checked = false;
      this.element("rollback-confirm").checked = false;
      await this.refresh();
    } catch (error) {
      this.status(error.message, true);
      this.busy = false;
      this.controls();
    }
  }

  init() {
    this.element("scan").addEventListener("click", () => this.start("scan"));
    this.element("updates").addEventListener("click", () => this.start("updates"));
    this.element("install").addEventListener("click", () => this.start("install"));
    this.element("rollback").addEventListener("click", () => this.start("rollback"));
    this.element("install-confirm").addEventListener("change", () => this.controls());
    this.element("rollback-confirm").addEventListener("change", () => this.controls());
    this.element("prepare").addEventListener("click", () => this.start("prepare"));
    this.element("confirm").addEventListener("change", () => this.controls());
    window.addEventListener("pagehide", () => clearTimeout(this.timer));
    window.lucide?.createIcons();
    void this.refresh();
  }
}

if (typeof document !== "undefined") {
  const root = document.getElementById("local-map-management");
  if (root) new LocalMapAdminController(root).init();
}