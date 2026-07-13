const form = document.getElementById("uploadForm");
const fileInput = document.getElementById("file");
const filePickerButton = document.getElementById("filePickerButton");
const filePickerLabel = document.getElementById("filePickerLabel");
const overwriteExistingWorkoutsCheckbox = document.getElementById("overwriteExistingWorkouts");
const submitButton = document.getElementById("submitButton");
const response = document.getElementById("response");
const statusArea = document.getElementById("statusArea");
const phaseText = document.getElementById("phaseText");
const uploadProgressBar = document.getElementById("uploadProgressBar");
const uploadPercentText = document.getElementById("uploadPercentText");
const uploadDetailText = document.getElementById("uploadDetailText");
const processingProgressBar = document.getElementById("processingProgressBar");
const processingPercentText = document.getElementById("processingPercentText");
const processingDetailText = document.getElementById("processingDetailText");
const processingLabel = document.getElementById("processingLabel");
const uploadShell = document.getElementById("upload-shell");
const i18nMessages = window.__I18N?.messages || {};
const activeLocale = window.__I18N?.locale || navigator.language || "en";
let latestGeneratedZipArtifact = null;
let currentDeviceProfile = window.getDeviceProfile?.() || window.__DEVICE_PROFILE__ || null;
let prewarmedUploadWorker = null;
let pendingZipPreparations = new Map();
let isUploadSubmitting = false;

function traceMark(name, detail = null) {
    try {
        if (detail && typeof detail === "object") {
            performance.mark(name, { detail });
        } else {
            performance.mark(name);
        }
    } catch (_) {
        try {
            performance.mark(name);
        } catch (_) {
            // Ignore tracing errors.
        }
    }

    try {
        if (typeof console.timeStamp === "function") {
            console.timeStamp(detail ? `${name} ${JSON.stringify(detail)}` : name);
        }
    } catch (_) {
        // Ignore tracing errors.
    }
}

function traceMeasure(name, startMark, endMark) {
    try {
        performance.measure(name, startMark, endMark);
    } catch (_) {
        // Ignore tracing errors.
    }
}

initializeClientLayout();
form?.addEventListener("submit", handleConvertSubmit);
filePickerButton?.addEventListener("click", () => fileInput?.click());
fileInput?.addEventListener("change", handleFileSelectionChange);
window.addEventListener("deviceprofilechange", (event) => {
    currentDeviceProfile = event.detail || window.getDeviceProfile?.() || null;
    applyDeviceProfileToUploadShell();
});
queueMicrotask(() => {
    prewarmUploadWorkers();
});

function tr(path, fallback) {
    const parts = String(path || "").split(".");
    let current = i18nMessages;

    for (const part of parts) {
        if (!current || typeof current !== "object" || !(part in current)) {
            return fallback;
        }
        current = current[part];
    }

    return typeof current === "string" ? current : fallback;
}

function initializeClientLayout() {
    if (!uploadShell) {
        return;
    }

    let rafId = null;
    let resizeObserver = null;

    const measure = () => {
        const container = document.querySelector(".upload-client-container");
        const bodyStyles = window.getComputedStyle(document.body);
        const containerStyles = container ? window.getComputedStyle(container) : null;
        const bodyOffsetTop = parseFloat(bodyStyles.paddingTop || "0") || 0;
        const paddingTop = containerStyles ? parseFloat(containerStyles.paddingTop || "0") : 0;
        const paddingBottom = containerStyles ? parseFloat(containerStyles.paddingBottom || "0") : 0;
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
        const minHeight = currentDeviceProfile?.isMobileLayout ? 0 : 560;
        const availableHeight = Math.max(minHeight, viewportHeight - bodyOffsetTop - paddingTop - paddingBottom);
        uploadShell.style.setProperty("--upload-client-height", `${availableHeight}px`);
        uploadShell.classList.add("upload-shell--client");
        applyDeviceProfileToUploadShell();
    };

    const schedule = () => {
        if (rafId) {
            window.cancelAnimationFrame(rafId);
        }
        rafId = window.requestAnimationFrame(() => {
            rafId = null;
            measure();
        });
    };

    window.addEventListener("resize", schedule);

    if (typeof ResizeObserver === "function") {
        const topbar = document.querySelector(".app-topbar");
        const hero = document.querySelector(".upload-hero");
        resizeObserver = new ResizeObserver(() => {
            schedule();
        });
        [topbar, hero, uploadShell].filter(Boolean).forEach((element) => resizeObserver.observe(element));
    }

    schedule();
}

function applyDeviceProfileToUploadShell() {
    if (!uploadShell) {
        return;
    }

    const profile = currentDeviceProfile || window.getDeviceProfile?.() || {};
    uploadShell.classList.toggle("upload-shell--mobile-layout", !!profile.isMobileLayout);
    uploadShell.classList.toggle("upload-shell--compact-layout", !!profile.isCompactLayout);
    uploadShell.dataset.mobileLayout = profile.isMobileLayout ? "1" : "0";
}

function updateFilePickerLabel() {
    const files = Array.from(fileInput?.files || []);
    if (files.length === 0) {
        filePickerLabel.textContent = tr("uploadPage.noFilesSelected", "No file selected");
        return;
    }
    if (files.length === 1) {
        filePickerLabel.textContent = files[0].name;
        return;
    }
    filePickerLabel.textContent = `${files.length} ${tr("uploadPage.woaFilesSelectedSuffix", "files selected")}`;
}

function resetPendingZipPreparation() {
    pendingZipPreparations = new Map();
    refreshSubmitAvailability();
}

function hasPendingZipPreparation() {
    return Array.from(pendingZipPreparations.values())
        .some((preparation) => preparation.status === "pending");
}

function refreshSubmitAvailability() {
    if (submitButton) {
        submitButton.disabled = isUploadSubmitting || hasPendingZipPreparation();
    }
}

function buildZipPreparationToken(file) {
    return [
        String(file?.name || ""),
        Number(file?.size || 0),
        Number(file?.lastModified || 0)
    ].join("::");
}

function scheduleZipPreparationForSelection() {
    traceMark("upload.reprewarm.begin");
    resetPendingZipPreparation();
    const files = Array.from(fileInput?.files || []);
    const zipFiles = files.filter((file) => String(file?.name || "").toLowerCase().endsWith(".zip"));
    if (zipFiles.length === 0) {
        traceMark("upload.reprewarm.end", { zipFileCount: 0 });
        traceMeasure("upload.reprewarm", "upload.reprewarm.begin", "upload.reprewarm.end");
        return;
    }

    let remainingPreparations = zipFiles.length;
    let didMarkCompletion = false;
    const maybeMarkReprewarmComplete = () => {
        remainingPreparations -= 1;
        if (!didMarkCompletion && remainingPreparations <= 0) {
            didMarkCompletion = true;
            traceMark("upload.reprewarm.end", { zipFileCount: zipFiles.length });
            traceMeasure("upload.reprewarm", "upload.reprewarm.begin", "upload.reprewarm.end");
        }
    };

    for (const selectedZip of zipFiles) {
        const token = buildZipPreparationToken(selectedZip);
        const pendingPreparation = {
            token,
            fileName: selectedZip.name,
            fileSize: Number(selectedZip.size || 0),
            status: "pending",
            promise: null
        };
        pendingZipPreparations.set(token, pendingPreparation);

        pendingPreparation.promise = (async () => {
        try {
            const startedAt = performance.now();
            const arrayBuffer = await selectedZip.arrayBuffer();
            const activePreparation = pendingZipPreparations.get(token);
            if (!activePreparation) {
                return;
            }
            const worker = getUploadWorker();
            const result = await new Promise((resolve, reject) => {
                const handleMessage = (workerEvent) => {
                    const data = workerEvent.data || {};
                    if (data.type !== "zip-prepare-complete" || data.token !== token) {
                        return;
                    }
                    worker.removeEventListener("message", handleMessage);
                    worker.removeEventListener("error", handleError);
                    resolve(data);
                };
                const handleError = (errorEvent) => {
                    worker.removeEventListener("message", handleMessage);
                    worker.removeEventListener("error", handleError);
                    reject(errorEvent.error || new Error(errorEvent.message || "ZIP prewarm failed"));
                };
                worker.addEventListener("message", handleMessage);
                worker.addEventListener("error", handleError, { once: true });
                worker.postMessage({
                    type: "prepare-zip-source",
                    token,
                    fileName: selectedZip.name,
                    arrayBuffer
                }, [arrayBuffer]);
            });
            const currentPreparation = pendingZipPreparations.get(token);
            if (currentPreparation) {
                if (result?.error) {
                    currentPreparation.status = "failed";
                    currentPreparation.error = result.error;
                } else {
                    currentPreparation.status = "ready";
                    currentPreparation.stats = result;
                }
            }
        } catch (error) {
            const currentPreparation = pendingZipPreparations.get(token);
            if (currentPreparation) {
                currentPreparation.status = "failed";
                currentPreparation.error = error instanceof Error ? error.message : String(error);
            }
        } finally {
            maybeMarkReprewarmComplete();
            refreshSubmitAvailability();
        }
        })();
    }

    refreshSubmitAvailability();
}

