import {
  BlobReader,
  TextWriter,
  Uint8ArrayWriter,
  ZipReader,
  configure as configureZipJs
} from "/vendor/zipjs/index.js";

const form = document.getElementById("account-backup-import-form");
const result = document.getElementById("account-backup-result");

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = form.querySelector("button[type='submit']");
  button.disabled = true;
  result.className = "alert alert-info mt-3 mb-0";
  result.textContent = "Import läuft ...";

  try {
    const response = await fetch("/admin/accounts/import", {
      method: "POST",
      body: new FormData(form),
      credentials: "include"
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || `Import fehlgeschlagen (${response.status})`);
    }
    const counts = payload.counts || {};
    result.className = "alert alert-success mt-3 mb-0";
    result.textContent = [
      `${counts.users || 0} Benutzer`,
      `${counts.profiles || 0} Profile`,
      `${counts.paymentOrders || 0} Käufe`,
      `${counts.memberships || 0} Memberships`,
      `${counts.roles || 0} Rollen`,
      `${counts.viewPreferences || 0} UI-Einstellungen`
    ].join(" · ");
    form.reset();
  } catch (error) {
    result.className = "alert alert-danger mt-3 mb-0";
    result.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

const segmentForm = document.getElementById("segment-backup-import-form");
const segmentResult = document.getElementById("segment-backup-result");
const segmentConfirm = document.getElementById("segment-backup-confirm");
const segmentPreviewWrap = document.getElementById("segment-backup-preview-wrap");
const segmentPreviewBody = document.getElementById("segment-backup-preview");
let segmentPreviewIsCurrent = false;

function setSegmentResult(kind, message) {
  segmentResult.className = `alert alert-${kind} mt-3 mb-0`;
  segmentResult.textContent = message;
}

function mappingLabel(mapping) {
  if (mapping.status === "conflict") return "Konflikt";
  if (mapping.status === "unmatched") return "Nicht gefunden";
  return mapping.matchMethod === "auth_sub" ? "Cognito-ID" : "E-Mail";
}

function renderSegmentPreview(preview) {
  segmentPreviewBody.replaceChildren();
  for (const mapping of preview.owners || []) {
    const row = document.createElement("tr");
    const source = document.createElement("td");
    const target = document.createElement("td");
    const statusCell = document.createElement("td");
    const segmentCount = document.createElement("td");
    const importCount = document.createElement("td");
    const duplicateCount = document.createElement("td");
    const status = document.createElement("span");

    source.textContent = mapping.sourceEmail || mapping.sourceAuthSub;
    source.title = `auth_sub: ${mapping.sourceAuthSub}\nAlte UID: ${mapping.sourceUid || "-"}`;
    target.textContent = mapping.targetEmail || "-";
    status.className = `admin-backup-status admin-backup-status--${mapping.status}`;
    status.textContent = mappingLabel(mapping);
    statusCell.append(status);
    segmentCount.className = "text-end";
    importCount.className = "text-end";
    duplicateCount.className = "text-end";
    segmentCount.textContent = String(mapping.segmentCount || 0);
    importCount.textContent = String(mapping.importCount || 0);
    duplicateCount.textContent = String(mapping.duplicateCount || 0);
    row.append(source, target, statusCell, segmentCount, importCount, duplicateCount);
    segmentPreviewBody.append(row);
  }
  segmentPreviewWrap.classList.remove("d-none");
}

function selectedSegmentArchive() {
  return segmentForm?.querySelector("input[name='archive']")?.files?.[0] || null;
}

async function sendSegmentArchive(path, confirmed = false) {
  const archive = selectedSegmentArchive();
  if (!archive) throw new Error("Bitte zuerst ein Segment-ZIP auswählen.");
  const body = new FormData();
  body.append("archive", archive);
  if (confirmed) body.append("confirmed", "true");
  const response = await fetch(path, { method: "POST", body, credentials: "include" });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || `Segment-Restore fehlgeschlagen (${response.status})`);
  }
  return payload;
}

segmentForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const previewButton = segmentForm.querySelector("button[type='submit']");
  previewButton.disabled = true;
  segmentConfirm.disabled = true;
  segmentPreviewIsCurrent = false;
  setSegmentResult("info", "Archiv und Benutzerzuordnung werden geprüft ...");

  try {
    const payload = await sendSegmentArchive("/admin/accounts/segments/preview");
    const preview = payload.preview;
    renderSegmentPreview(preview);
    const totals = preview.totals || {};
    const hasConflicts = Number(totals.conflicts) > 0;
    const canImport = !hasConflicts && Number(totals.importable) > 0;
    segmentPreviewIsCurrent = true;
    segmentConfirm.classList.toggle("d-none", !canImport);
    segmentConfirm.disabled = !canImport;

    const summary = [
      `${totals.segments || 0} Segmente`,
      `${totals.importable || 0} neu`,
      `${totals.duplicates || 0} Duplikate`,
      `${totals.unmatched || 0} ohne Benutzer`,
      `${totals.conflicts || 0} in Konflikten`
    ].join(" · ");
    setSegmentResult(hasConflicts ? "danger" : (Number(totals.unmatched) > 0 ? "warning" : "success"), summary);
  } catch (error) {
    segmentConfirm.classList.add("d-none");
    setSegmentResult("danger", error.message);
  } finally {
    previewButton.disabled = false;
  }
});

