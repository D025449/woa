const phases = {
  starting: "Auftrag wird gestartet", "database-connect": "Datenbankverbindung", "database-read": "GPS-Bedarf ermitteln",
  catalog: "Regionskatalog", plan: "Planung", "plan-bounds": "GPS-Abdeckung planen", "discover-archive": "Region prüfen",
  "inspect-existing": "Vorhandenes Archiv prüfen", "check-file-state": "Dateistand prüfen", "inspect-required": "Archiv validieren",
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
    const space = this.report && this.report.freeDiskBytes >= this.report.downloadBytes * 1.05 + 256 * 1024 ** 2;
    const allowed = !this.busy && this.report?.readyToPrepare && missing.length > 0 && space;
    this.element("scan").disabled = this.busy;
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
    this.element("regions").replaceChildren();
    for (const region of report?.regions || []) {
      const row = document.createElement("tr");
      const state = region.status !== "available" ? "Fehlt" : region.integrityChecked === true ? "Vorhanden · Integrität geprüft"
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

  async refresh() {
    clearTimeout(this.timer);
    try {
      const value = await this.request();
      if (this.reportJobId !== value.reportJobId) this.element("confirm").checked = false;
      this.reportJobId = value.reportJobId;
      this.renderReport(value.report);
      const job = value.job;
      this.busy = Boolean(job && ["active", "waiting", "delayed"].includes(job.state));
      this.element("job").classList.toggle("d-none", !this.busy);
      if (this.busy) {
        const progress = job.progress || {};
        const phase = phases[progress.phase] || "Wartet auf Ops-Worker";
        this.element("phase").textContent = `${phase}${progress.archive ? ` · ${progress.archive}` : ""}${progress.completed !== null && progress.completed !== undefined ? ` · ${progress.completed}/${progress.total}` : ""}`;
        if (Number.isFinite(progress.percent)) this.element("progress").value = progress.percent;
        else this.element("progress").removeAttribute("value");
        this.status(job.operation === "maps-scan" ? "Kartenbedarf wird geprüft." : "Kartenmaterial wird bereitgestellt.");
      } else if (job?.state === "failed") this.status(job.error, true);
      else if (!value.report) this.status("Noch nicht geprüft.");
      else {
        const report = value.report;
        const issues = report.missingBounds + report.unsupportedBounds + report.unmappedWorkouts + report.invalidArchives + (report.missingTileWorkouts || 0);
        const coverage = report.missingTileWorkouts == null ? "Kachelabdeckung nicht geprüft" : `${report.missingTileWorkouts} mit Kachellücken`;
        this.status(issues ? `Prüfprobleme: ${report.missingBounds} ohne GPS-Grenzen · ${report.unsupportedBounds} nicht unterstützt · ${report.unmappedWorkouts} ohne Region · ${report.invalidArchives} ungültige Archive · ${coverage}`
          : report.readyToActivate ? "Kartenmaterial bereit · keine fehlenden Kacheln."
            : report.downloadBytes > 0 ? "Fehlende Regionen warten auf Freigabe." : "Regionsarchive vorhanden · Kachelabdeckung nicht geprüft.", issues > 0);
      }
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
    this.busy = true;
    this.controls();
    try {
      await this.request(`/${operation}`, operation === "scan" ? {} : { reportJobId: this.reportJobId, approvedRegions, confirmed: true });
      this.element("confirm").checked = false;
      await this.refresh();
    } catch (error) {
      this.status(error.message, true);
      this.busy = false;
      this.controls();
    }
  }

  init() {
    this.element("scan").addEventListener("click", () => this.start("scan"));
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