function handleFileSelectionChange() {
    updateFilePickerLabel();
    scheduleZipPreparationForSelection();
}

async function awaitPreparedZipForFile(file) {
    if (!file) {
        return null;
    }
    const token = buildZipPreparationToken(file);
    const pendingZipPreparation = pendingZipPreparations.get(token);
    if (!pendingZipPreparation) {
        return null;
    }
    if (pendingZipPreparation.status === "pending" && pendingZipPreparation.promise) {
        await pendingZipPreparation.promise;
    }
    const currentPreparation = pendingZipPreparations.get(token);
    if (!currentPreparation) {
        return null;
    }
    return currentPreparation;
}

function consumePreparedZipForFile(file) {
    if (!file) {
        return;
    }
    const token = buildZipPreparationToken(file);
    pendingZipPreparations.delete(token);
}

function prepareCurrentSelectionForNextSubmit() {
    scheduleZipPreparationForSelection();
    setLoading(false);
}

function setResponseMarkup(markup) {
    if (response) {
        response.innerHTML = markup;
    }
}

function setLoading(isLoading) {
    isUploadSubmitting = isLoading;
    refreshSubmitAvailability();
}

function renderBackendUploadState(markup) {
    const resultNode = document.getElementById("backendUploadResult");
    if (resultNode) {
        resultNode.innerHTML = markup;
    }
}

function setPhase(text) {
    if (phaseText) {
        phaseText.textContent = text;
    }
}

function setReadProgress(percent, detailText = "") {
    if (uploadProgressBar) {
        uploadProgressBar.style.width = `${percent}%`;
        uploadProgressBar.setAttribute("aria-valuenow", String(percent));
    }
    if (uploadPercentText) {
        uploadPercentText.textContent = `${Math.round(percent)}%`;
    }
    if (uploadDetailText) {
        uploadDetailText.textContent = detailText;
    }
}

function setProcessingProgress(percent, detailText = "") {
    if (processingProgressBar) {
        processingProgressBar.style.width = `${percent}%`;
        processingProgressBar.setAttribute("aria-valuenow", String(percent));
    }
    if (processingPercentText) {
        processingPercentText.textContent = `${Math.round(percent)}%`;
    }
    if (processingDetailText) {
        processingDetailText.textContent = detailText;
    }
}

function setProcessingLabel(text) {
    if (processingLabel) {
        processingLabel.textContent = text;
    }
}

function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function formatMs(value) {
    return `${Number(value || 0).toFixed(1)} ms`;
}

function formatLocalDateTime(value) {
    if (!value) {
        return "";
    }

    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
        return String(value);
    }

    return new Intl.DateTimeFormat(activeLocale, {
        dateStyle: "medium",
        timeStyle: "short"
    }).format(date);
}

function buildTimingLines(timings = {}) {
    if (!timings || typeof timings !== "object") {
        return "";
    }

    const orderedKeys = [
        "buildReducedGpsTrackMs",
        "buildWorkoutStreamBlockMs",
        "buildGpsTrackBlockMs",
        "compressWorkoutStreamMs",
        "compressGpsTrackMs",
        "deriveSummaryMs",
        "encodeMetaJsonMs",
        "encodeSessionsJsonMs",
        "assembleWoaFileMs"
    ];
    const labels = {
        buildReducedGpsTrackMs: tr("uploadPage.woaTimingBuildReducedGpsTrack", "Build reduced GPS track"),
        buildWorkoutStreamBlockMs: tr("uploadPage.woaTimingBuildWorkoutStreamBlock", "Build workout stream block"),
        buildGpsTrackBlockMs: tr("uploadPage.woaTimingBuildGpsTrackBlock", "Build GPS track block"),
        compressWorkoutStreamMs: tr("uploadPage.woaTimingCompressWorkoutStream", "Compress workout stream"),
        compressGpsTrackMs: tr("uploadPage.woaTimingCompressGpsTrack", "Compress GPS track"),
        deriveSummaryMs: tr("uploadPage.woaTimingDeriveSummary", "Derive persisted summary"),
        encodeMetaJsonMs: tr("uploadPage.woaTimingEncodeMetaJson", "Encode meta JSON"),
        encodeSessionsJsonMs: tr("uploadPage.woaTimingEncodeSessionsJson", "Encode sessions JSON"),
        assembleWoaFileMs: tr("uploadPage.woaTimingAssembleWoaFile", "Assemble WOA file")
    };

    return orderedKeys
        .filter((key) => Number.isFinite(Number(timings[key])))
        .map((key) => `${labels[key]}: ${escapeHtml(formatMs(timings[key]))}`)
        .join("<br>");
}

function buildWorkoutStreamStatLines(stats = {}) {
    if (!stats || typeof stats !== "object") {
        return "";
    }

    const fallbackWorkoutCount = Number(stats.fallbackWorkoutCount || 0);
    const fallbackRecordCount = Number(stats.fallbackRecordCount || 0);

    return [
        `Workouts mit Speed-Fallback: ${escapeHtml(String(fallbackWorkoutCount))}`,
        `Records mit Speed-Fallback: ${escapeHtml(String(fallbackRecordCount))}`
    ].join("<br>");
}

function buildStartupTimingLines(timings = {}) {
    if (!timings || typeof timings !== "object") {
        return "";
    }

    const orderedKeys = [
        "readSourceMs",
        "fetchExistingStartTimesMs",
        "workerBootstrapMs",
        "fitWorkerPoolWarmMs",
        "unzipSyncMs",
        "entryScanMs",
        "zipOpenMs",
        "firstFitDispatchMs",
        "firstFitResultMs"
    ];
    const labels = {
        readSourceMs: "Quelldateien lesen",
        fetchExistingStartTimesMs: "Vorhandene Workouts laden",
        workerBootstrapMs: "Worker-Start bis erster Kontakt",
        fitWorkerPoolWarmMs: "FIT-Worker-Pool warmziehen",
        unzipSyncMs: "ZIP entpacken",
        entryScanMs: "ZIP-Entries einsammeln",
        zipOpenMs: "ZIP oeffnen",
        firstFitDispatchMs: "Bis erster FIT-Dispatch",
        firstFitResultMs: "Bis erstes FIT-Ergebnis"
    };

    return orderedKeys
        .filter((key) => Number.isFinite(Number(timings[key])))
        .map((key) => `${labels[key]}: ${escapeHtml(formatMs(timings[key]))}`)
        .join("<br>");
}

function getEncodingOptions() {
    let uploadCompression = "auto";
    let uploadGzipEngine = "compression-stream";
    let gpsSampleRateSeconds = null;
    let gpsCoordinateEncoding = "bitmap-columnar";
    try {
        const value = String(localStorage.getItem("woaUploadCompression") || "").trim().toLowerCase();
        if (value === "gzip" || value === "brotli" || value === "br") {
            uploadCompression = value === "br" ? "brotli" : value;
        }
    } catch {
        // ignore
    }
    try {
        const value = String(localStorage.getItem("woaUploadGzipEngine") || "").trim().toLowerCase();
        if (value === "fflate" || value === "compression-stream" || value === "native") {
            uploadGzipEngine = value === "native" ? "compression-stream" : value;
        }
    } catch {
        // ignore
    }
    try {
        const raw = Number.parseInt(localStorage.getItem("woaGpsSampleRateSeconds") || "", 10);
        if (Number.isInteger(raw) && raw >= 1 && raw <= 60) {
            gpsSampleRateSeconds = raw;
        }
    } catch {
        // ignore
    }
    try {
        const value = String(localStorage.getItem("woaGpsCoordinateEncoding") || "").trim().toLowerCase();
        if (value === "int16-escape" || value === "int16") {
            gpsCoordinateEncoding = "int16-escape";
        } else if (value === "tiered-int8" || value === "tiered") {
            gpsCoordinateEncoding = "tiered-int8";
        } else if (value === "bitmap-columnar" || value === "columnar") {
            gpsCoordinateEncoding = "bitmap-columnar";
        }
    } catch {
        // ignore
    }
    return {
        gentleQuantization: true,
        powerStep: 4,
        cadenceStep: 2,
        hrStep: 2,
        gpsSampleRateSeconds,
        gpsCoordinateEncoding,
        uploadCompression,
        uploadGzipEngine
    };
}