segmentConfirm?.addEventListener("click", async () => {
  if (!segmentPreviewIsCurrent) return;
  const previewButton = segmentForm.querySelector("button[type='submit']");
  previewButton.disabled = true;
  segmentConfirm.disabled = true;
  setSegmentResult("info", "Segmente werden importiert ...");

  try {
    const payload = await sendSegmentArchive("/admin/accounts/segments/import", true);
    const queueNote = payload.queueFailures > 0
      ? ` · ${payload.queueFailures} Best-Effort-Jobs konnten nicht geplant werden`
      : "";
    setSegmentResult("success", `${payload.imported || 0} Segmente importiert${queueNote}.`);
    segmentPreviewIsCurrent = false;
    segmentConfirm.classList.add("d-none");
  } catch (error) {
    setSegmentResult("danger", error.message);
    segmentConfirm.disabled = false;
  } finally {
    previewButton.disabled = false;
  }
});

segmentForm?.querySelector("input[name='archive']")?.addEventListener("change", () => {
  segmentPreviewIsCurrent = false;
  segmentConfirm.classList.add("d-none");
  segmentPreviewWrap.classList.add("d-none");
  segmentResult.classList.add("d-none");
});

const workoutForm = document.getElementById("workout-backup-import-form");
const workoutResult = document.getElementById("workout-backup-result");
const workoutConfirm = document.getElementById("workout-backup-confirm");
const workoutPreviewWrap = document.getElementById("workout-backup-preview-wrap");
const workoutPreviewBody = document.getElementById("workout-backup-preview");
let workoutPreviewIsCurrent = false;

function setWorkoutResult(kind, message) {
  workoutResult.className = `alert alert-${kind} mt-3 mb-0`;
  workoutResult.textContent = message;
}

function renderWorkoutPreview(preview) {
  workoutPreviewBody.replaceChildren();
  for (const mapping of preview.owners || []) {
    const row = document.createElement("tr");
    const values = [
      mapping.sourceEmail || mapping.sourceAuthSub,
      mapping.targetEmail || "-",
      mappingLabel(mapping),
      mapping.workoutCount || 0,
      mapping.importCount || 0,
      mapping.duplicateCount || 0
    ];
    values.forEach((value, index) => {
      const cell = document.createElement("td");
      cell.textContent = String(value);
      if (index >= 3) cell.className = "text-end";
      row.append(cell);
    });
    workoutPreviewBody.append(row);
  }
  workoutPreviewWrap.classList.remove("d-none");
}

function selectedWorkoutArchive() {
  return workoutForm?.querySelector("input[name='archive']")?.files?.[0] || null;
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function buildLocalWorkoutPreview(file) {
  configureZipJs({ useWebWorkers: false, useCompressionStream: false });
  const reader = new ZipReader(new BlobReader(file), {
    useWebWorkers: false,
    useCompressionStream: false
  });
  try {
    const entries = (await reader.getEntries()).filter((entry) => !entry.directory);
    const byName = new Map(entries.map((entry) => [entry.filename, entry]));
    const manifestEntry = byName.get("manifest.json");
    if (!manifestEntry) throw new Error("Workout-Archiv enthält kein Manifest.");
    const manifest = JSON.parse(await manifestEntry.getData(new TextWriter()));
    if (manifest?.format !== "cwa24-admin-workouts" || Number(manifest?.version) !== 1) {
      throw new Error("Nicht unterstütztes Workout-Archivformat.");
    }
    const owners = Array.isArray(manifest.owners) ? manifest.owners : [];
    const ownerIndexByKey = new Map();
    owners.forEach((owner, index) => {
      const key = String(owner?.key || "");
      if (!key || ownerIndexByKey.has(key)) throw new Error("Ungültige Besitzerliste im Workout-Archiv.");
      ownerIndexByKey.set(key, index);
    });
    const metadataEntries = entries
      .filter((entry) => /^workouts\/[^/]+\/W-[^/]+\.json$/u.test(entry.filename))
      .sort((left, right) => left.filename.localeCompare(right.filename));
    if (metadataEntries.length !== Number(manifest.workoutCount)) {
      throw new Error("Workout-Anzahl stimmt nicht mit dem Manifest überein.");
    }

    const workouts = new Array(metadataEntries.length);
    let segmentCount = 0;
    let favoriteCount = 0;
    let cursor = 0;
    const readNext = async () => {
      while (cursor < metadataEntries.length) {
        const index = cursor++;
        const entry = metadataEntries[index];
        const metadata = JSON.parse(await entry.getData(new TextWriter()));
        const ownerIndex = ownerIndexByKey.get(String(metadata.ownerKey || ""));
        if (ownerIndex == null) throw new Error(`${entry.filename} verweist auf einen unbekannten Benutzer.`);
        const base = entry.filename.slice(0, -5);
        const streamEntry = byName.get(`${base}.stream`);
        if (!streamEntry) throw new Error(`${entry.filename} enthält keinen Workout-Stream.`);
        const startTime = metadata.start_time == null ? null : new Date(metadata.start_time).toISOString();
        let streamHash = null;
        if (!startTime) {
          const stream = await streamEntry.getData(new Uint8ArrayWriter());
          streamHash = await sha256Hex(stream);
        }
        segmentCount += Array.isArray(metadata.segments) ? metadata.segments.length : 0;
        favoriteCount += Array.isArray(metadata.favoriteOwnerKeys) ? metadata.favoriteOwnerKeys.length : 0;
        workouts[index] = [ownerIndex, startTime, streamHash];
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(8, Math.max(1, metadataEntries.length)) },
      () => readNext()
    ));
    if (segmentCount !== Number(manifest.segmentCount)
      || favoriteCount !== Number(manifest.favoriteCount)) {
      throw new Error("Segment- oder Favoritenanzahl stimmt nicht mit dem Manifest überein.");
    }
    return {
      format: manifest.format,
      version: manifest.version,
      createdAt: manifest.createdAt,
      workoutCount: manifest.workoutCount,
      owners,
      workouts
    };
  } finally {
    await reader.close();
  }
}

