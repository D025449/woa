const form = document.getElementById("uploadForm");
const fileInput = document.getElementById("file");
const filePickerButton = document.getElementById("filePickerButton");
const filePickerLabel = document.getElementById("filePickerLabel");
const gentleQuantizationToggle = document.getElementById("gentleQuantizationToggle");
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
const uploadShell = document.getElementById("upload-shell");
const i18nMessages = window.__I18N?.messages || {};
const activeLocale = window.__I18N?.locale || navigator.language || "en";
let latestGeneratedZipArtifact = null;
let currentDeviceProfile = window.getDeviceProfile?.() || window.__DEVICE_PROFILE__ || null;

initializeClientLayout();
form?.addEventListener("submit", handleConvertSubmit);
filePickerButton?.addEventListener("click", () => fileInput?.click());
fileInput?.addEventListener("change", updateFilePickerLabel);
window.addEventListener("deviceprofilechange", (event) => {
    currentDeviceProfile = event.detail || window.getDeviceProfile?.() || null;
    applyDeviceProfileToUploadShell();
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

function setResponseMarkup(markup) {
    if (response) {
        response.innerHTML = markup;
    }
}

function setLoading(isLoading) {
    if (submitButton) {
        submitButton.disabled = isLoading;
    }
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

function getEncodingOptions() {
    if (!gentleQuantizationToggle?.checked) {
        return {
            gentleQuantization: false,
            powerStep: 1,
            cadenceStep: 1,
            hrStep: 1
        };
    }

    return {
        gentleQuantization: true,
        powerStep: 2,
        cadenceStep: 2,
        hrStep: 2
    };
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

    renderBackendUploadState(buildBackendUploadPendingMarkup());
    setPhase(tr("uploadPage.woaPhaseUploadingBackend", "Uploading to backend"));
    setProcessingProgress(0, tr("uploadPage.woaPreparingRequest", "Preparing request"));

    try {
        const formData = new FormData();
        formData.append("file", latestGeneratedZipArtifact.blob, latestGeneratedZipArtifact.fileName);

        const payload = await uploadGeneratedZipFormData(formData, ({ loaded, total, percent }) => {
            const detailText = total > 0
                ? `${formatBytes(loaded)} / ${formatBytes(total)}`
                : `${formatBytes(loaded)} ${tr("uploadPage.woaUploadedSuffix", "uploaded")}`;
            setPhase(tr("uploadPage.woaPhaseUploadingBackend", "Uploading to backend"));
            setProcessingProgress(percent, detailText);
        }, () => {
            setPhase(tr("uploadPage.woaPhaseBackendProcessing", "Backend processing"));
            setProcessingProgress(100, tr("uploadPage.woaBackendProcessingDetail", "Upload finished, waiting for backend response"));
        });

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
        setPhase(tr("uploadPage.woaPhaseFailed", "Failed"));
        setProcessingProgress(0, tr("uploadPage.woaBackendUploadFailed", "Backend upload failed"));
        renderBackendUploadState(`<div class="alert alert-danger mb-0 mt-2">${escapeHtml(error?.message || String(error))}</div>`);
    }
}

function setLatestGeneratedZipArtifactSingle(blob, fileName) {
    latestGeneratedZipArtifact = { blob, fileName };
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

function uploadGeneratedZipFormData(formData, onProgress, onUploadComplete) {
    return new Promise((resolve, reject) => {
        const request = new XMLHttpRequest();
        const startedAt = performance.now();
        let uploadCompleted = false;

        request.open("POST", "/api/uploads/woa-zip", true);
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

async function handleConvertSubmit(event) {
    event.preventDefault();
    latestGeneratedZipArtifact = null;

    const files = Array.from(fileInput?.files || []);
    setResponseMarkup("");

    if (files.length === 0) {
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
    setPhase(isZipMode ? tr("uploadPage.woaPhaseReadingZip", "Reading ZIP file") : tr("uploadPage.woaPhaseReadingSources", "Reading source files"));
    setReadProgress(0, "");
    setProcessingProgress(0, "");

    try {
        const encodingOptions = getEncodingOptions();
        let arrayBuffer = null;
        let workerFiles = [];
        let totalLoadedBytes = 0;
        const totalSourceBytes = selectedFiles.reduce((sum, file) => sum + Number(file.size || 0), 0);

        if (isZipMode) {
            arrayBuffer = await readFileWithProgress(selectedFile, (loaded, total) => {
                const percent = total > 0 ? (loaded / total) * 100 : 0;
                setReadProgress(percent, `${formatBytes(loaded)} / ${formatBytes(total)}`);
            });
            totalLoadedBytes = selectedFile.size;
        } else {
            for (let index = 0; index < selectedFiles.length; index += 1) {
                const currentFile = selectedFiles[index];
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

        setReadProgress(100, `${formatBytes(totalLoadedBytes)} loaded`);
        setPhase(tr("uploadPage.woaPhaseLoadingExisting", "Loading existing workouts"));
        setProcessingProgress(3, tr("uploadPage.woaFetchingExisting", "Fetching existing workout timestamps for duplicate detection"));
        const existingStartTimes = await fetchExistingWorkoutStartTimes();
        setPhase(tr("uploadPage.woaPhaseStartingWorker", "Starting worker"));
        setProcessingProgress(5, tr("uploadPage.woaWorkerBootstrapped", "Worker bootstrapped"));

        const worker = new Worker("/js/upload-new-worker.js", { type: "module" });
        let finished = false;

        worker.addEventListener("error", (workerError) => {
            if (finished) {
                return;
            }
            finished = true;
            setPhase(tr("uploadPage.woaPhaseFailed", "Failed"));
            setProcessingProgress(0, "");
            setResponseMarkup(`<div class="alert alert-danger mb-0">${escapeHtml(tr("uploadPage.woaWorkerFailedPrefix", "Worker failed to start or crashed:"))} ${escapeHtml(workerError.message || tr("uploadPage.woaUnknownWorkerError", "Unknown worker error"))}</div>`);
            setLoading(false);
            worker.terminate();
        });

        worker.addEventListener("messageerror", () => {
            if (finished) {
                return;
            }
            finished = true;
            setPhase(tr("uploadPage.woaPhaseFailed", "Failed"));
            setProcessingProgress(0, "");
            setResponseMarkup(`<div class="alert alert-danger mb-0">${escapeHtml(tr("uploadPage.woaWorkerMessageTransferFailed", "Worker message transfer failed."))}</div>`);
            setLoading(false);
            worker.terminate();
        });

        worker.addEventListener("message", (workerEvent) => {
            const data = workerEvent.data || {};

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
                setPhase(tr("uploadPage.woaPhaseFailed", "Failed"));
                setProcessingProgress(0, "");
                setResponseMarkup(`<div class="alert alert-danger mb-0">${escapeHtml(data.error || tr("uploadPage.woaConversionFailed", "Conversion failed"))}</div>`);
                setLoading(false);
                worker.terminate();
                return;
            }

            if (data.type === "skipped-existing") {
                finished = true;
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
                worker.terminate();
                return;
            }

            if (data.type === "skipped-too-short") {
                finished = true;
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
                worker.terminate();
                return;
            }

            if (data.type === "completed") {
                finished = true;
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
                            ${buildTimingLines(timings.buildWoaStepsMs) ? `${buildTimingLines(timings.buildWoaStepsMs)}<br>` : ""}
                            Compress GZip: ${escapeHtml(formatMs(timings.gzipMs))}<br>
                            Total worker time: ${escapeHtml(formatMs(timings.totalMs))}
                        </div>
                        ${encodingOptions.gentleQuantization ? `<div class="small mb-3 text-muted">Sanfte Kompression aktiv: 2 W / 2 rpm / 2 bpm</div>` : ""}
                        <div class="d-flex flex-wrap gap-2">
                            <a class="btn btn-sm btn-outline-primary" href="${woaDownloadUrl}" download="${escapeHtml(data.outputFileName || "output.woa1")}">${escapeHtml(tr("uploadPage.woaDownloadRaw", "Download WOA1 Raw"))}</a>
                            <a class="btn btn-sm btn-primary" href="${gzipDownloadUrl}" download="${escapeHtml(data.gzipFileName || "output.woa2")}">${escapeHtml(tr("uploadPage.woaDownloadGzip", "Download WOA2 GZip"))}</a>
                        </div>
                    </div>
                `);

                setLoading(false);
                worker.terminate();
                return;
            }

            if (data.type === "completed-zip") {
                finished = true;
                setPhase(tr("uploadPage.woaPhaseCompleted", "Completed"));
                setProcessingProgress(100, tr("uploadPage.woaZipReady", "WOA1 ZIP ready"));

                const stats = data.stats || {};
                const zipBytes = data.bytes instanceof ArrayBuffer ? data.bytes : new ArrayBuffer(0);
                const zipBlob = new Blob([zipBytes], { type: "application/zip" });
                const shouldUploadGeneratedZip = Number(stats.convertedEntries || 0) > 0 && zipBlob.size > 0;
                latestGeneratedZipArtifact = null;
                if (shouldUploadGeneratedZip) {
                    setLatestGeneratedZipArtifactSingle(zipBlob, data.outputFileName || "output.woa1.zip");
                }
                const skipped = Array.isArray(data.skipped) ? data.skipped : [];
                const skippedExisting = Array.isArray(data.skippedExisting) ? data.skippedExisting : [];
                const skippedTooShort = Array.isArray(data.skippedTooShort) ? data.skippedTooShort : [];
                const timings = data.timings || {};
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
                            ${buildWorkoutStreamStatLines(timings.workoutStreamStats) ? `${buildWorkoutStreamStatLines(timings.workoutStreamStats)}<br>` : ""}
                            ${buildTimingLines(timings.buildWoaStepsMs) ? `${buildTimingLines(timings.buildWoaStepsMs)}<br>` : ""}
                            Build output ZIP: ${escapeHtml(formatMs(timings.zipBuildMs))}<br>
                            Total worker time: ${escapeHtml(formatMs(timings.totalMs))}
                        </div>
                        ${encodingOptions.gentleQuantization ? `<div class="small mb-3 text-muted">Sanfte Kompression aktiv: 2 W / 2 rpm / 2 bpm</div>` : ""}
                        ${shouldUploadGeneratedZip
                            ? `<div id="backendUploadResult">${buildBackendUploadPendingMarkup()}</div>`
                            : `<div class="small mb-2 text-muted">${escapeHtml(tr("uploadPage.woaNoBackendUploadNeeded", "No new workouts remained after duplicate filtering, so no backend upload was needed."))}</div><div id="backendUploadResult"></div>`}
                    </div>
                `);

                if (shouldUploadGeneratedZip) {
                    queueMicrotask(() => {
                        uploadGeneratedZipArtifact();
                    });
                }

                setLoading(false);
                worker.terminate();
                return;
            }

        });

        worker.postMessage({
            type: isZipMode
                ? "convert-zip-to-woa-zip"
                : (selectedFiles.length > 1 ? "convert-fit-files-to-woa-zip" : "convert-fit-to-woa"),
            fileName: isZipMode
                ? selectedFile.name
                : (selectedFiles.length > 1 ? "fit-files.woa1.zip" : selectedFile.name),
            arrayBuffer,
            files: workerFiles,
            existingStartTimes,
            encodingOptions
        }, [
            ...(arrayBuffer ? [arrayBuffer] : []),
            ...workerFiles.map((entry) => entry.arrayBuffer)
        ]);
    } catch (error) {
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