function isOverwriteExistingWorkoutsEnabled() {
    return !!overwriteExistingWorkoutsCheckbox?.checked;
}

function getUploadTransportMode() {
    try {
        const value = localStorage.getItem("woaUploadTransportMode");
        return value === "zip" || value === "container-gzip"
            ? value
            : "container-gzip";
    } catch {
        return "container-gzip";
    }
}

function isParallelFitPoolEnabled() {
    try {
        const value = localStorage.getItem("woaParallelFitPool");
        return value !== "0";
    } catch {
        return true;
    }
}

function getParallelFitWorkerCount() {
    try {
        const raw = Number.parseInt(localStorage.getItem("woaParallelFitWorkers") || "", 10);
        if (Number.isInteger(raw) && raw >= 1 && raw <= 8) {
            return raw;
        }
    } catch {
        // ignore
    }
    return null;
}

function getUploadWorker() {
    if (!prewarmedUploadWorker) {
        prewarmedUploadWorker = new Worker("/js/upload-new-worker.js", { type: "module" });
    }
    return prewarmedUploadWorker;
}

function prewarmUploadWorkers() {
    const worker = getUploadWorker();
    worker.postMessage({
        type: "prewarm-fit-worker-pool",
        enabled: isParallelFitPoolEnabled(),
        workerCount: getParallelFitWorkerCount()
    });
}

function buildIterationSuffix(data) {
    const iteration = Number(data?.iteration || 0);
    const totalIterations = Number(data?.totalIterations || 0);
    if (iteration > 0 && totalIterations > 0) {
        return ` (${iteration}/${totalIterations})`;
    }
    return "";
}

function buildBackendUploadPendingMarkup() {
    return `
        <div class="alert alert-info mb-0 mt-2">
            <div class="fw-semibold mb-1">${escapeHtml(tr("uploadPage.woaBackendUploadRunning", "Uploading generated WOA1 ZIP to backend."))}</div>
            <div class="small text-muted">${escapeHtml(tr("uploadPage.woaBackendUploadTrackedInProgress", "Progress is shown in the status panel on the right."))}</div>
        </div>
    `;
}

async function uploadGeneratedZipArtifact() {
    if (!latestGeneratedZipArtifact?.blob || !latestGeneratedZipArtifact?.fileName) {
        return;
    }

    const overwriteExisting = isOverwriteExistingWorkoutsEnabled();

    renderBackendUploadState(buildBackendUploadPendingMarkup());
    setProcessingLabel(tr("uploadPage.woaUploadAndStore", "Upload and store"));
    setPhase(tr("uploadPage.woaPhaseUploadingBackend", "Uploading to backend"));
    setProcessingProgress(0, tr("uploadPage.woaPreparingRequest", "Preparing request"));

    try {
        let payload;
        const handleProgress = ({ loaded, total, percent }) => {
            const detailText = total > 0
                ? `${formatBytes(loaded)} / ${formatBytes(total)}`
                : `${formatBytes(loaded)} ${tr("uploadPage.woaUploadedSuffix", "uploaded")}`;
            setPhase(tr("uploadPage.woaPhaseUploadingBackend", "Uploading to backend"));
            setProcessingProgress(percent, detailText);
        };
        const handleUploadComplete = () => {
            setProcessingLabel(tr("uploadPage.woaServerProcessing", "Server processing"));
            setPhase(tr("uploadPage.woaPhaseBackendProcessing", "Backend processing"));
            setProcessingProgress(100, tr("uploadPage.woaBackendProcessingDetail", "Upload finished, waiting for backend response"));
        };

        if (latestGeneratedZipArtifact.uploadMode === "raw") {
            payload = await uploadGeneratedRawBlob(
                latestGeneratedZipArtifact.blob,
                latestGeneratedZipArtifact.fileName,
                latestGeneratedZipArtifact.uploadUrl,
                overwriteExisting,
                handleProgress,
                handleUploadComplete
            );
        } else {
            const formData = new FormData();
            formData.append("file", latestGeneratedZipArtifact.blob, latestGeneratedZipArtifact.fileName);
            formData.append("overwriteExisting", overwriteExisting ? "1" : "0");
            payload = await uploadGeneratedZipFormData(
                formData,
                latestGeneratedZipArtifact.uploadUrl,
                handleProgress,
                handleUploadComplete
            );
        }

        setProcessingLabel(tr("uploadPage.woaCompletedLabel", "Completed"));
        setPhase(tr("uploadPage.woaPhaseCompleted", "Completed"));
        setProcessingProgress(100, tr("uploadPage.woaBackendUploadCompleted", "Backend upload completed."));
        renderBackendUploadState(`
            <div class="alert alert-info mb-0 mt-2">
                <div class="fw-semibold mb-2">${escapeHtml(tr("uploadPage.woaBackendUploadCompleted", "Backend upload completed."))}</div>
                <div class="small">
                    Imported workouts: ${escapeHtml(String(payload.importedCount || 0))}<br>
                    Skipped workouts: ${escapeHtml(String(payload.skippedCount || 0))}<br>
                    ZIP entries seen: ${escapeHtml(String(payload.totalEntries || 0))}<br>
                    Backend elapsed: ${escapeHtml(formatMs(payload.elapsedMs))}<br>
                    HTTP roundtrip: ${escapeHtml(formatMs(payload.httpElapsedMs))}
                </div>
            </div>
        `);
    } catch (error) {
        setProcessingLabel(tr("uploadPage.woaUploadAndStore", "Upload and store"));
        setPhase(tr("uploadPage.woaPhaseFailed", "Failed"));
        setProcessingProgress(0, tr("uploadPage.woaBackendUploadFailed", "Backend upload failed"));
        renderBackendUploadState(`<div class="alert alert-danger mb-0 mt-2">${escapeHtml(error?.message || String(error))}</div>`);
    }
}