async function sendWorkoutPreview(metadata) {
  const response = await fetch("/admin/accounts/workouts/preview", {
    method: "POST",
    headers: { "Content-Type": "application/vnd.cwa24.workout-preview+json" },
    body: JSON.stringify(metadata),
    credentials: "include"
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `Workout-Vorschau fehlgeschlagen (${response.status})`);
  return payload;
}

async function sendWorkoutArchive() {
  const archive = selectedWorkoutArchive();
  if (!archive) throw new Error("Bitte zuerst ein Workout-ZIP auswählen.");
  const body = new FormData();
  body.append("archive", archive);
  body.append("confirmed", "true");
  const response = await fetch("/admin/accounts/workouts/import", {
    method: "POST",
    body,
    credentials: "include"
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `Workout-Restore fehlgeschlagen (${response.status})`);
  return payload;
}

workoutForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const previewButton = workoutForm.querySelector("button[type='submit']");
  previewButton.disabled = true;
  workoutConfirm.disabled = true;
  workoutPreviewIsCurrent = false;
  setWorkoutResult("info", "Archiv und Benutzerzuordnung werden geprüft ...");
  try {
    const archive = selectedWorkoutArchive();
    if (!archive) throw new Error("Bitte zuerst ein Workout-ZIP auswählen.");
    const metadata = await buildLocalWorkoutPreview(archive);
    setWorkoutResult("info", "Lokale Prüfung abgeschlossen, Zielzuordnung wird abgefragt ...");
    const { preview } = await sendWorkoutPreview(metadata);
    renderWorkoutPreview(preview);
    const totals = preview.totals || {};
    const hasConflicts = Number(totals.conflicts) > 0;
    const canImport = !hasConflicts && Number(totals.importable) > 0;
    workoutPreviewIsCurrent = true;
    workoutConfirm.classList.toggle("d-none", !canImport);
    workoutConfirm.disabled = !canImport;
    setWorkoutResult(hasConflicts ? "danger" : (Number(totals.unmatched) ? "warning" : "success"), [
      `${totals.workouts || 0} Workouts`, `${totals.importable || 0} neu`,
      `${totals.duplicates || 0} Duplikate`, `${totals.unmatched || 0} ohne Benutzer`,
      `${totals.conflicts || 0} in Konflikten`
    ].join(" · "));
  } catch (error) {
    workoutConfirm.classList.add("d-none");
    setWorkoutResult("danger", error.message);
  } finally {
    previewButton.disabled = false;
  }
});

workoutConfirm?.addEventListener("click", async () => {
  if (!workoutPreviewIsCurrent) return;
  const previewButton = workoutForm.querySelector("button[type='submit']");
  previewButton.disabled = true;
  workoutConfirm.disabled = true;
  setWorkoutResult("info", "Workouts werden transaktional importiert ...");
  try {
    const { result: imported } = await sendWorkoutArchive();
    setWorkoutResult("success", [
      `${imported.imported || 0} Workouts importiert`,
      `${imported.importedSegments || 0} Workout-Segmente`,
      `${imported.importedFavorites || 0} Favoriten`
    ].join(" · "));
    workoutPreviewIsCurrent = false;
    workoutConfirm.classList.add("d-none");
  } catch (error) {
    setWorkoutResult("danger", error.message);
    workoutConfirm.disabled = false;
  } finally {
    previewButton.disabled = false;
  }
});

workoutForm?.querySelector("input[name='archive']")?.addEventListener("change", () => {
  workoutPreviewIsCurrent = false;
  workoutConfirm.classList.add("d-none");
  workoutPreviewWrap.classList.add("d-none");
  workoutResult.classList.add("d-none");
});

const databaseBackupList = document.getElementById("database-backup-list");
const databaseBackupEmpty = document.getElementById("database-backup-empty");
const databaseBackupEnvironment = document.getElementById("database-backup-environment");
const databaseBackupRefresh = document.getElementById("database-backup-refresh");
const databaseBackupCreate = document.getElementById("database-backup-create");
const databaseBackupLabel = document.getElementById("database-backup-label");
const databaseBackupVerify = document.getElementById("database-backup-verify");
const databaseBackupSelectedTitle = document.getElementById("database-backup-selected-title");
const databaseBackupSelectedDetail = document.getElementById("database-backup-selected-detail");
const databaseRestoreConfirmation = document.getElementById("database-restore-confirmation");
const databaseRestoreConfirm = document.getElementById("database-restore-confirm");
const databaseRestorePrepare = document.getElementById("database-restore-prepare");
const databaseBackupJob = document.getElementById("database-backup-job");
const databaseBackupJobTitle = document.getElementById("database-backup-job-title");
const databaseBackupJobState = document.getElementById("database-backup-job-state");
const databaseBackupJobProgress = document.getElementById("database-backup-job-progress");
const databaseBackupJobMessage = document.getElementById("database-backup-job-message");
const databaseRestoreResult = document.getElementById("database-restore-result");
const databaseRestoreTarget = document.getElementById("database-restore-target");
const databaseRestoreCompatibility = document.getElementById("database-restore-compatibility");
const databaseRestoreMetrics = document.getElementById("database-restore-metrics");
const databaseRestoreNote = document.getElementById("database-restore-note");
const databaseActivationControls = document.getElementById("database-activation-controls");
const databaseActivationConfirm = document.getElementById("database-activation-confirm");
const databaseActivationStart = document.getElementById("database-activation-start");
const databaseRollbackControls = document.getElementById("database-rollback-controls");
const databaseRollbackTitle = document.getElementById("database-rollback-title");
const databaseRollbackDetail = document.getElementById("database-rollback-detail");
const databaseRollbackConfirm = document.getElementById("database-rollback-confirm");
const databaseRollbackStart = document.getElementById("database-rollback-start");
const databaseCleanupList = document.getElementById("database-cleanup-list");
const databaseCleanupEmpty = document.getElementById("database-cleanup-empty");
const databaseDeleteConfirmation = document.getElementById("database-delete-confirmation");
const databaseDeleteTarget = document.getElementById("database-delete-target");
const databaseDeleteName = document.getElementById("database-delete-name");
const databaseDeleteCancel = document.getElementById("database-delete-cancel");
const databaseDeleteStart = document.getElementById("database-delete-start");
const databaseDeleteResult = document.getElementById("database-delete-result");
const databaseWizardSteps = [...document.querySelectorAll("[data-database-step]")];

