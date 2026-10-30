export function initializeGarminImport({ isBusy, setBusy, importFile }) {
  const load = document.getElementById("garmin-load");
  if (!load) return;
  const messages = JSON.parse(document.getElementById("garmin-import-messages").textContent);
  const list = document.getElementById("garmin-activities");
  const status = document.getElementById("garmin-import-status");
  const start = document.getElementById("garmin-import-selected");
  let rows = [];
  let busy = false;

  function lock(value) {
    busy = value;
    load.disabled = value;
    start.disabled = value || !rows.some(row => row.checkbox.checked);
    for (const row of rows) row.checkbox.disabled = value;
  }

  async function request(path, zip = false) {
    const response = await fetch(`/api/garmin/${path}`, { credentials: "same-origin", signal: AbortSignal.timeout(75_000) });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      const diagnostic = payload.diagnostic;
      const details = [];
      if (diagnostic) {
        if (["token", "activities", "download", "credentials", "storage", "internal"].includes(diagnostic.stage)) {
          details.push(messages[`stage_${diagnostic.stage}`] || diagnostic.stage);
        }
        if (Number.isInteger(diagnostic.upstreamStatus)) details.push(`HTTP ${diagnostic.upstreamStatus}`);
        if (/^[A-Z][A-Z0-9_]{0,49}$/.test(diagnostic.technicalCode || "")) details.push(diagnostic.technicalCode);
      }
      throw new Error(`${messages[payload.code] || messages.failed}${details.length ? ` (${details.join(" · ")})` : ""}`);
    }
    return zip ? response.blob() : (await response.json()).data;
  }

  load.addEventListener("click", async () => {
    if (busy || isBusy()) return;
    setBusy(true);
    lock(true);
    status.textContent = messages.loading;
    try {
      const activities = await request("activities");
      list.replaceChildren();
      rows = [];
      for (const activity of activities) {
        const item = document.createElement("li");
        item.className = "list-group-item";
        const label = document.createElement("label");
        label.className = "d-flex gap-2 align-items-start";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.className = "form-check-input flex-shrink-0";
        checkbox.addEventListener("change", () => lock(false));
        const identity = document.createElement("span");
        const name = document.createElement("strong");
        name.className = "d-block";
        name.textContent = activity.name || activity.id;
        const details = document.createElement("small");
        details.className = "text-muted d-block";
        details.textContent = [activity.startTime, activity.sport.replaceAll("_", " "), `${Math.round(activity.duration / 60)} min`].filter(Boolean).join(" · ");
        const result = document.createElement("small");
        result.className = "d-block";
        result.setAttribute("role", "status");
        identity.append(name, details, result);
        label.append(checkbox, identity);
        item.append(label);
        list.append(item);
        rows.push({ activity, checkbox, result });
      }
      status.textContent = activities.length ? messages.choose : messages.empty;
    } catch (error) { status.textContent = error.message || messages.failed; }
    finally { setBusy(false); lock(false); }
  });

  start.addEventListener("click", async () => {
    if (busy || isBusy()) return;
    const selected = rows.filter(row => row.checkbox.checked);
    if (!selected.length) return;
    setBusy(true);
    lock(true);
    status.textContent = messages.running;
    let failed = 0;
    try {
      for (const row of selected) {
        try {
          row.result.textContent = messages.downloading;
          const blob = await request(`activities/${encodeURIComponent(row.activity.id)}/file`, true);
          row.result.textContent = messages.processing;
          const outcome = await importFile(new File([blob], `${row.activity.id}.zip`, { type: "application/zip" }));
          row.result.textContent = messages[outcome.status] || messages.failed;
          if (outcome.status === "failed") failed++;
          else row.checkbox.checked = false;
        } catch (error) {
          row.result.textContent = error.message || messages.failed;
          failed++;
        }
      }
      status.textContent = failed ? messages.partial : messages.done;
    } finally { setBusy(false); lock(false); }
  });
}