function renderCompletedContainerMarkup({
    title,
    fileName,
    stats = {},
    skipped = [],
    skippedExisting = [],
    skippedTooShort = [],
    timings = {},
    backendMarkup
}) {
    const compressionRatio = Number(stats.sourceZipBytes || 0) > 0 && Number(stats.outputContainerBytes || 0) > 0
        ? ((Number(stats.outputContainerBytes || 0) / Number(stats.sourceZipBytes || 1)) * 100).toFixed(1)
        : "0.0";
    const containerCompression = String(stats.containerCompression || "gzip").toLowerCase() === "brotli"
        ? "brotli"
        : "gzip";
    const containerCompressionDetail = containerCompression === "gzip"
        ? `${containerCompression}${stats.containerCompressionEngine ? `/${escapeHtml(String(stats.containerCompressionEngine))}` : ` level ${escapeHtml(String(stats.containerGzipLevel || 0))}`}`
        : containerCompression;
    const skippedMarkup = skipped.length > 0
        ? `
            <div class="small mb-3 text-warning">
                Skipped FIT entries: ${escapeHtml(String(stats.skippedEntries || skipped.length))}<br>
                ${skipped.slice(0, 10).map((item) => `${escapeHtml(item.entryName)}: ${escapeHtml(item.error)}`).join("<br>")}
                ${skipped.length > 10 ? "<br>..." : ""}
            </div>
        `
        : "";
    const skippedExistingMarkup = skippedExisting.length > 0
        ? `
            <div class="small mb-3 text-info">
                Already existing workouts skipped before WOA build: ${escapeHtml(String(stats.skippedExistingEntries || skippedExisting.length))}<br>
                ${skippedExisting.slice(0, 10).map((item) => `${escapeHtml(item.entryName)}: ${escapeHtml(formatLocalDateTime(item.startTime || ""))}`).join("<br>")}
                ${skippedExisting.length > 10 ? "<br>..." : ""}
            </div>
        `
        : "";
    const skippedTooShortMarkup = skippedTooShort.length > 0
        ? `
            <div class="small mb-3 text-info">
                Too-short workouts skipped before WOA build: ${escapeHtml(String(stats.skippedTooShortEntries || skippedTooShort.length))}<br>
                ${skippedTooShort.slice(0, 10).map((item) => `${escapeHtml(item.entryName)}: ${escapeHtml(String(item.recordCount || 0))} records`).join("<br>")}
                ${skippedTooShort.length > 10 ? "<br>..." : ""}
            </div>
        `
        : "";

    return `
        <div class="alert alert-success">
            <div class="fw-semibold mb-2">${escapeHtml(title)}</div>
            <div class="small mb-3">
                Source ZIP: ${escapeHtml(fileName || "")}<br>
                FIT entries seen: ${escapeHtml(String(stats.fitEntries || 0))}<br>
                WOA entries passed through: ${escapeHtml(String(stats.passedThroughEntries || 0))}<br>
                Successfully converted: ${escapeHtml(String(stats.convertedEntries || 0))}<br>
                Total records: ${escapeHtml(String(stats.totalRecordCount || 0))}<br>
                Reduced GPS points: ${escapeHtml(String(stats.totalGpsPointCount || 0))}<br>
                Source ZIP size: ${escapeHtml(formatBytes(Number(stats.sourceZipBytes || 0)))}<br>
                ${Number(stats.outputContainerBytes || 0) > 0
                    ? `Output container size: ${escapeHtml(formatBytes(Number(stats.outputContainerBytes || 0)))} (${escapeHtml(compressionRatio)}% of source ZIP, ${containerCompressionDetail})`
                    : `Output container is streamed directly to the backend.`
                }<br>
                GPS coordinate encoding: ${escapeHtml(String(stats.gpsCoordinateEncoding || "bitmap-columnar"))}
            </div>
            ${skippedExistingMarkup}
            ${skippedTooShortMarkup}
            ${skippedMarkup}
            <div class="small mb-3">
                Average parse FIT: ${escapeHtml(formatMs(timings.parseMs))}<br>
                Average build WOA1: ${escapeHtml(formatMs(timings.buildWoaMs))}<br>
                ${buildWorkoutStreamStatLines(timings.workoutStreamStats) ? `${buildWorkoutStreamStatLines(timings.workoutStreamStats)}<br>` : ""}
                ${buildTimingLines(timings.buildWoaStepsMs) ? `${buildTimingLines(timings.buildWoaStepsMs)}<br>` : ""}
                ${Number.isFinite(Number(timings.containerBuildMs)) && Number(timings.containerBuildMs) > 0
                    ? `Build output container: ${escapeHtml(formatMs(timings.containerBuildMs))}<br>`
                    : ""
                }
                Total worker time: ${escapeHtml(formatMs(timings.totalMs))}
            </div>
            <div class="small mb-3 text-muted">Sanfte Kompression aktiv: 4 W / 2 rpm / 2 bpm</div>
            <div id="backendUploadResult">${backendMarkup || ""}</div>
        </div>
    `;
}

function setLatestGeneratedZipArtifactSingle(blob, fileName, uploadUrl = "/api/uploads/woa-zip", uploadMode = "form-data") {
    latestGeneratedZipArtifact = { blob, fileName, uploadUrl, uploadMode };
}

async function fetchExistingWorkoutStartTimes() {
    const response = await fetch("/api/uploads/existing-start-times", {
        credentials: "same-origin",
        headers: {
            Accept: "application/json"
        }
    });

    let payload = {};
    try {
        payload = await response.json();
    } catch {
        payload = {};
    }

    if (!response.ok) {
        throw new Error(payload?.error || `${tr("uploadPage.woaLoadExistingFailed", "Failed to load existing workouts")} (${response.status})`);
    }

    return Array.isArray(payload.startTimes)
        ? payload.startTimes.filter((value) => typeof value === "string" && value)
        : [];
}

function uploadGeneratedZipFormData(formData, uploadUrl, onProgress, onUploadComplete) {
    return new Promise((resolve, reject) => {
        const request = new XMLHttpRequest();
        const startedAt = performance.now();
        let uploadCompleted = false;

        request.open("POST", uploadUrl || "/api/uploads/woa-zip", true);
        request.responseType = "text";

        request.upload.addEventListener("progress", (event) => {
            if (!onProgress) {
                return;
            }
            const loaded = Number(event.loaded || 0);
            const total = Number(event.total || 0);
            const percent = total > 0 ? (loaded / total) * 100 : 0;
            onProgress({ loaded, total, percent });
        });

        request.upload.addEventListener("load", () => {
            if (uploadCompleted) {
                return;
            }
            uploadCompleted = true;
            if (onUploadComplete) {
                onUploadComplete();
            }
        });

        request.addEventListener("load", () => {
            const httpElapsedMs = performance.now() - startedAt;
            let payload = {};

            try {
                payload = request.responseText ? JSON.parse(request.responseText) : {};
            } catch {
                payload = {};
            }

            if (request.status >= 200 && request.status < 300) {
                resolve({
                    ...payload,
                    httpElapsedMs
                });
                return;
            }

            reject(new Error(payload?.error || `${tr("uploadPage.woaUploadFailed", "Upload failed with status")} ${request.status}`));
        });

        request.addEventListener("error", () => {
            reject(new Error(tr("uploadPage.woaNetworkUploadError", "Network error while uploading generated WOA1 ZIP")));
        });

        request.addEventListener("abort", () => {
            reject(new Error(tr("uploadPage.woaUploadAborted", "Upload aborted")));
        });

        request.send(formData);
    });
}

function uploadGeneratedRawBlob(blob, fileName, uploadUrl, overwriteExisting, onProgress, onUploadComplete) {
    return new Promise((resolve, reject) => {
        const request = new XMLHttpRequest();
        const startedAt = performance.now();
        let uploadCompleted = false;

        request.open("POST", uploadUrl, true);
        request.responseType = "text";
        request.setRequestHeader("Content-Type", "application/octet-stream");
        request.setRequestHeader("X-Upload-Filename", fileName || "upload.woat.gz");
        request.setRequestHeader(
            "X-Upload-Compression",
            String(fileName || "").toLowerCase().endsWith(".br") ? "br" : "gzip"
        );
        if (overwriteExisting) {
            request.setRequestHeader("X-Overwrite-Existing", "1");
        }

        request.upload.addEventListener("progress", (event) => {
            if (!onProgress) {
                return;
            }
            const loaded = Number(event.loaded || 0);
            const total = Number(event.total || 0);
            const percent = total > 0 ? (loaded / total) * 100 : 0;
            onProgress({ loaded, total, percent });
        });

        request.upload.addEventListener("load", () => {
            if (uploadCompleted) {
                return;
            }
            uploadCompleted = true;
            if (onUploadComplete) {
                onUploadComplete();
            }
        });

        request.addEventListener("load", () => {
            let payload = {};
            try {
                payload = request.responseText ? JSON.parse(request.responseText) : {};
            } catch {
                payload = {};
            }

            if (request.status >= 200 && request.status < 300) {
                payload.httpElapsedMs = performance.now() - startedAt;
                resolve(payload);
                return;
            }

            reject(new Error(payload?.error || `Upload failed (${request.status})`));
        });

        request.addEventListener("error", () => {
            reject(new Error(tr("uploadPage.woaNetworkUploadError", "Network error while uploading generated WOA1 ZIP")));
        });

        request.send(blob);
    });
}

