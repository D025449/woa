const form = document.getElementById("uploadForm");
const fileInput = document.getElementById("file");
const filePickerButton = document.getElementById("filePickerButton");
const filePickerLabel = document.getElementById("filePickerLabel");
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
let latestGeneratedZipArtifact = null;

initializeClientLayout();
form?.addEventListener("submit", handleConvertSubmit);
filePickerButton?.addEventListener("click", () => fileInput?.click());
fileInput?.addEventListener("change", updateFilePickerLabel);

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
        const availableHeight = Math.max(560, viewportHeight - bodyOffsetTop - paddingTop - paddingBottom);
        uploadShell.style.setProperty("--upload-client-height", `${availableHeight}px`);
        uploadShell.classList.add("upload-shell--client");
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

function updateFilePickerLabel() {
    const file = fileInput?.files?.[0];
    filePickerLabel.textContent = file ? file.name : "No file selected";
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

function setUploadButtonLoading(isLoading) {
    const button = document.getElementById("uploadGeneratedZipButton");
    if (button) {
        button.disabled = isLoading;
        button.textContent = isLoading ? "Uploading..." : "Upload WOA1 ZIP To Backend";
    }
}

function setBackendUploadProgress(percent, detailText = "") {
    const progressBar = document.getElementById("backendUploadProgressBar");
    const percentText = document.getElementById("backendUploadPercentText");
    const detailNode = document.getElementById("backendUploadDetailText");

    if (progressBar) {
        progressBar.style.width = `${percent}%`;
        progressBar.setAttribute("aria-valuenow", String(percent));
    }
    if (percentText) {
        percentText.textContent = `${Math.round(percent)}%`;
    }
    if (detailNode) {
        detailNode.textContent = detailText;
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

function buildIterationSuffix(data) {
    const iteration = Number(data?.iteration || 0);
    const totalIterations = Number(data?.totalIterations || 0);
    if (iteration > 0 && totalIterations > 0) {
        return ` (${iteration}/${totalIterations})`;
    }
    return "";
}

async function uploadGeneratedZipArtifact() {
    if (!latestGeneratedZipArtifact?.blob || !latestGeneratedZipArtifact?.fileName) {
        return;
    }

    renderBackendUploadState(`
        <div class="alert alert-info mb-0 mt-2">
            <div class="fw-semibold mb-2">Uploading generated WOA1 ZIP to backend.</div>
            <div class="upload-progress-block mb-2">
                <div class="d-flex justify-content-between">
                    <span>Transfer</span>
                    <span id="backendUploadPercentText">0%</span>
                </div>
                <div class="progress">
                    <div id="backendUploadProgressBar" class="progress-bar" role="progressbar"
                        style="width: 0%;" aria-valuenow="0" aria-valuemin="0" aria-valuemax="100"></div>
                </div>
                <div id="backendUploadDetailText" class="small text-muted mt-1">Preparing request</div>
            </div>
        </div>
    `);

    setUploadButtonLoading(true);

    try {
        const formData = new FormData();
        formData.append("file", latestGeneratedZipArtifact.blob, latestGeneratedZipArtifact.fileName);

        const payload = await uploadGeneratedZipFormData(formData, ({ loaded, total, percent }) => {
            const detailText = total > 0
                ? `${formatBytes(loaded)} / ${formatBytes(total)}`
                : `${formatBytes(loaded)} uploaded`;
            setBackendUploadProgress(percent, detailText);
        });

        renderBackendUploadState(`
            <div class="alert alert-info mb-0 mt-2">
                <div class="fw-semibold mb-2">Backend upload completed.</div>
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
        renderBackendUploadState(`<div class="alert alert-danger mb-0 mt-2">${escapeHtml(error?.message || String(error))}</div>`);
    } finally {
        setUploadButtonLoading(false);
    }
}

function setLatestGeneratedZipArtifactSingle(blob, fileName) {
    latestGeneratedZipArtifact = { blob, fileName };
}

function uploadGeneratedZipFormData(formData, onProgress) {
    return new Promise((resolve, reject) => {
        const request = new XMLHttpRequest();
        const startedAt = performance.now();

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

            reject(new Error(payload?.error || `Upload failed with status ${request.status}`));
        });

        request.addEventListener("error", () => {
            reject(new Error("Network error while uploading generated WOA1 ZIP"));
        });

        request.addEventListener("abort", () => {
            reject(new Error("Upload aborted"));
        });

        request.send(formData);
    });
}

async function handleConvertSubmit(event) {
    event.preventDefault();
    latestGeneratedZipArtifact = null;

    const file = fileInput?.files?.[0];
    setResponseMarkup("");

    if (!file) {
        setResponseMarkup(`<div class="alert alert-danger mb-0">Please select one FIT or ZIP file.</div>`);
        return;
    }

    const lowerName = file.name.toLowerCase();
    const isFitFile = lowerName.endsWith(".fit");
    const isZipFile = lowerName.endsWith(".zip");

    if (!isFitFile && !isZipFile) {
        setResponseMarkup(`<div class="alert alert-danger mb-0">Only .fit or .zip files are supported in this demo.</div>`);
        return;
    }

    if (statusArea) {
        statusArea.classList.remove("d-none");
    }

    setLoading(true);
    setPhase(isZipFile ? "Reading ZIP file" : "Reading FIT file");
    setReadProgress(0, "");
    setProcessingProgress(0, "");

    try {
        const arrayBuffer = await readFileWithProgress(file, (loaded, total) => {
            const percent = total > 0 ? (loaded / total) * 100 : 0;
            setReadProgress(percent, `${formatBytes(loaded)} / ${formatBytes(total)}`);
        });

        setReadProgress(100, `${formatBytes(file.size)} loaded`);
        setPhase("Starting worker");
        setProcessingProgress(5, "Worker bootstrapped");

        const worker = new Worker("/js/upload-new-worker.js", { type: "module" });
        let finished = false;

        worker.addEventListener("error", (workerError) => {
            if (finished) {
                return;
            }
            finished = true;
            setPhase("Failed");
            setProcessingProgress(0, "");
            setResponseMarkup(`<div class="alert alert-danger mb-0">Worker failed to start or crashed: ${escapeHtml(workerError.message || "Unknown worker error")}</div>`);
            setLoading(false);
            worker.terminate();
        });

        worker.addEventListener("messageerror", () => {
            if (finished) {
                return;
            }
            finished = true;
            setPhase("Failed");
            setProcessingProgress(0, "");
            setResponseMarkup(`<div class="alert alert-danger mb-0">Worker message transfer failed.</div>`);
            setLoading(false);
            worker.terminate();
        });

        worker.addEventListener("message", (workerEvent) => {
            const data = workerEvent.data || {};

            if (data.type === "phase") {
                if (data.phase === "reading-zip") {
                    setPhase("Opening ZIP archive");
                    setProcessingProgress(10, "Loading ZIP directory");
                }
                if (data.phase === "zip-entry") {
                    const processedEntries = Number(data.processedEntries || 0);
                    const totalEntries = Number(data.totalEntries || 0);
                    const percent = totalEntries > 0 ? 15 + Math.round((processedEntries / totalEntries) * 65) : 15;
                    setPhase("Converting FIT entries to WOA1");
                    setProcessingProgress(percent, `${processedEntries}/${totalEntries} entries finished: ${data.entryName || ""}`);
                }
                if (data.phase === "building-zip") {
                    setPhase("Building output ZIP");
                    setProcessingProgress(90, "Packing converted WOA1 entries into a deflated ZIP archive");
                }
                if (data.phase === "parsing-fit") {
                    setPhase(`Parsing FIT${buildIterationSuffix(data)}`);
                    setProcessingProgress(20, "Typed parser is decoding the FIT payload");
                }
                if (data.phase === "building-woa") {
                    setPhase(`Building WOA1${buildIterationSuffix(data)}`);
                    setProcessingProgress(45, "Serializing session, stream and GPS blocks");
                }
                if (data.phase === "compressing-gzip") {
                    setPhase(`Compressing WOA2 (GZip)${buildIterationSuffix(data)}`);
                    setProcessingProgress(85, "Applying GZip compression to the raw WOA1 bytes");
                }
                return;
            }

            if (data.type === "failed") {
                finished = true;
                setPhase("Failed");
                setProcessingProgress(0, "");
                setResponseMarkup(`<div class="alert alert-danger mb-0">${escapeHtml(data.error || "Conversion failed")}</div>`);
                setLoading(false);
                worker.terminate();
                return;
            }

            if (data.type === "completed") {
                finished = true;
                setPhase("Completed");
                setProcessingProgress(100, "WOA1 file ready");

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
                        <div class="fw-semibold mb-2">FIT converted to two local transport variants in the browser worker.</div>
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
                            Compress GZip: ${escapeHtml(formatMs(timings.gzipMs))}<br>
                            Total worker time: ${escapeHtml(formatMs(timings.totalMs))}
                        </div>
                        <div class="d-flex flex-wrap gap-2">
                            <a class="btn btn-sm btn-outline-primary" href="${woaDownloadUrl}" download="${escapeHtml(data.outputFileName || "output.woa1")}">Download WOA1 Raw</a>
                            <a class="btn btn-sm btn-primary" href="${gzipDownloadUrl}" download="${escapeHtml(data.gzipFileName || "output.woa2")}">Download WOA2 GZip</a>
                        </div>
                    </div>
                `);

                setLoading(false);
                worker.terminate();
                return;
            }

            if (data.type === "completed-zip") {
                finished = true;
                setPhase("Completed");
                setProcessingProgress(100, "WOA1 ZIP ready");

                const zipBytes = data.bytes instanceof ArrayBuffer ? data.bytes : new ArrayBuffer(0);
                const zipBlob = new Blob([zipBytes], { type: "application/zip" });
                const zipDownloadUrl = URL.createObjectURL(zipBlob);
                setLatestGeneratedZipArtifactSingle(zipBlob, data.outputFileName || "output.woa1.zip");
                const stats = data.stats || {};
                const skipped = Array.isArray(data.skipped) ? data.skipped : [];
                const timings = data.timings || {};
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

                setResponseMarkup(`
                    <div class="alert alert-success">
                        <div class="fw-semibold mb-2">ZIP converted locally to a ZIP of WOA1 entries.</div>
                        <div class="small mb-2">
                            Source ZIP: ${escapeHtml(data.fileName || "")}<br>
                            FIT entries converted: ${escapeHtml(String(stats.fitEntries || 0))}<br>
                            Successfully converted: ${escapeHtml(String(stats.convertedEntries || 0))}<br>
                            Total records: ${escapeHtml(String(stats.totalRecordCount || 0))}<br>
                            Reduced GPS points: ${escapeHtml(String(stats.totalGpsPointCount || 0))}
                        </div>
                        <div class="small mb-3">
                            Source ZIP size: ${escapeHtml(formatBytes(Number(stats.sourceZipBytes || 0)))}<br>
                            Output ZIP size: ${escapeHtml(formatBytes(Number(stats.outputZipBytes || 0)))} (${escapeHtml(compressionRatio)}% of source ZIP, ZIP deflate level 4)
                        </div>
                        ${skippedMarkup}
                        <div class="small mb-3">
                            Average parse FIT: ${escapeHtml(formatMs(timings.parseMs))}<br>
                            Average build WOA1: ${escapeHtml(formatMs(timings.buildWoaMs))}<br>
                            Build output ZIP: ${escapeHtml(formatMs(timings.zipBuildMs))}<br>
                            Total worker time: ${escapeHtml(formatMs(timings.totalMs))}
                        </div>
                        <div class="d-flex flex-wrap gap-2">
                            <a class="btn btn-sm btn-primary" href="${zipDownloadUrl}" download="${escapeHtml(data.outputFileName || "output.woa1.zip")}">Download WOA1 ZIP</a>
                            <button type="button" id="uploadGeneratedZipButton" class="btn btn-sm btn-outline-primary">Upload WOA1 ZIP To Backend</button>
                        </div>
                        <div id="backendUploadResult"></div>
                    </div>
                `);

                document.getElementById("uploadGeneratedZipButton")?.addEventListener("click", () => {
                    uploadGeneratedZipArtifact();
                });

                setLoading(false);
                worker.terminate();
                return;
            }

        });

        worker.postMessage({
            type: isZipFile ? "convert-zip-to-woa-zip" : "convert-fit-to-woa",
            fileName: file.name,
            arrayBuffer
        }, [arrayBuffer]);
    } catch (error) {
        setPhase("Failed");
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