let databaseBackups = [];
let selectedDatabaseBackup = null;
let verifiedDatabaseBackupRoot = null;
let databaseOperationRunning = false;
let databaseCatalogConfiguration = null;
let selectedCleanupDatabase = null;
let preparedRestoreJobId = null;
let preparedRestoreResult = null;

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let amount = bytes;
  let unit = -1;
  do {
    amount /= 1024;
    unit += 1;
  } while (amount >= 1024 && unit < units.length - 1);
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${units[unit]}`;
}

function formatBackupDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "-"
    : new Intl.DateTimeFormat("de-DE", {
      dateStyle: "medium",
      timeStyle: "medium"
    }).format(date);
}

async function databaseApi(path, options = {}) {
  const response = await fetch(path, {
    credentials: "include",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `Backup-Operation fehlgeschlagen (${response.status})`);
  return payload;
}

function setDatabaseWizardStep(step) {
  const order = ["catalog", "select", "verify", "restore", "activate"];
  const activeIndex = order.indexOf(step);
  for (const element of databaseWizardSteps) {
    const index = order.indexOf(element.dataset.databaseStep);
    element.classList.toggle("is-active", index === activeIndex);
    element.classList.toggle("is-complete", index < activeIndex);
  }
}

function setDatabaseControlsDisabled(disabled) {
  databaseOperationRunning = disabled;
  databaseBackupCreate.disabled = disabled;
  databaseBackupRefresh.disabled = disabled;
  databaseBackupVerify.disabled = disabled || !selectedDatabaseBackup;
  databaseRestorePrepare.disabled = disabled
    || !databaseRestoreConfirm.checked
    || verifiedDatabaseBackupRoot !== selectedDatabaseBackup?.rootKey;
  databaseActivationStart.disabled = disabled
    || !databaseActivationConfirm.checked
    || !preparedRestoreJobId
    || preparedRestoreResult?.schemaCompatibility !== "same-commit";
  databaseRollbackStart.disabled = disabled
    || !databaseRollbackConfirm.checked
    || !databaseCatalogConfiguration?.previousDatabase;
  for (const button of databaseCleanupList.querySelectorAll("button")) {
    button.disabled = disabled;
  }
  databaseDeleteStart.disabled = disabled
    || !selectedCleanupDatabase
    || databaseDeleteName.value !== selectedCleanupDatabase.name;
  databaseDeleteCancel.disabled = disabled;
}

function closeDatabaseDeleteConfirmation() {
  selectedCleanupDatabase = null;
  databaseDeleteName.value = "";
  databaseDeleteTarget.textContent = "";
  databaseDeleteConfirmation.classList.add("d-none");
  databaseDeleteStart.disabled = true;
}

function setDatabaseDeleteResult(type, message) {
  databaseDeleteResult.className = `alert alert-${type} m-3`;
  databaseDeleteResult.textContent = message;
}

function selectCleanupDatabase(database) {
  selectedCleanupDatabase = database;
  databaseDeleteTarget.textContent = database.name;
  databaseDeleteName.value = "";
  databaseDeleteConfirmation.classList.remove("d-none");
  databaseDeleteStart.disabled = true;
  databaseDeleteResult.classList.add("d-none");
  databaseDeleteName.focus();
}

function renderManagedDatabases() {
  const databases = databaseCatalogConfiguration?.databases || [];
  databaseCleanupList.replaceChildren();
  databaseCleanupEmpty.classList.toggle("d-none", databases.length > 0);
  for (const database of databases) {
    const row = document.createElement("tr");
    const nameCell = document.createElement("td");
    const statusCell = document.createElement("td");
    const sizeCell = document.createElement("td");
    const actionCell = document.createElement("td");
    const status = document.createElement("span");

    nameCell.textContent = database.name;
    nameCell.className = "admin-database-name";
    status.className = `admin-database-state admin-database-state--${database.status}`;
    status.textContent = {
      active: "Aktiv",
      rollback: "Rollback geschützt",
      inactive: "Inaktiv"
    }[database.status] || database.status;
    statusCell.append(status);
    sizeCell.className = "text-end";
    sizeCell.textContent = formatBytes(database.sizeBytes);
    actionCell.className = "text-end";
    if (database.deletable) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "btn btn-outline-danger btn-sm";
      button.textContent = "Löschen";
      button.disabled = databaseOperationRunning;
      button.addEventListener("click", () => selectCleanupDatabase(database));
      actionCell.append(button);
    } else {
      actionCell.textContent = "Geschützt";
      actionCell.classList.add("admin-database-protected");
    }
    row.append(nameCell, statusCell, sizeCell, actionCell);
    databaseCleanupList.append(row);
  }
}

function resetDatabaseVerification() {
  verifiedDatabaseBackupRoot = null;
  databaseRestoreConfirm.checked = false;
  databaseRestoreConfirmation.classList.add("d-none");
  databaseRestoreResult.classList.add("d-none");
  databaseActivationControls.classList.add("d-none");
  databaseActivationConfirm.checked = false;
  preparedRestoreJobId = null;
  preparedRestoreResult = null;
  databaseRestorePrepare.disabled = true;
}

function selectDatabaseBackup(backup) {
  selectedDatabaseBackup = backup;
  resetDatabaseVerification();
  databaseBackupSelectedTitle.textContent = backup
    ? (backup.label || `Backup ${backup.backupId}`)
    : "Kein Backup ausgewählt";
  databaseBackupSelectedDetail.textContent = backup
    ? `${formatBackupDate(backup.createdAt)} · ${formatBytes(backup.archiveSizeBytes)} · ${backup.rootKey}`
    : "Wähle einen Snapshot aus der Liste.";
  databaseBackupVerify.disabled = databaseOperationRunning || !backup;
  setDatabaseWizardStep(backup ? "select" : "catalog");
}

function renderDatabaseBackups() {
  databaseBackupList.replaceChildren();
  databaseBackupEmpty.classList.toggle("d-none", databaseBackups.length > 0);
  for (const backup of databaseBackups) {
    const row = document.createElement("tr");
    const selectCell = document.createElement("td");
    const dateCell = document.createElement("td");
    const labelCell = document.createElement("td");
    const databaseCell = document.createElement("td");
    const sourceSizeCell = document.createElement("td");
    const sizeCell = document.createElement("td");
    const versionCell = document.createElement("td");
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "database-backup-selection";
    radio.className = "form-check-input";
    radio.checked = selectedDatabaseBackup?.rootKey === backup.rootKey;
    radio.addEventListener("change", () => selectDatabaseBackup(backup));
    row.addEventListener("click", (event) => {
      if (event.target !== radio) {
        radio.checked = true;
        selectDatabaseBackup(backup);
      }
    });
    selectCell.append(radio);
    dateCell.textContent = formatBackupDate(backup.createdAt);
    labelCell.textContent = backup.label || "-";
    databaseCell.textContent = backup.database || "-";
    sourceSizeCell.className = "text-end";
    sourceSizeCell.textContent = formatBytes(backup.sourceSizeBytes);
    sizeCell.className = "text-end";
    sizeCell.textContent = formatBytes(backup.archiveSizeBytes);
    versionCell.textContent = backup.gitCommit ? backup.gitCommit.slice(0, 9) : "-";
    versionCell.title = backup.gitCommit || "Kein Git-Commit im Manifest";
    row.append(selectCell, dateCell, labelCell, databaseCell, sourceSizeCell, sizeCell, versionCell);
    databaseBackupList.append(row);
  }
}

async function loadDatabaseBackups(preselectRoot = null) {
  databaseBackupEnvironment.textContent = "S3-Katalog wird geladen ...";
  try {
    const payload = await databaseApi("/admin/accounts/database/backups");
    databaseCatalogConfiguration = payload.catalog || null;
    databaseBackups = payload.catalog?.backups || [];
    databaseBackupEnvironment.textContent = [
      payload.catalog?.environment,
      `logisch: ${payload.catalog?.database}`,
      payload.catalog?.activeDatabase && payload.catalog.activeDatabase !== payload.catalog.database
        ? `aktiv: ${payload.catalog.activeDatabase}`
        : null,
      `${databaseBackups.length} Backups`
    ].filter(Boolean).join(" · ");
    if (preselectRoot) {
      selectedDatabaseBackup = databaseBackups.find((backup) => backup.rootKey === preselectRoot) || null;
    } else if (selectedDatabaseBackup) {
      selectedDatabaseBackup = databaseBackups.find(
        (backup) => backup.rootKey === selectedDatabaseBackup.rootKey
      ) || null;
    }
    renderDatabaseBackups();
    renderManagedDatabases();
    selectDatabaseBackup(selectedDatabaseBackup);
    const previousDatabase = databaseCatalogConfiguration?.previousDatabase;
    databaseRollbackControls.classList.toggle("d-none", !previousDatabase);
    databaseRollbackConfirm.checked = false;
    databaseRollbackStart.disabled = true;
    if (previousDatabase) {
      databaseRollbackTitle.textContent = `Rollback auf ${previousDatabase}`;
      databaseRollbackDetail.textContent = `Aktiv ist ${databaseCatalogConfiguration.activeDatabase}. Beide Datenbanken bleiben erhalten.`;
    }
  } catch (error) {
    databaseBackupEnvironment.textContent = error.message;
  }
}

function renderRestoreResult(result, prepareJobId) {
  databaseRestoreResult.classList.remove("d-none");
  databaseRestoreTarget.textContent = result.targetDatabase || "Unbekannte Prüfdatenbank";
  const compatible = result.schemaCompatibility === "same-commit";
  databaseRestoreCompatibility.className = `admin-backup-status admin-backup-status--${compatible ? "matched" : "unmatched"}`;
  databaseRestoreCompatibility.textContent = compatible ? "Gleicher Code-Stand" : "Migration prüfen";
  preparedRestoreResult = result;
  preparedRestoreJobId = prepareJobId;
  const activationAvailable = compatible && Boolean(databaseCatalogConfiguration?.activationSupported);
  databaseActivationControls.classList.toggle("d-none", !activationAvailable);
  databaseActivationConfirm.checked = false;
  databaseActivationStart.disabled = true;
  databaseRestoreNote.textContent = activationAvailable
    ? "Noch ist die aktive Datenbank unverändert. Vor der Aktivierung wird automatisch ein vollständiges Sicherheitsbackup erstellt."
    : (databaseCatalogConfiguration?.activationSupported
      ? "Der Code-Stand weicht ab. Vor einer Aktivierung müssen Migrationen bewusst geprüft werden."
      : "In Development bleibt die bestehende CLI-Promotion aktiv; der Runtime-Pointer gilt nur für Production.");
  databaseRestoreMetrics.replaceChildren();
  const metrics = [
    ["Tabellen", result.validation?.tables],
    ["Views", result.validation?.views],
    ["Constraints", result.validation?.constraints],
    ["Benutzer", result.validation?.users],
    ["Workouts", result.validation?.workouts],
    ["Segmente", result.validation?.segments],
    ["Admins", result.validation?.admins],
    ["Dauer", `${Math.round((Number(result.totalMs) || 0) / 1000)} s`]
  ];
  for (const [label, value] of metrics) {
    const container = document.createElement("div");
    const term = document.createElement("dt");
    const description = document.createElement("dd");
    term.textContent = label;
    description.textContent = value == null ? "-" : String(value);
    container.append(term, description);
    databaseRestoreMetrics.append(container);
  }
}

async function pollDatabaseJob(jobId, operation) {
  databaseBackupJob.classList.remove("d-none");
  databaseBackupJobTitle.textContent = {
    create: "PostgreSQL-Backup wird erstellt",
    verify: "Backup wird vollständig verifiziert",
    "prepare-restore": "Isolierter Restore wird vorbereitet",
    "activate-restore": "Restore wird sicher aktiviert",
    rollback: "Datenbank-Rollback wird vorbereitet",
    "drop-database": "Inaktive Datenbank wird gesichert und gelöscht"
  }[operation] || "Backup-Operation läuft";
  setDatabaseControlsDisabled(true);
  let restartPollFailures = 0;

  while (true) {
    let payload;
    try {
      payload = await databaseApi(`/admin/accounts/database/jobs/${encodeURIComponent(jobId)}`);
    } catch (error) {
      if (!["activate-restore", "rollback"].includes(operation)) throw error;
      restartPollFailures += 1;
      if (restartPollFailures > 40) {
        throw new Error(
          "Neustart läuft länger als erwartet. Seite neu laden und den aktiven DB-Namen prüfen.",
          { cause: error }
        );
      }
      databaseBackupJobState.textContent = "Neustart";
      databaseBackupJobMessage.textContent = "Anwendung und Worker starten mit der umgeschalteten Datenbank neu ...";
      await new Promise((resolve) => setTimeout(resolve, 1500));
      continue;
    }
    const job = payload.job;
    const progress = Number(job.progress?.percent ?? job.progress ?? 0) || 0;
    databaseBackupJobState.textContent = job.state;
    databaseBackupJobProgress.style.width = `${Math.max(0, Math.min(100, progress))}%`;
    databaseBackupJobMessage.textContent = job.error || {
      waiting: "Der Auftrag wartet auf den Ops-Worker.",
      active: "Die Operation läuft unabhängig vom Webserver.",
      completed: "Operation erfolgreich abgeschlossen.",
      failed: "Operation fehlgeschlagen."
    }[job.state] || `Status: ${job.state}`;

    if (job.state === "failed") throw new Error(job.error || "Backup-Operation fehlgeschlagen");
    if (job.state === "completed") {
      databaseBackupJobProgress.style.width = "100%";
      return job.result;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function startDatabaseOperation(path, body, operation, { method = "POST" } = {}) {
  try {
    const payload = await databaseApi(path, {
      method,
      body: JSON.stringify(body)
    });
    const result = await pollDatabaseJob(payload.jobId, operation);
    return { ...result, operationJobId: String(payload.jobId) };
  } catch (error) {
    databaseBackupJob.classList.remove("d-none");
    databaseBackupJobState.textContent = "Fehler";
    databaseBackupJobMessage.textContent = error.message;
    throw error;
  } finally {
    setDatabaseControlsDisabled(false);
  }
}

databaseBackupRefresh?.addEventListener("click", () => loadDatabaseBackups());

databaseBackupCreate?.addEventListener("click", async () => {
  try {
    const result = await startDatabaseOperation(
      "/admin/accounts/database/backups",
      { label: databaseBackupLabel.value.trim() },
      "create"
    );
    databaseBackupLabel.value = "";
    await loadDatabaseBackups(result.rootKey);
  } catch {
    // The job panel already contains the actionable error.
  }
});

databaseBackupVerify?.addEventListener("click", async () => {
  if (!selectedDatabaseBackup) return;
  const rootAtStart = selectedDatabaseBackup.rootKey;
  try {
    await startDatabaseOperation(
      "/admin/accounts/database/backups/verify",
      { backupRoot: rootAtStart },
      "verify"
    );
    if (selectedDatabaseBackup?.rootKey !== rootAtStart) return;
    verifiedDatabaseBackupRoot = rootAtStart;
    databaseRestoreConfirmation.classList.remove("d-none");
    setDatabaseWizardStep("verify");
  } catch {
    verifiedDatabaseBackupRoot = null;
  }
});

databaseRestoreConfirm?.addEventListener("change", () => {
  databaseRestorePrepare.disabled = databaseOperationRunning
    || !databaseRestoreConfirm.checked
    || verifiedDatabaseBackupRoot !== selectedDatabaseBackup?.rootKey;
});

databaseRestorePrepare?.addEventListener("click", async () => {
  if (!selectedDatabaseBackup || verifiedDatabaseBackupRoot !== selectedDatabaseBackup.rootKey) return;
  const rootAtStart = selectedDatabaseBackup.rootKey;
  try {
    const result = await startDatabaseOperation(
      "/admin/accounts/database/restores/prepare",
      { backupRoot: rootAtStart, confirmed: true },
      "prepare-restore"
    );
    renderRestoreResult(result, result.operationJobId);
    setDatabaseWizardStep("restore");
  } catch {
    databaseRestoreResult.classList.add("d-none");
  }
});

databaseActivationConfirm?.addEventListener("change", () => {
  setDatabaseControlsDisabled(databaseOperationRunning);
});

databaseActivationStart?.addEventListener("click", async () => {
  if (!preparedRestoreJobId || !databaseActivationConfirm.checked) return;
  try {
    await startDatabaseOperation(
      "/admin/accounts/database/restores/activate",
      { prepareJobId: preparedRestoreJobId, confirmed: true },
      "activate-restore"
    );
    setDatabaseWizardStep("activate");
    window.location.reload();
  } catch {
    // During process restart the job panel keeps the latest actionable status.
  }
});

databaseRollbackConfirm?.addEventListener("change", () => {
  setDatabaseControlsDisabled(databaseOperationRunning);
});

databaseRollbackStart?.addEventListener("click", async () => {
  if (!databaseRollbackConfirm.checked || !databaseCatalogConfiguration?.previousDatabase) return;
  try {
    await startDatabaseOperation(
      "/admin/accounts/database/restores/rollback",
      { confirmed: true },
      "rollback"
    );
    window.location.reload();
  } catch {
    // During process restart the job panel keeps the latest actionable status.
  }
});

databaseDeleteName?.addEventListener("input", () => {
  databaseDeleteStart.disabled = databaseOperationRunning
    || !selectedCleanupDatabase
    || databaseDeleteName.value !== selectedCleanupDatabase.name;
});

databaseDeleteCancel?.addEventListener("click", closeDatabaseDeleteConfirmation);

databaseDeleteStart?.addEventListener("click", async () => {
  if (!selectedCleanupDatabase || databaseDeleteName.value !== selectedCleanupDatabase.name) return;
  const databaseName = selectedCleanupDatabase.name;
  try {
    setDatabaseDeleteResult(
      "info",
      `Sicherheitsbackup für ${databaseName} wird erstellt. Danach wird die Datenbank gelöscht ...`
    );
    const result = await startDatabaseOperation(
      `/admin/accounts/database/databases/${encodeURIComponent(databaseName)}`,
      { confirmDatabase: databaseName },
      "drop-database",
      { method: "DELETE" }
    );
    closeDatabaseDeleteConfirmation();
    await loadDatabaseBackups();
    setDatabaseDeleteResult(
      "success",
      `${databaseName} wurde gelöscht. Sicherheitsbackup: ${result.safetyBackup?.rootKey || "vollständig erstellt"}.`
    );
  } catch (error) {
    setDatabaseDeleteResult("danger", error.message);
  }
});

if (databaseBackupList) {
  loadDatabaseBackups();
}

const logicalBackupList = document.getElementById("logical-backup-list");
const logicalBackupEmpty = document.getElementById("logical-backup-empty");
const logicalBackupRefresh = document.getElementById("logical-backup-refresh");
const logicalBackupCreate = document.getElementById("logical-backup-create");
const logicalBackupMode = document.getElementById("logical-backup-mode");
const logicalBackupLabel = document.getElementById("logical-backup-label");
const logicalBackupSelected = document.getElementById("logical-backup-selected");
const logicalBackupDetail = document.getElementById("logical-backup-detail");
const logicalRestoreAccounts = document.getElementById("logical-restore-accounts");
const logicalRestoreSegments = document.getElementById("logical-restore-segments");
const logicalRestoreWorkouts = document.getElementById("logical-restore-workouts");
const logicalRestoreSource = document.getElementById("logical-restore-source");
const logicalBackupPreview = document.getElementById("logical-backup-preview");
const logicalBackupRestore = document.getElementById("logical-backup-restore");
const logicalBackupResult = document.getElementById("logical-backup-result");
let logicalBackups = [];
let selectedLogicalBackup = null;
let logicalPreviewCurrent = false;

function logicalSelections() {
  return {
    accounts: logicalRestoreAccounts.checked,
    segments: logicalRestoreSegments.checked,
    workouts: logicalRestoreWorkouts.checked,
    workoutSource: logicalRestoreSource.value
  };
}

function setLogicalResult(kind, message) {
  logicalBackupResult.className = `alert alert-${kind} mb-0`;
  logicalBackupResult.textContent = message;
}

function updateLogicalSourceOptions() {
  const artifacts = selectedLogicalBackup?.artifacts || {};
  for (const option of logicalRestoreSource.options) {
    option.disabled = option.value === "fit" ? !artifacts.workoutsFit : !artifacts.workoutsNative;
  }
  if (logicalRestoreSource.selectedOptions[0]?.disabled) {
    logicalRestoreSource.value = artifacts.workoutsNative ? "native" : "fit";
  }
  logicalRestoreSource.disabled = !logicalRestoreWorkouts.checked;
}

function invalidateLogicalPreview() {
  logicalPreviewCurrent = false;
  logicalBackupRestore.classList.add("d-none");
  updateLogicalSourceOptions();
}

function selectLogicalBackup(backup) {
  selectedLogicalBackup = backup;
  logicalBackupSelected.textContent = backup ? (backup.label || `Backup ${backup.backupId}`) : "Kein Backup ausgewählt";
  logicalBackupDetail.textContent = backup
    ? `${formatBackupDate(backup.createdAt)} · ${backup.mode.toUpperCase()} · ${backup.rootKey}`
    : "Wähle ein Backup und die gewünschten Komponenten.";
  logicalBackupPreview.disabled = !backup;
  invalidateLogicalPreview();
}

function renderLogicalBackups() {
  logicalBackupList.replaceChildren();
  logicalBackupEmpty.classList.toggle("d-none", logicalBackups.length > 0);
  for (const backup of logicalBackups) {
    const row = document.createElement("tr");
    const radioCell = document.createElement("td");
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "logical-backup-selection";
    radio.className = "form-check-input";
    radio.checked = selectedLogicalBackup?.rootKey === backup.rootKey;
    radio.addEventListener("change", () => selectLogicalBackup(backup));
    radioCell.append(radio);
    const values = [
      formatBackupDate(backup.createdAt),
      backup.label || "-",
      String(backup.mode || "-").toUpperCase(),
      backup.counts?.users || 0,
      backup.counts?.segments || 0,
      backup.counts?.workouts || 0
    ];
    row.append(radioCell);
    values.forEach((value, index) => {
      const cell = document.createElement("td");
      cell.textContent = String(value);
      if (index >= 3) cell.className = "text-end";
      row.append(cell);
    });
    row.addEventListener("click", (event) => {
      if (event.target !== radio) {
        radio.checked = true;
        selectLogicalBackup(backup);
      }
    });
    logicalBackupList.append(row);
  }
}

async function loadLogicalBackups(preselectRoot = null) {
  const payload = await databaseApi("/admin/accounts/logical/backups");
  logicalBackups = payload.catalog?.backups || [];
  if (preselectRoot) selectedLogicalBackup = logicalBackups.find((item) => item.rootKey === preselectRoot) || null;
  else if (selectedLogicalBackup) selectedLogicalBackup = logicalBackups.find((item) => item.rootKey === selectedLogicalBackup.rootKey) || null;
  renderLogicalBackups();
  selectLogicalBackup(selectedLogicalBackup);
}

async function runLogicalJob(path, body) {
  const queued = await databaseApi(path, { method: "POST", body: JSON.stringify(body) });
  logicalBackupCreate.disabled = true;
  logicalBackupPreview.disabled = true;
  logicalBackupRestore.disabled = true;
  try {
    while (true) {
      const payload = await databaseApi(`/admin/accounts/database/jobs/${encodeURIComponent(queued.jobId)}`);
      const job = payload.job;
      const percent = Number(job.progress?.percent ?? job.progress ?? 0) || 0;
      setLogicalResult("info", `${job.progress?.phase || job.state} · ${percent}%`);
      if (job.state === "failed") throw new Error(job.error || "Logische Backup-Operation fehlgeschlagen.");
      if (job.state === "completed") return job.result;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } finally {
    logicalBackupCreate.disabled = false;
    logicalBackupPreview.disabled = !selectedLogicalBackup;
    logicalBackupRestore.disabled = false;
  }
}

logicalBackupRefresh?.addEventListener("click", async () => {
  try { await loadLogicalBackups(); } catch (error) { setLogicalResult("danger", error.message); }
});

logicalBackupCreate?.addEventListener("click", async () => {
  try {
    setLogicalResult("info", "Logisches Backup wird vorbereitet ...");
    const created = await runLogicalJob("/admin/accounts/logical/backups", {
      mode: logicalBackupMode.value,
      label: logicalBackupLabel.value
    });
    await loadLogicalBackups(created.rootKey);
    setLogicalResult("success", `${created.counts.workouts} Workouts, ${created.counts.segments} Segmente und ${created.counts.users} Konten gesichert.`);
  } catch (error) {
    setLogicalResult("danger", error.message);
  }
});

for (const control of [logicalRestoreAccounts, logicalRestoreSegments, logicalRestoreWorkouts, logicalRestoreSource]) {
  control?.addEventListener("change", invalidateLogicalPreview);
}

logicalBackupPreview?.addEventListener("click", async () => {
  if (!selectedLogicalBackup) return;
  const selections = logicalSelections();
  if (!selections.accounts && !selections.segments && !selections.workouts) {
    setLogicalResult("warning", "Bitte mindestens eine Komponente auswählen.");
    return;
  }
  try {
    const preview = await runLogicalJob("/admin/accounts/logical/backups/preview", {
      backupRoot: selectedLogicalBackup.rootKey,
      selections
    });
    const parts = [];
    if (selections.accounts) parts.push(`${preview.manifest.counts.users} Konten`);
    if (selections.segments) parts.push(`${preview.segments.totals.importable} neue Segmente, ${preview.segments.totals.duplicates} Duplikate`);
    if (selections.workouts) parts.push(`${preview.workouts.totals.importable} neue Workouts, ${preview.workouts.totals.duplicates} Duplikate`);
    const conflicts = Number(preview.segments?.totals?.conflicts || 0) + Number(preview.workouts?.totals?.conflicts || 0);
    logicalPreviewCurrent = conflicts === 0;
    logicalBackupRestore.classList.toggle("d-none", !logicalPreviewCurrent);
    setLogicalResult(conflicts ? "danger" : "success", `${parts.join(" · ")}${conflicts ? ` · ${conflicts} Zuordnungskonflikte` : ""}`);
  } catch (error) {
    invalidateLogicalPreview();
    setLogicalResult("danger", error.message);
  }
});

logicalBackupRestore?.addEventListener("click", async () => {
  if (!selectedLogicalBackup || !logicalPreviewCurrent) return;
  if (!window.confirm("Ausgewählte Komponenten jetzt per Safe Merge wiederherstellen? Es wird nichts gelöscht.")) return;
  try {
    const restored = await runLogicalJob("/admin/accounts/logical/restores", {
      backupRoot: selectedLogicalBackup.rootKey,
      selections: logicalSelections(),
      confirmed: true
    });
    const parts = [];
    if (restored.accounts) parts.push(`${restored.accounts.users || 0} Konten`);
    if (restored.segments) parts.push(`${restored.segments.imported || 0} Segmente`);
    if (restored.workouts) parts.push(`${restored.workouts.imported || 0} Workouts`);
    invalidateLogicalPreview();
    setLogicalResult("success", `${parts.join(" · ")} wiederhergestellt.`);
  } catch (error) {
    setLogicalResult("danger", error.message);
  }
});

if (logicalBackupList) {
  loadLogicalBackups().catch((error) => setLogicalResult("danger", error.message));
}