async function handleConvertSubmit(event) {
    event.preventDefault();
    traceMark("upload.submit.begin");

    if (hasPendingZipPreparation()) {
        traceMark("upload.submit.end", { reason: "pending-zip-preparation" });
        traceMeasure("upload.submit", "upload.submit.begin", "upload.submit.end");
        setResponseMarkup(`<div class="alert alert-info mb-0">${escapeHtml(tr("uploadPage.woaPreparingZipInBackground", "Preparing selected ZIP files. Please wait a moment."))}</div>`);
        return;
    }

    latestGeneratedZipArtifact = null;

    const files = Array.from(fileInput?.files || []);
    setResponseMarkup("");

    if (files.length === 0) {
        traceMark("upload.submit.end", { reason: "no-files" });
        traceMeasure("upload.submit", "upload.submit.begin", "upload.submit.end");
        setResponseMarkup(`<div class="alert alert-danger mb-0">${escapeHtml(tr("uploadPage.woaSelectOneOrMore", "Please select one or more FIT or ZIP files."))}</div>`);
        return;
    }

    const zipFiles = files.filter((file) => file.name.toLowerCase().endsWith(".zip"));
    const fitFiles = files.filter((file) => file.name.toLowerCase().endsWith(".fit"));
    const unsupportedFiles = files.filter((file) => {
        const lowerName = file.name.toLowerCase();
        return !lowerName.endsWith(".fit") && !lowerName.endsWith(".zip");
    });

    if (unsupportedFiles.length > 0) {
        traceMark("upload.submit.end", { reason: "unsupported-files" });
        traceMeasure("upload.submit", "upload.submit.begin", "upload.submit.end");
        setResponseMarkup(`<div class="alert alert-danger mb-0">${escapeHtml(tr("uploadPage.woaUnsupportedFiles", "Only .fit or .zip files are supported in this demo."))}</div>`);
        return;
    }

    const isZipMode = files.length === 1 && zipFiles.length === 1 && fitFiles.length === 0;
    const selectedFiles = files;
    const selectedFile = files.length === 1 ? files[0] : null;

    if (statusArea) {
        statusArea.classList.remove("d-none");
    }

    setLoading(true);
    setProcessingLabel(tr("uploadPage.woaConvert", "Convert"));
    setPhase(isZipMode ? tr("uploadPage.woaPhaseReadingZip", "Reading ZIP file") : tr("uploadPage.woaPhaseReadingSources", "Reading source files"));
    setReadProgress(0, "");
    setProcessingProgress(0, "");

    try {
        const startupTimings = {};
        const submitStartedAt = performance.now();
        const encodingOptions = getEncodingOptions();
        const overwriteExisting = isOverwriteExistingWorkoutsEnabled();
        let arrayBuffer = null;
        let prewarmedZipToken = null;
        let prewarmedZipTokens = [];
        let prewarmedZipFiles = [];
        let workerFiles = [];
        let totalLoadedBytes = 0;
        const totalSourceBytes = selectedFiles.reduce((sum, file) => sum + Number(file.size || 0), 0);
        const readStartedAt = performance.now();
        let preparedZip = null;

        if (isZipMode) {
            setPhase(tr("uploadPage.woaPhaseReadingZip", "Reading ZIP file"));
            setReadProgress(1, tr("uploadPage.woaPreparingZipInBackground", "Checking prepared ZIP cache"));
            preparedZip = await awaitPreparedZipForFile(selectedFile);
        }

        const canReusePreparedZip = isZipMode
            && preparedZip
            && preparedZip.status === "ready";

        if (isZipMode && canReusePreparedZip) {
            prewarmedZipToken = preparedZip.token;
            consumePreparedZipForFile(selectedFile);
            startupTimings.readSourceMs = 0;
            startupTimings.prewarmedZipReuseMs = Number(preparedZip?.stats?.prepareMs || 0);
            totalLoadedBytes = selectedFile.size;
            setReadProgress(100, `${formatBytes(totalLoadedBytes)} cached`);
            setPhase(tr("uploadPage.woaPhaseLoadingExisting", "Loading existing workouts"));
        } else if (isZipMode) {
            arrayBuffer = await readFileWithProgress(selectedFile, (loaded, total) => {
                const percent = total > 0 ? (loaded / total) * 100 : 0;
                setReadProgress(percent, `${formatBytes(loaded)} / ${formatBytes(total)}`);
            });
            totalLoadedBytes = selectedFile.size;
        } else {
            for (let index = 0; index < selectedFiles.length; index += 1) {
                const currentFile = selectedFiles[index];
                const currentIsZip = String(currentFile?.name || "").toLowerCase().endsWith(".zip");
                let currentPreparedZip = null;
                if (currentIsZip) {
                    currentPreparedZip = await awaitPreparedZipForFile(currentFile);
                }
                const canReuseCurrentZip = currentIsZip && currentPreparedZip?.status === "ready";
                if (canReuseCurrentZip) {
                    prewarmedZipTokens.push(currentPreparedZip.token);
                    consumePreparedZipForFile(currentFile);
                    prewarmedZipFiles.push({
                        name: currentFile.name,
                        size: Number(currentFile.size || 0)
                    });
                    totalLoadedBytes += currentFile.size;
                    const percent = totalSourceBytes > 0 ? (totalLoadedBytes / totalSourceBytes) * 100 : 100;
                    setReadProgress(percent, `${formatBytes(totalLoadedBytes)} / ${formatBytes(totalSourceBytes)}`);
                    continue;
                }
                const currentArrayBuffer = await readFileWithProgress(currentFile, (loaded) => {
                    const aggregateLoaded = totalLoadedBytes + Number(loaded || 0);
                    const percent = totalSourceBytes > 0 ? (aggregateLoaded / totalSourceBytes) * 100 : 0;
                    setReadProgress(percent, `${formatBytes(aggregateLoaded)} / ${formatBytes(totalSourceBytes)}`);
                });
                totalLoadedBytes += currentFile.size;
                workerFiles.push({
                    name: currentFile.name,
                    arrayBuffer: currentArrayBuffer
                });
            }
        }
        if (!Number.isFinite(Number(startupTimings.readSourceMs))) {
            startupTimings.readSourceMs = performance.now() - readStartedAt;
        }

        setReadProgress(100, `${formatBytes(totalLoadedBytes)} loaded`);
        let existingStartTimes = [];
        if (overwriteExisting) {
            setPhase(tr("uploadPage.woaPhaseOverwriteEnabled", "Overwrite mode enabled"));
            setProcessingProgress(3, tr("uploadPage.woaOverwriteSkippingExistingFetch", "Overwrite enabled, skipping duplicate pre-check"));
        } else {
            setPhase(tr("uploadPage.woaPhaseLoadingExisting", "Loading existing workouts"));
            setProcessingProgress(3, tr("uploadPage.woaFetchingExisting", "Fetching existing workout timestamps for duplicate detection"));
            const fetchExistingStartedAt = performance.now();
            existingStartTimes = await fetchExistingWorkoutStartTimes();
            startupTimings.fetchExistingStartTimesMs = performance.now() - fetchExistingStartedAt;
        }
        setPhase(tr("uploadPage.woaPhaseStartingWorker", "Starting worker"));
        setProcessingProgress(5, tr("uploadPage.woaWorkerBootstrapped", "Worker bootstrapped"));

        const worker = getUploadWorker();
        const workerBootstrapStartedAt = performance.now();
        let finished = false;
        let workerBootstrapped = false;

        const handleWorkerError = (workerError) => {
            if (finished) {
                return;
            }
            finished = true;
            setPhase(tr("uploadPage.woaPhaseFailed", "Failed"));
            setProcessingProgress(0, "");
            setResponseMarkup(`<div class="alert alert-danger mb-0">${escapeHtml(tr("uploadPage.woaWorkerFailedPrefix", "Worker failed to start or crashed:"))} ${escapeHtml(workerError.message || tr("uploadPage.woaUnknownWorkerError", "Unknown worker error"))}</div>`);
            setLoading(false);
            worker.removeEventListener("error", handleWorkerError);
            worker.removeEventListener("messageerror", handleWorkerMessageError);
            worker.removeEventListener("message", handleWorkerMessage);
            prewarmedUploadWorker = null;
            worker.terminate();
        };

        const handleWorkerMessageError = () => {
            if (finished) {
                return;
            }
            finished = true;
            setPhase(tr("uploadPage.woaPhaseFailed", "Failed"));
            setProcessingProgress(0, "");
            setResponseMarkup(`<div class="alert alert-danger mb-0">${escapeHtml(tr("uploadPage.woaWorkerMessageTransferFailed", "Worker message transfer failed."))}</div>`);
            setLoading(false);
            worker.removeEventListener("error", handleWorkerError);
            worker.removeEventListener("messageerror", handleWorkerMessageError);
            worker.removeEventListener("message", handleWorkerMessage);
            prewarmedUploadWorker = null;
            worker.terminate();
        };

        const handleWorkerMessage = (workerEvent) => {
            const data = workerEvent.data || {};

            if (data.type === "prewarm-complete") {
                return;
            }

            if (!workerBootstrapped) {
                workerBootstrapped = true;
                startupTimings.workerBootstrapMs = performance.now() - workerBootstrapStartedAt;
            }

            if (data.type === "startup-metric") {
                if (typeof data.name === "string" && Number.isFinite(Number(data.valueMs))) {
                    startupTimings[data.name] = Number(data.valueMs);
                }
                return;
            }

            if (data.type === "phase") {
                if (data.phase === "reading-zip") {
                    setPhase(tr("uploadPage.woaPhaseOpeningZip", "Opening ZIP archive"));
                    setProcessingProgress(10, tr("uploadPage.woaLoadingZipDirectory", "Loading ZIP directory"));
                }
                if (data.phase === "zip-entry") {
                    const processedEntries = Number(data.processedEntries || 0);
                    const totalEntries = Number(data.totalEntries || 0);
                    const percent = totalEntries > 0 ? 15 + Math.round((processedEntries / totalEntries) * 65) : 15;
                    setPhase(tr("uploadPage.woaPhaseConvertingEntries", "Converting source entries to WOA1"));
                    setProcessingProgress(percent, `${processedEntries}/${totalEntries} ${tr("uploadPage.woaEntriesFinishedSuffix", "entries finished")}: ${data.entryName || ""}`);
                }
                if (data.phase === "building-zip") {
                    setPhase(tr("uploadPage.woaPhaseBuildingZip", "Building output ZIP"));
                    setProcessingProgress(90, tr("uploadPage.woaPackingZip", "Packing converted WOA1 entries into a deflated ZIP archive"));
                }
                if (data.phase === "parsing-fit") {
                    setPhase(`${tr("uploadPage.woaPhaseParsingFit", "Parsing FIT")}${buildIterationSuffix(data)}`);
                    setProcessingProgress(20, tr("uploadPage.woaParsingFitDetail", "Typed parser is decoding the FIT payload"));
                }
                if (data.phase === "building-woa") {
                    setPhase(`${tr("uploadPage.woaPhaseBuildingWoa", "Building WOA1")}${buildIterationSuffix(data)}`);
                    setProcessingProgress(45, tr("uploadPage.woaBuildingWoaDetail", "Serializing session, stream and GPS blocks"));
                }
                if (data.phase === "compressing-gzip") {
                    setPhase(`${tr("uploadPage.woaPhaseCompressingGzip", "Compressing WOA2 (GZip)")}${buildIterationSuffix(data)}`);
                    setProcessingProgress(85, tr("uploadPage.woaCompressingGzipDetail", "Applying GZip compression to the raw WOA1 bytes"));
                }
                return;
            }

            if (data.type === "failed") {
                finished = true;
                traceMark("upload.submit.end", { reason: "worker-failed" });
                traceMeasure("upload.submit", "upload.submit.begin", "upload.submit.end");
                setPhase(tr("uploadPage.woaPhaseFailed", "Failed"));
                setProcessingProgress(0, "");
                setResponseMarkup(`<div class="alert alert-danger mb-0">${escapeHtml(data.error || tr("uploadPage.woaConversionFailed", "Conversion failed"))}</div>`);
                setLoading(false);
                worker.removeEventListener("error", handleWorkerError);
                worker.removeEventListener("messageerror", handleWorkerMessageError);
                worker.removeEventListener("message", handleWorkerMessage);
                return;
            }

            if (data.type === "skipped-existing") {
                finished = true;
                traceMark("upload.submit.end", { reason: "skipped-existing" });
                traceMeasure("upload.submit", "upload.submit.begin", "upload.submit.end");
                setPhase(tr("uploadPage.woaPhaseCompleted", "Completed"));
                setProcessingProgress(100, tr("uploadPage.woaWorkoutAlreadyExists", "Workout already exists"));
                setResponseMarkup(`
                    <div class="alert alert-info mb-0">
                        <div class="fw-semibold mb-2">${escapeHtml(tr("uploadPage.woaSkippedExistingTitle", "Workout already exists and was skipped before conversion."))}</div>
                        <div class="small">
                            Source: ${escapeHtml(data.fileName || "")}<br>
                            Existing start time: ${escapeHtml(String(data.startTime || ""))}
                        </div>
                    </div>
                `);
                setLoading(false);
                worker.removeEventListener("error", handleWorkerError);
                worker.removeEventListener("messageerror", handleWorkerMessageError);
                worker.removeEventListener("message", handleWorkerMessage);
                return;
            }

            if (data.type === "skipped-too-short") {
                finished = true;
                traceMark("upload.submit.end", { reason: "skipped-too-short" });
                traceMeasure("upload.submit", "upload.submit.begin", "upload.submit.end");
                setPhase(tr("uploadPage.woaPhaseCompleted", "Completed"));
                setProcessingProgress(100, tr("uploadPage.woaWorkoutTooShort", "Workout too short"));
                setResponseMarkup(`
                    <div class="alert alert-info mb-0">
                        <div class="fw-semibold mb-2">${escapeHtml(tr("uploadPage.woaSkippedTooShortTitle", "Workout was skipped because it is shorter than five minutes."))}</div>
                        <div class="small">
                            Source: ${escapeHtml(data.fileName || "")}<br>
                            Record count: ${escapeHtml(String(data.recordCount || 0))}
                        </div>
                    </div>
                `);
                setLoading(false);
                worker.removeEventListener("error", handleWorkerError);
                worker.removeEventListener("messageerror", handleWorkerMessageError);
                worker.removeEventListener("message", handleWorkerMessage);
                return;
            }

            if (data.type === "completed") {
                finished = true;
                traceMark("upload.submit.end", { reason: "completed-single-fit" });
                traceMeasure("upload.submit", "upload.submit.begin", "upload.submit.end");
                setPhase(tr("uploadPage.woaPhaseCompleted", "Completed"));
                setProcessingProgress(100, tr("uploadPage.woaFileReady", "WOA1 file ready"));

                const woaBytes = data.bytes instanceof ArrayBuffer ? data.bytes : new ArrayBuffer(0);
                const gzipBytes = data.gzipBytes instanceof ArrayBuffer ? data.gzipBytes : new ArrayBuffer(0);

                const woaBlob = new Blob([woaBytes], { type: "application/octet-stream" });
                const gzipBlob = new Blob([gzipBytes], { type: "application/octet-stream" });

                const woaDownloadUrl = URL.createObjectURL(woaBlob);
                const gzipDownloadUrl = URL.createObjectURL(gzipBlob);

                const gzipRatio = woaBlob.size > 0 ? ((gzipBlob.size / woaBlob.size) * 100).toFixed(1) : "0.0";
                const timings = data.timings || {};
                console.info("[upload-open] startup.profile", {
                    fileName: data.fileName || "",
                    submitToWorkerDoneMs: performance.now() - submitStartedAt,
                    ...startupTimings
                });

                setResponseMarkup(`
                    <div class="alert alert-success">
                        <div class="fw-semibold mb-2">${escapeHtml(tr("uploadPage.woaSingleCompletedTitle", "FIT converted to two local transport variants in the browser worker."))}</div>
                        <div class="small mb-2">
                            Source: ${escapeHtml(data.fileName || "")}<br>
                            Records: ${escapeHtml(String(data.recordCount || 0))}<br>
                            Sessions: ${escapeHtml(String(data.sessionsCount || 0))}<br>
                            Reduced GPS points: ${escapeHtml(String(data.gpsPointCount || 0))}
                        </div>
                        <div class="small mb-3">
                            WOA1 raw: ${escapeHtml(formatBytes(woaBlob.size))}<br>
                            WOA2 gzip: ${escapeHtml(formatBytes(gzipBlob.size))} (${escapeHtml(gzipRatio)}% of WOA1)
                        </div>
                        <div class="small mb-3">
                            Benchmark repeats: ${escapeHtml(String(timings.repeatCount || 1))}<br>
                            Parse FIT: ${escapeHtml(formatMs(timings.parseMs))}<br>
                            Build WOA1: ${escapeHtml(formatMs(timings.buildWoaMs))}<br>
                            ${buildStartupTimingLines(startupTimings) ? `${buildStartupTimingLines(startupTimings)}<br>` : ""}
                            ${buildTimingLines(timings.buildWoaStepsMs) ? `${buildTimingLines(timings.buildWoaStepsMs)}<br>` : ""}
                            Compress GZip: ${escapeHtml(formatMs(timings.gzipMs))}<br>
                            Total worker time: ${escapeHtml(formatMs(timings.totalMs))}
                        </div>
                        <div class="small mb-3 text-muted">Sanfte Kompression aktiv: 4 W / 2 rpm / 2 bpm</div>
                        <div class="d-flex flex-wrap gap-2">
                            <a class="btn btn-sm btn-outline-primary" href="${woaDownloadUrl}" download="${escapeHtml(data.outputFileName || "output.woa1")}">${escapeHtml(tr("uploadPage.woaDownloadRaw", "Download WOA1 Raw"))}</a>
                            <a class="btn btn-sm btn-primary" href="${gzipDownloadUrl}" download="${escapeHtml(data.gzipFileName || "output.woa2")}">${escapeHtml(tr("uploadPage.woaDownloadGzip", "Download WOA2 GZip"))}</a>
                        </div>
                    </div>
                `);

                setLoading(false);
                worker.removeEventListener("error", handleWorkerError);
                worker.removeEventListener("messageerror", handleWorkerMessageError);
                worker.removeEventListener("message", handleWorkerMessage);
                return;
            }

            if (data.type === "completed-zip") {
                finished = true;
                const stats = data.stats || {};
                const zipBytes = data.bytes instanceof ArrayBuffer ? data.bytes : new ArrayBuffer(0);
                const zipBlob = new Blob([zipBytes], { type: "application/zip" });
                const shouldUploadGeneratedZip = Number(stats.convertedEntries || 0) > 0 && zipBlob.size > 0;
                traceMark("upload.submit.end", {
                    reason: shouldUploadGeneratedZip ? "completed-zip-upload" : "completed-zip-no-upload"
                });
                traceMeasure("upload.submit", "upload.submit.begin", "upload.submit.end");
                if (shouldUploadGeneratedZip) {
                    setProcessingLabel(tr("uploadPage.woaUploadAndStore", "Upload and store"));
                    setPhase(tr("uploadPage.woaPhaseUploadingBackend", "Uploading and storing on server"));
                    setProcessingProgress(0, tr("uploadPage.woaPreparingRequest", "Preparing request"));
                } else {
                    setProcessingLabel(tr("uploadPage.woaCompletedLabel", "Completed"));
                    setPhase(tr("uploadPage.woaPhaseCompleted", "Completed"));
                    setProcessingProgress(100, tr("uploadPage.woaZipReady", "WOA1 ZIP ready"));
                }
                latestGeneratedZipArtifact = null;
                if (shouldUploadGeneratedZip) {
                    setLatestGeneratedZipArtifactSingle(zipBlob, data.outputFileName || "output.woa1.zip");
                }
                const skipped = Array.isArray(data.skipped) ? data.skipped : [];
                const skippedExisting = Array.isArray(data.skippedExisting) ? data.skippedExisting : [];
                const skippedTooShort = Array.isArray(data.skippedTooShort) ? data.skippedTooShort : [];
                const timings = data.timings || {};
                console.info("[upload-open] startup.profile", {
                    fileName: data.fileName || "",
                    submitToWorkerDoneMs: performance.now() - submitStartedAt,
                    ...startupTimings
                });
                const outerZipLevel = Number.isFinite(Number(stats.outerZipLevel))
                    ? Number(stats.outerZipLevel)
                    : 0;
                const compressionRatio = Number(stats.sourceZipBytes || 0) > 0
                    ? ((Number(stats.outputZipBytes || 0) / Number(stats.sourceZipBytes || 1)) * 100).toFixed(1)
                    : "0.0";
                const skippedMarkup = skipped.length > 0
                    ? `
                        <div class="small mb-3 text-warning">
                            Skipped FIT entries: ${escapeHtml(String(stats.skippedEntries || skipped.length))}<br>
                            ${skipped.slice(0, 10).map((item) => `${escapeHtml(item.entryName)}: ${escapeHtml(item.error)}`).join("<br>")}
                            ${skipped.length > 10 ? "<br>..." : ""}
                        </div>
                    `
                    : "";
                const skippedExistingMarkup = skippedExisting.length > 0
                    ? `
                        <div class="small mb-3 text-info">
                            Already existing workouts skipped before WOA build: ${escapeHtml(String(stats.skippedExistingEntries || skippedExisting.length))}<br>
                            ${skippedExisting.slice(0, 10).map((item) => `${escapeHtml(item.entryName)}: ${escapeHtml(formatLocalDateTime(item.startTime || ""))}`).join("<br>")}
                            ${skippedExisting.length > 10 ? "<br>..." : ""}
                        </div>
                    `
                    : "";
                const skippedTooShortMarkup = skippedTooShort.length > 0
                    ? `
                        <div class="small mb-3 text-secondary">
                            Too-short workouts skipped before WOA build: ${escapeHtml(String(stats.skippedTooShortEntries || skippedTooShort.length))}<br>
                            ${skippedTooShort.slice(0, 10).map((item) => `${escapeHtml(item.entryName)}: ${escapeHtml(String(item.recordCount || 0))} records`).join("<br>")}
                            ${skippedTooShort.length > 10 ? "<br>..." : ""}
                        </div>
                    `
                    : "";

                setResponseMarkup(`
                    <div class="alert alert-success">
                        <div class="fw-semibold mb-2">${escapeHtml(tr("uploadPage.woaZipCompletedTitle", "ZIP converted locally to a ZIP of WOA1 entries."))}</div>
                        <div class="small mb-2">
                            Source ZIP: ${escapeHtml(data.fileName || "")}<br>
                            FIT entries seen: ${escapeHtml(String(stats.fitEntries || 0))}<br>
                            Successfully converted: ${escapeHtml(String(stats.convertedEntries || 0))}<br>
                            Existing duplicates skipped: ${escapeHtml(String(stats.skippedExistingEntries || 0))}<br>
                            Too-short workouts skipped: ${escapeHtml(String(stats.skippedTooShortEntries || 0))}<br>
                            Total records: ${escapeHtml(String(stats.totalRecordCount || 0))}<br>
                            Reduced GPS points: ${escapeHtml(String(stats.totalGpsPointCount || 0))}
                        </div>
                        <div class="small mb-3">
                            Source ZIP size: ${escapeHtml(formatBytes(Number(stats.sourceZipBytes || 0)))}<br>
                            Output ZIP size: ${escapeHtml(formatBytes(Number(stats.outputZipBytes || 0)))} (${escapeHtml(compressionRatio)}% of source ZIP, ZIP deflate level ${escapeHtml(String(outerZipLevel))})
                        </div>
                        ${skippedExistingMarkup}
                        ${skippedTooShortMarkup}
                        ${skippedMarkup}
                        <div class="small mb-3">
                            Average parse FIT: ${escapeHtml(formatMs(timings.parseMs))}<br>
                            Average build WOA1: ${escapeHtml(formatMs(timings.buildWoaMs))}<br>
                            ${buildStartupTimingLines(startupTimings) ? `${buildStartupTimingLines(startupTimings)}<br>` : ""}
                            ${buildWorkoutStreamStatLines(timings.workoutStreamStats) ? `${buildWorkoutStreamStatLines(timings.workoutStreamStats)}<br>` : ""}
                            ${buildTimingLines(timings.buildWoaStepsMs) ? `${buildTimingLines(timings.buildWoaStepsMs)}<br>` : ""}
                            Build output ZIP: ${escapeHtml(formatMs(timings.zipBuildMs))}<br>
                            Total worker time: ${escapeHtml(formatMs(timings.totalMs))}
                        </div>
                        <div class="small mb-3 text-muted">Sanfte Kompression aktiv: 4 W / 2 rpm / 2 bpm</div>
                        ${shouldUploadGeneratedZip
                            ? `<div id="backendUploadResult">${buildBackendUploadPendingMarkup()}</div>`
                            : `<div class="small mb-2 text-muted">${escapeHtml(tr("uploadPage.woaNoBackendUploadNeeded", "No new workouts remained after duplicate filtering, so no backend upload was needed."))}</div><div id="backendUploadResult"></div>`}
                    </div>
                `);

                if (shouldUploadGeneratedZip) {
                    queueMicrotask(async () => {
                        await uploadGeneratedZipArtifact();
                        prepareCurrentSelectionForNextSubmit();
                    });
                } else {
                    prepareCurrentSelectionForNextSubmit();
                }

                prewarmedUploadWorker = null;
                worker.terminate();
                return;
            }

            if (data.type === "completed-container") {
                finished = true;
                const stats = data.stats || {};
                const containerBytes = data.bytes instanceof ArrayBuffer ? data.bytes : new ArrayBuffer(0);
                const containerBlob = new Blob([containerBytes], { type: "application/octet-stream" });
                const shouldUploadGeneratedContainer = Number(stats.convertedEntries || 0) > 0 && containerBlob.size > 0;
                traceMark("upload.submit.end", {
                    reason: shouldUploadGeneratedContainer ? "completed-container-upload" : "completed-container-no-upload"
                });
                traceMeasure("upload.submit", "upload.submit.begin", "upload.submit.end");
                if (shouldUploadGeneratedContainer) {
                    setProcessingLabel(tr("uploadPage.woaUploadAndStore", "Upload and store"));
                    setPhase(tr("uploadPage.woaPhaseUploadingBackend", "Uploading and storing on server"));
                    setProcessingProgress(0, tr("uploadPage.woaPreparingRequest", "Preparing request"));
                } else {
                    setProcessingLabel(tr("uploadPage.woaCompletedLabel", "Completed"));
                    setPhase(tr("uploadPage.woaPhaseCompleted", "Completed"));
                    setProcessingProgress(100, tr("uploadPage.woaZipReady", "WOA1 ZIP ready"));
                }
                latestGeneratedZipArtifact = null;
                if (shouldUploadGeneratedContainer) {
                    setLatestGeneratedZipArtifactSingle(
                        containerBlob,
                        data.outputFileName || "output.woat.gz",
                        "/api/uploads/woa-container",
                        "raw"
                    );
                }
                const skipped = Array.isArray(data.skipped) ? data.skipped : [];
                const skippedExisting = Array.isArray(data.skippedExisting) ? data.skippedExisting : [];
                const skippedTooShort = Array.isArray(data.skippedTooShort) ? data.skippedTooShort : [];
                const timings = data.timings || {};
                console.info("[upload-open] startup.profile", {
                    fileName: data.fileName || "",
                    submitToWorkerDoneMs: performance.now() - submitStartedAt,
                    ...startupTimings
                });
                const compressionRatio = Number(stats.sourceZipBytes || 0) > 0
                    ? ((Number(stats.outputContainerBytes || 0) / Number(stats.sourceZipBytes || 1)) * 100).toFixed(1)
                    : "0.0";
                const containerCompression = String(stats.containerCompression || "gzip").toLowerCase() === "brotli"
                    ? "brotli"
                    : "gzip";
                const containerCompressionDetail = containerCompression === "gzip"
                    ? `${containerCompression}${stats.containerCompressionEngine ? `/${escapeHtml(String(stats.containerCompressionEngine))}` : ` level ${escapeHtml(String(stats.containerGzipLevel || 0))}`}`
                    : containerCompression;
                const skippedMarkup = skipped.length > 0
                    ? `
                        <div class="small mb-3 text-warning">
                            Skipped FIT entries: ${escapeHtml(String(stats.skippedEntries || skipped.length))}<br>
                            ${skipped.slice(0, 10).map((item) => `${escapeHtml(item.entryName)}: ${escapeHtml(item.error)}`).join("<br>")}
                            ${skipped.length > 10 ? "<br>..." : ""}
                        </div>
                    `
                    : "";
                const skippedExistingMarkup = skippedExisting.length > 0
                    ? `
                        <div class="small mb-3 text-info">
                            Already existing workouts skipped before WOA build: ${escapeHtml(String(stats.skippedExistingEntries || skippedExisting.length))}<br>
                            ${skippedExisting.slice(0, 10).map((item) => `${escapeHtml(item.entryName)}: ${escapeHtml(formatLocalDateTime(item.startTime || ""))}`).join("<br>")}
                            ${skippedExisting.length > 10 ? "<br>..." : ""}
                        </div>
                    `
                    : "";
                const skippedTooShortMarkup = skippedTooShort.length > 0
                    ? `
                        <div class="small mb-3 text-info">
                            Too-short workouts skipped before WOA build: ${escapeHtml(String(stats.skippedTooShortEntries || skippedTooShort.length))}<br>
                            ${skippedTooShort.slice(0, 10).map((item) => `${escapeHtml(item.entryName)}: ${escapeHtml(String(item.recordCount || 0))} records`).join("<br>")}
                            ${skippedTooShort.length > 10 ? "<br>..." : ""}
                        </div>
                    `
                    : "";

                setResponseMarkup(`
                    <div class="alert alert-success">
                        <div class="fw-semibold mb-2">ZIP wurde lokal in einen WOA-Testcontainer konvertiert.</div>
                        <div class="small mb-3">
                            Source ZIP: ${escapeHtml(data.fileName || "")}<br>
                            FIT entries seen: ${escapeHtml(String(stats.fitEntries || 0))}<br>
                            WOA entries passed through: ${escapeHtml(String(stats.passedThroughEntries || 0))}<br>
                            Successfully converted: ${escapeHtml(String(stats.convertedEntries || 0))}<br>
                            Total records: ${escapeHtml(String(stats.totalRecordCount || 0))}<br>
                            Reduced GPS points: ${escapeHtml(String(stats.totalGpsPointCount || 0))}<br>
                            Source ZIP size: ${escapeHtml(formatBytes(Number(stats.sourceZipBytes || 0)))}<br>
                            Output container size: ${escapeHtml(formatBytes(Number(stats.outputContainerBytes || 0)))} (${escapeHtml(compressionRatio)}% of source ZIP, ${containerCompressionDetail})
                            <br>GPS coordinate encoding: ${escapeHtml(String(stats.gpsCoordinateEncoding || "bitmap-columnar"))}
                        </div>
                        ${skippedExistingMarkup}
                        ${skippedTooShortMarkup}
                        ${skippedMarkup}
                        <div class="small mb-3">
                            Average parse FIT: ${escapeHtml(formatMs(timings.parseMs))}<br>
                            Average build WOA1: ${escapeHtml(formatMs(timings.buildWoaMs))}<br>
                            ${buildStartupTimingLines(startupTimings) ? `${buildStartupTimingLines(startupTimings)}<br>` : ""}
                            ${buildWorkoutStreamStatLines(timings.workoutStreamStats) ? `${buildWorkoutStreamStatLines(timings.workoutStreamStats)}<br>` : ""}
                            ${buildTimingLines(timings.buildWoaStepsMs) ? `${buildTimingLines(timings.buildWoaStepsMs)}<br>` : ""}
                            Build output container: ${escapeHtml(formatMs(timings.containerBuildMs))}<br>
                            Total worker time: ${escapeHtml(formatMs(timings.totalMs))}
                        </div>
                        <div class="small mb-3 text-muted">Sanfte Kompression aktiv: 4 W / 2 rpm / 2 bpm</div>
                        ${shouldUploadGeneratedContainer
                            ? `<div id="backendUploadResult">${buildBackendUploadPendingMarkup()}</div>`
                            : `<div class="small mb-2 text-muted">${escapeHtml(tr("uploadPage.woaNoBackendUploadNeeded", "No new workouts remained after duplicate filtering, so no backend upload was needed."))}</div><div id="backendUploadResult"></div>`}
                    </div>
                `);

                if (shouldUploadGeneratedContainer) {
                    queueMicrotask(async () => {
                        await uploadGeneratedZipArtifact();
                        prepareCurrentSelectionForNextSubmit();
                    });
                } else {
                    prepareCurrentSelectionForNextSubmit();
                }

                worker.removeEventListener("error", handleWorkerError);
                worker.removeEventListener("messageerror", handleWorkerMessageError);
                worker.removeEventListener("message", handleWorkerMessage);
                return;
            }

        };

        worker.addEventListener("error", handleWorkerError);
        worker.addEventListener("messageerror", handleWorkerMessageError);
        worker.addEventListener("message", handleWorkerMessage);

        worker.postMessage({
            type: isZipMode
                ? "convert-zip-to-woa-zip"
                : (selectedFiles.length > 1 ? "convert-fit-files-to-woa-zip" : "convert-fit-to-woa"),
            fileName: isZipMode
                ? selectedFile.name
                : (selectedFiles.length > 1 ? "fit-files.woa1.zip" : selectedFile.name),
            arrayBuffer,
            files: workerFiles,
            prewarmedZipToken,
            prewarmedZipTokens,
            prewarmedZipFiles,
            existingStartTimes,
            overwriteExisting,
            encodingOptions,
            outputMode: getUploadTransportMode(),
            parallelFitPoolEnabled: isParallelFitPoolEnabled(),
            parallelFitWorkers: getParallelFitWorkerCount()
        }, [
            ...(arrayBuffer ? [arrayBuffer] : []),
            ...workerFiles.map((entry) => entry.arrayBuffer)
        ]);
    } catch (error) {
        traceMark("upload.submit.end", { reason: "exception" });
        traceMeasure("upload.submit", "upload.submit.begin", "upload.submit.end");
        setPhase(tr("uploadPage.woaPhaseFailed", "Failed"));
        setResponseMarkup(`<div class="alert alert-danger mb-0">${escapeHtml(error?.message || String(error))}</div>`);
        setLoading(false);
    }
}

function readFileWithProgress(file, onProgress) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();

        reader.onprogress = (event) => {
            if (event.lengthComputable && onProgress) {
                onProgress(event.loaded, event.total);
            }
        };

        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error("Could not read file"));
        reader.readAsArrayBuffer(file);
    });
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
