export function initializeGarminImport({ isBusy, setBusy, importFiles }, { provider = "garmin", extension = "zip" } = {}) {
  const element = suffix => document.getElementById(`${provider}-${suffix}`);
  const load = element("load");
  if (!load) return;
  const messages = JSON.parse(element("import-messages").textContent);
  const list = element("activities");
  const status = element("import-status");
  const start = element("import-selected");
  const more = element("load-more");
  const selectAll = element("select-all");
  const unselectAll = element("unselect-all");
  const toolbar = element("selection-toolbar");
  let nextStart = 0;
  let hasMore = false;
  let rows = [];
  let busy = false;

  function updateToolbar() {
    if (toolbar) toolbar.hidden = rows.length === 0;
  }

  function lock(value) {
    busy = value;
    load.disabled = value;
    more.disabled = value || !hasMore;
    more.hidden = !hasMore;
    start.disabled = value || !rows.some(row => row.checkbox.checked);
    if (selectAll) selectAll.disabled = value;
    if (unselectAll) unselectAll.disabled = value;
    for (const row of rows) row.checkbox.disabled = value;
  }

  async function request(path, zip = false) {
    const response = await fetch(`/api/${provider}/${path}`, { credentials: "same-origin", signal: AbortSignal.timeout(75_000) });
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

  async function loadActivities(append) {
    if (busy || isBusy()) return;
    setBusy(true);
    lock(true);
    status.textContent = messages.loading;
    try {
      const activities = await request(append ? `activities?start=${nextStart}` : "activities");
      if (!append) {
        list.replaceChildren();
        rows = [];
      }
      nextStart = (append ? nextStart : 0) + activities.length;
      hasMore = activities.length === 20;
      const knownIds = new Set(rows.map(row => row.activity.id));
      for (const activity of activities) {
        if (knownIds.has(activity.id)) continue;
        knownIds.add(activity.id);
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
      status.textContent = rows.length ? (hasMore ? messages.choose : messages.allLoaded) : messages.empty;
      updateToolbar();
    } catch (error) { status.textContent = error.message || messages.failed; }
    finally { setBusy(false); lock(false); }
  }

  load.addEventListener("click", () => loadActivities(false));
  more.addEventListener("click", () => loadActivities(true));

  if (selectAll) {
    selectAll.addEventListener("click", () => {
      for (const row of rows) if (!row.checkbox.disabled) row.checkbox.checked = true;
      lock(false);
    });
  }
  if (unselectAll) {
    unselectAll.addEventListener("click", () => {
      for (const row of rows) row.checkbox.checked = false;
      lock(false);
    });
  }

  start.addEventListener("click", async () => {
    if (busy || isBusy()) return;
    const selected = rows.filter(row => row.checkbox.checked);
    if (!selected.length) return;
    setBusy(true);
    lock(true);
    status.textContent = messages.running;

    // Download all selected files in parallel
    const downloads = await Promise.all(selected.map(async row => {
      row.result.textContent = messages.downloading;
      try {
        const blob = await request(`activities/${encodeURIComponent(row.activity.id)}/file`, true);
        row.result.textContent = messages.processing;
        return { row, file: new File([blob], `${row.activity.id}.${extension}`, { type: extension === "fit" ? "application/vnd.ant.fit" : "application/zip" }) };
      } catch (error) {
        row.result.textContent = error.message || messages.failed;
        return { row, file: null };
      }
    }));

    const successful = downloads.filter(d => d.file !== null);
    const downloadFailed = downloads.filter(d => d.file === null).length;

    if (successful.length === 0) {
      status.textContent = messages.partial;
      setBusy(false);
      lock(false);
      return;
    }

    // Import all downloaded files in one batch
    try {
      const outcome = await importFiles(successful.map(d => d.file));
      const importStatus = outcome.status;
      for (const { row } of successful) {
        row.result.textContent = messages[importStatus] || messages.failed;
        if (importStatus !== "failed") row.checkbox.checked = false;
      }
      status.textContent = (downloadFailed > 0 || importStatus === "failed") ? messages.partial : messages.done;
    } catch (error) {
      for (const { row } of successful) row.result.textContent = error.message || messages.failed;
      status.textContent = messages.partial;
    } finally {
      setBusy(false);
      lock(false);
    }
  });
}
