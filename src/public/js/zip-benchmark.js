import { gzipSync, unzip, unzipSync } from "/vendor/fflate/browser.js";
import { parseFitBufferTypedBrowser } from "/js/fit-import-typed-browser.js";
import { createWoa1File } from "/js/woa-format.js";
import {
    BlobReader,
    Uint8ArrayWriter,
    ZipReader,
    configure as configureZipJs,
    terminateWorkers as terminateZipJsWorkers
} from "/vendor/zipjs/index.js";

const fileInput = document.getElementById("zipFile");
const repeatsInput = document.getElementById("repeats");
const includeAsyncInput = document.getElementById("includeAsync");
const includePipelineInput = document.getElementById("includePipeline");
const pipelineWorkersInput = document.getElementById("pipelineWorkers");
const includeStreamingSimInput = document.getElementById("includeStreamingSim");
const chunkSizeInput = document.getElementById("chunkSize");
const zipJsUseWorkersInput = document.getElementById("zipJsUseWorkers");
const zipJsWorkersInput = document.getElementById("zipJsWorkers");
const runButton = document.getElementById("runButton");
const statusNode = document.getElementById("status");
const summaryNode = document.getElementById("summary");
const resultsNode = document.getElementById("results");
const streamingResultsNode = document.getElementById("streamingResults");
const rawOutputNode = document.getElementById("rawOutput");

const RELEVANT_EXTENSIONS = [".fit", ".woa1"];
const MIN_WORKOUT_RECORD_COUNT = 300;
const PIPELINE_ENCODING_OPTIONS = {
    gentleQuantization: true,
    powerStep: 2,
    cadenceStep: 2,
    hrStep: 2
};

runButton?.addEventListener("click", runBenchmark);

function setStatus(text) {
    if (statusNode) {
        statusNode.textContent = text;
    }
}

function isRelevantEntry(name) {
    const normalized = String(name || "").replace(/\\/g, "/").toLowerCase();
    const baseName = normalized.split("/").pop() || "";
    if (normalized.startsWith("__macosx/") || baseName.startsWith("._")) {
        return false;
    }
    return RELEVANT_EXTENSIONS.some((extension) => normalized.endsWith(extension));
}

function formatMs(value) {
    return `${Number(value || 0).toFixed(1)} ms`;
}

function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function average(values) {
    if (!values.length) {
        return 0;
    }
    return values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length;
}

function averageGap(values) {
    if (!Array.isArray(values) || values.length < 2) {
        return 0;
    }
    let gapTotal = 0;
    for (let index = 1; index < values.length; index += 1) {
        gapTotal += Number(values[index] || 0) - Number(values[index - 1] || 0);
    }
    return gapTotal / (values.length - 1);
}

function buildTable(rows) {
    return `
        <table>
            <thead>
                <tr>
                    <th>Library</th>
                    <th>Mode</th>
                    <th>Open</th>
                    <th>Enumerate</th>
                    <th>Extract relevant entries</th>
                    <th>Total</th>
                    <th>Relevant entries</th>
                    <th>Extracted bytes</th>
                </tr>
            </thead>
            <tbody>
                ${rows.map((row) => `
                    <tr>
                        <td>${row.label}</td>
                        <td>${row.mode}</td>
                        <td>${formatMs(row.openMs)}</td>
                        <td>${formatMs(row.enumerateMs)}</td>
                        <td>${formatMs(row.extractMs)}</td>
                        <td><strong>${formatMs(row.totalMs)}</strong></td>
                        <td>${row.relevantEntryCount}</td>
                        <td>${formatBytes(row.extractedBytes)}</td>
                    </tr>
                `).join("")}
            </tbody>
        </table>
    `;
}

function buildStreamingTable(rows) {
    return `
        <table>
            <thead>
                <tr>
                    <th>Family</th>
                    <th>Mode</th>
                    <th>First chunk</th>
                    <th>Avg chunk gap</th>
                    <th>Last chunk</th>
                    <th>Total</th>
                    <th>Chunks</th>
                    <th>Imported workouts</th>
                </tr>
            </thead>
            <tbody>
                ${rows.map((row) => `
                    <tr>
                        <td>${row.label}</td>
                        <td>${row.mode}</td>
                        <td>${formatMs(row.firstChunkMs)}</td>
                        <td>${formatMs(row.avgChunkGapMs)}</td>
                        <td>${formatMs(row.lastChunkMs)}</td>
                        <td><strong>${formatMs(row.totalMs)}</strong></td>
                        <td>${row.chunkCount}</td>
                        <td>${row.importedCount}</td>
                    </tr>
                `).join("")}
            </tbody>
        </table>
    `;
}

function summarizeRuns(label, mode, runs) {
    return {
        label,
        mode,
        openMs: average(runs.map((run) => run.openMs)),
        enumerateMs: average(runs.map((run) => run.enumerateMs)),
        extractMs: average(runs.map((run) => run.extractMs)),
        totalMs: average(runs.map((run) => run.totalMs)),
        relevantEntryCount: runs[0]?.relevantEntryCount || 0,
        extractedBytes: runs[0]?.extractedBytes || 0
    };
}

function summarizePipelineRuns(label, mode, runs) {
    return {
        label,
        mode,
        openMs: average(runs.map((run) => run.unzipMs)),
        enumerateMs: average(runs.map((run) => run.fitEntryCollectMs)),
        extractMs: average(runs.map((run) => run.processMs)),
        totalMs: average(runs.map((run) => run.totalMs)),
        relevantEntryCount: runs[0]?.fitEntryCount || 0,
        extractedBytes: runs[0]?.outputBytes || 0
    };
}

function summarizeStreamingRuns(label, mode, runs) {
    const timelines = runs.map((run) => run.chunkTimelineMs || []);
    return {
        label,
        mode,
        firstChunkMs: average(timelines.map((timeline) => timeline[0] || 0)),
        avgChunkGapMs: average(timelines.map((timeline) => averageGap(timeline))),
        lastChunkMs: average(timelines.map((timeline) => timeline[timeline.length - 1] || 0)),
        totalMs: average(runs.map((run) => run.totalMs)),
        chunkCount: Math.round(average(timelines.map((timeline) => timeline.length))),
        importedCount: Math.round(average(runs.map((run) => run.importedCount || 0)))
    };
}

function renderResults({ file, repeats, summaries, rawRuns }) {
    const rows = summaries.filter((value) => value && Number.isFinite(value.totalMs));

    summaryNode.innerHTML = `
        <p><strong>Datei:</strong> ${file.name}</p>
        <p><strong>Dateigroesse:</strong> ${formatBytes(file.size)}</p>
        <p><strong>Repeats:</strong> ${repeats}</p>
    `;
    resultsNode.innerHTML = buildTable(rows);
    rawOutputNode.innerHTML = `
        <h2>Rohdaten</h2>
        <pre>${JSON.stringify(rawRuns, null, 2)}</pre>
    `;
    console.table(rows);
}

function buildParsedStartTimeKey(parsed) {
    const sessions = Array.isArray(parsed?.sessions) ? parsed.sessions : [];
    let minStartTimeMs = Number.POSITIVE_INFINITY;
    for (const session of sessions) {
        const value = Number(session?.start_time);
        if (Number.isFinite(value) && value < minStartTimeMs) {
            minStartTimeMs = value;
        }
    }
    return Number.isFinite(minStartTimeMs) ? new Date(minStartTimeMs).toISOString() : null;
}

function isTooShortWorkout(parsed) {
    return Number(parsed?.recordsTyped?.recordCount || 0) < MIN_WORKOUT_RECORD_COUNT;
}

function quantizeSeries(sourceArray, recordCount, step) {
    const normalizedStep = Math.max(1, Number.parseInt(String(step ?? 1), 10) || 1);
    if (normalizedStep <= 1 || !sourceArray || recordCount <= 0) {
        return sourceArray;
    }
    const quantizedValues = new Float64Array(recordCount);
    for (let index = 0; index < recordCount; index += 1) {
        const value = Number(sourceArray[index]);
        quantizedValues[index] = Number.isFinite(value)
            ? Math.round(value / normalizedStep) * normalizedStep
            : Number.NaN;
    }
    return quantizedValues;
}

function applyEncodingOptions(parsed, encodingOptions = {}) {
    const source = parsed?.recordsTyped;
    if (!source || !Number.isFinite(Number(source.recordCount))) {
        return parsed;
    }
    const recordCount = Number(source.recordCount);
    return {
        ...parsed,
        recordsTyped: {
            ...source,
            powersW: quantizeSeries(source.powersW, recordCount, encodingOptions.powerStep ?? 2),
            cadencesRpm: quantizeSeries(source.cadencesRpm, recordCount, encodingOptions.cadenceStep ?? 2),
            heartRatesBpm: quantizeSeries(source.heartRatesBpm, recordCount, encodingOptions.hrStep ?? 2)
        }
    };
}

function isRelevantFitEntry(name) {
    const normalized = String(name || "").replace(/\\/g, "/").toLowerCase();
    const baseName = normalized.split("/").pop() || "";
    if (normalized.startsWith("__macosx/") || baseName.startsWith("._")) {
        return false;
    }
    return normalized.endsWith(".fit");
}

function runFflateBenchmark(zipBytes) {
    const startedAt = performance.now();
    const openStartedAt = performance.now();
    const archive = unzipSync(zipBytes);
    const openMs = performance.now() - openStartedAt;

    const enumerateStartedAt = performance.now();
    const entryNames = Object.keys(archive);
    const relevantEntries = entryNames.filter(isRelevantEntry);
    const enumerateMs = performance.now() - enumerateStartedAt;

    const extractStartedAt = performance.now();
    let extractedBytes = 0;
    for (const entryName of relevantEntries) {
        extractedBytes += archive[entryName]?.byteLength || 0;
    }
    const extractMs = performance.now() - extractStartedAt;

    return {
        openMs,
        enumerateMs,
        extractMs,
        totalMs: performance.now() - startedAt,
        relevantEntryCount: relevantEntries.length,
        extractedBytes
    };
}

function runFflateAsyncBenchmark(zipBytes) {
    return new Promise((resolve, reject) => {
        const startedAt = performance.now();
        const openStartedAt = performance.now();
        unzip(zipBytes, (error, archive) => {
            if (error) {
                reject(error);
                return;
            }
            const openMs = performance.now() - openStartedAt;

            const enumerateStartedAt = performance.now();
            const entryNames = Object.keys(archive || {});
            const relevantEntries = entryNames.filter(isRelevantEntry);
            const enumerateMs = performance.now() - enumerateStartedAt;

            const extractStartedAt = performance.now();
            let extractedBytes = 0;
            for (const entryName of relevantEntries) {
                extractedBytes += archive[entryName]?.byteLength || 0;
            }
            const extractMs = performance.now() - extractStartedAt;

            resolve({
                openMs,
                enumerateMs,
                extractMs,
                totalMs: performance.now() - startedAt,
                relevantEntryCount: relevantEntries.length,
                extractedBytes
            });
        });
    });
}

async function runZipJsBenchmark(file, options = {}) {
    const useWebWorkers = options.useWebWorkers === true;
    const maxWorkers = useWebWorkers
        ? Math.max(1, Math.min(8, Number.parseInt(String(options.maxWorkers || "4"), 10) || 4))
        : 1;
    configureZipJs({
        useWebWorkers,
        maxWorkers,
        useCompressionStream: false
    });
    const startedAt = performance.now();
    const openStartedAt = performance.now();
    const reader = new ZipReader(new BlobReader(file), {
        useWebWorkers,
        maxWorkers,
        useCompressionStream: false
    });
    const openMs = performance.now() - openStartedAt;

    const enumerateStartedAt = performance.now();
    const entries = await reader.getEntries();
    const relevantEntries = entries.filter((entry) => !entry.directory && isRelevantEntry(entry.filename));
    const enumerateMs = performance.now() - enumerateStartedAt;

    const extractStartedAt = performance.now();
    let extractedBytes = 0;
    for (const entry of relevantEntries) {
        const bytes = await entry.getData(new Uint8ArrayWriter(), {
            useWebWorkers,
            maxWorkers,
            useCompressionStream: false
        });
        extractedBytes += bytes?.byteLength || 0;
    }
    const extractMs = performance.now() - extractStartedAt;
    await reader.close();

    return {
        openMs,
        enumerateMs,
        extractMs,
        totalMs: performance.now() - startedAt,
        relevantEntryCount: relevantEntries.length,
        extractedBytes
    };
}

function collectFitEntriesFromArchive(archive) {
    return Object.keys(archive)
        .filter(isRelevantFitEntry)
        .sort((left, right) => left.localeCompare(right))
        .map((entryName) => ({
            name: entryName,
            bytes: archive[entryName]
        }));
}

function processFitEntryToWoa(fitEntry, seenStartTimes = new Set()) {
    const parsed = parseFitBufferTypedBrowser(fitEntry.bytes, {
        excludeStartTimes: seenStartTimes
    });
    const startTimeKey = parsed?.skippedStartTime || buildParsedStartTimeKey(parsed);
    if (parsed?.skippedExisting) {
        if (startTimeKey) {
            seenStartTimes.add(startTimeKey);
        }
        return { status: "skipped-existing", bytes: 0, startTimeKey };
    }
    if (isTooShortWorkout(parsed)) {
        if (startTimeKey) {
            seenStartTimes.add(startTimeKey);
        }
        return { status: "skipped-too-short", bytes: 0, startTimeKey };
    }
    const adjustedParsed = applyEncodingOptions(parsed, PIPELINE_ENCODING_OPTIONS);
    const result = createWoa1File(adjustedParsed, {
        sourceName: fitEntry.name,
        sampleRateSeconds: 5,
        compressWorkoutStream: (bytes, options = {}) => gzipSync(bytes, options),
        compressGpsTrack: (bytes, options = {}) => gzipSync(bytes, options)
    });
    if (startTimeKey) {
        seenStartTimes.add(startTimeKey);
    }
    return {
        status: "completed",
        bytes: result.bytes.byteLength,
        startTimeKey
    };
}

function runUploadPipelineSerialBenchmark(zipBytes) {
    const startedAt = performance.now();
    const unzipStartedAt = performance.now();
    const archive = unzipSync(zipBytes);
    const unzipMs = performance.now() - unzipStartedAt;

    const fitCollectStartedAt = performance.now();
    const fitEntries = collectFitEntriesFromArchive(archive);
    const fitEntryCollectMs = performance.now() - fitCollectStartedAt;

    const processStartedAt = performance.now();
    const seenStartTimes = new Set();
    let outputBytes = 0;
    let importedCount = 0;
    let skippedCount = 0;
    for (const fitEntry of fitEntries) {
        const result = processFitEntryToWoa(fitEntry, seenStartTimes);
        if (result.status !== "completed") {
            skippedCount += 1;
            continue;
        }
        outputBytes += result.bytes;
        importedCount += 1;
    }
    const processMs = performance.now() - processStartedAt;

    return {
        unzipMs,
        fitEntryCollectMs,
        processMs,
        totalMs: performance.now() - startedAt,
        fitEntryCount: fitEntries.length,
        importedCount,
        skippedCount,
        outputBytes
    };
}

async function runUploadPipelineParallelBenchmark(zipBytes, workerCount) {
    const startedAt = performance.now();
    const unzipStartedAt = performance.now();
    const archive = unzipSync(zipBytes);
    const unzipMs = performance.now() - unzipStartedAt;

    const fitCollectStartedAt = performance.now();
    const fitEntries = collectFitEntriesFromArchive(archive);
    const fitEntryCollectMs = performance.now() - fitCollectStartedAt;

    const processStartedAt = performance.now();
    const poolSize = Math.min(Math.max(1, workerCount), fitEntries.length || 1);
    const workers = Array.from({ length: poolSize }, () => new Worker("/js/upload-fit-entry-worker.js", { type: "module" }));

    const result = await new Promise((resolve, reject) => {
        let nextTaskIndex = 0;
        let activeWorkers = workers.length;
        let outputBytes = 0;
        let importedCount = 0;
        let skippedCount = 0;
        const cleanup = () => {
            workers.forEach((worker) => worker.terminate());
        };
        const dispatchTask = (worker) => {
            if (nextTaskIndex >= fitEntries.length) {
                activeWorkers -= 1;
                if (activeWorkers === 0) {
                    cleanup();
                    resolve({ outputBytes, importedCount, skippedCount });
                }
                return;
            }
            const entry = fitEntries[nextTaskIndex];
            const taskId = nextTaskIndex;
            nextTaskIndex += 1;
            worker.postMessage({
                taskId,
                entryName: entry.name,
                arrayBuffer: entry.bytes.buffer.slice(
                    entry.bytes.byteOffset,
                    entry.bytes.byteOffset + entry.bytes.byteLength
                ),
                existingStartTimes: [],
                encodingOptions: PIPELINE_ENCODING_OPTIONS
            });
        };

        for (const worker of workers) {
            worker.addEventListener("error", (event) => {
                cleanup();
                reject(event.error || new Error(event.message || "FIT worker failed"));
            });
            worker.addEventListener("message", (event) => {
                const data = event.data || {};
                if (data.type !== "fit-entry-result") {
                    return;
                }
                if (data.status === "completed") {
                    outputBytes += new Uint8Array(data.woaBytes || new ArrayBuffer(0)).byteLength;
                    importedCount += 1;
                } else if (data.status === "skipped-existing" || data.status === "skipped-too-short") {
                    skippedCount += 1;
                }
                dispatchTask(worker);
            });
        }

        for (const worker of workers) {
            dispatchTask(worker);
        }
    });

    return {
        unzipMs,
        fitEntryCollectMs,
        processMs: performance.now() - processStartedAt,
        totalMs: performance.now() - startedAt,
        fitEntryCount: fitEntries.length,
        importedCount: result.importedCount,
        skippedCount: result.skippedCount,
        outputBytes: result.outputBytes
    };
}

function runStreamingSimulationFflateSerial(zipBytes, chunkSize) {
    const startedAt = performance.now();
    const archive = unzipSync(zipBytes);
    const fitEntries = collectFitEntriesFromArchive(archive);
    const seenStartTimes = new Set();
    const chunkTimelineMs = [];
    let importedCount = 0;

    for (const fitEntry of fitEntries) {
        const result = processFitEntryToWoa(fitEntry, seenStartTimes);
        if (result.status !== "completed") {
            continue;
        }
        importedCount += 1;
        if (importedCount % chunkSize === 0) {
            chunkTimelineMs.push(performance.now() - startedAt);
        }
    }
    if (importedCount > 0 && importedCount % chunkSize !== 0) {
        chunkTimelineMs.push(performance.now() - startedAt);
    }

    return {
        totalMs: performance.now() - startedAt,
        importedCount,
        chunkTimelineMs
    };
}

async function runStreamingSimulationFflateParallel(zipBytes, workerCount, chunkSize) {
    const startedAt = performance.now();
    const archive = unzipSync(zipBytes);
    const fitEntries = collectFitEntriesFromArchive(archive);
    const poolSize = Math.min(Math.max(1, workerCount), fitEntries.length || 1);
    const workers = Array.from({ length: poolSize }, () => new Worker("/js/upload-fit-entry-worker.js", { type: "module" }));

    return new Promise((resolve, reject) => {
        let nextTaskIndex = 0;
        let activeWorkers = workers.length;
        let importedCount = 0;
        const chunkTimelineMs = [];
        const cleanup = () => {
            workers.forEach((worker) => worker.terminate());
        };
        const dispatchTask = (worker) => {
            if (nextTaskIndex >= fitEntries.length) {
                activeWorkers -= 1;
                if (activeWorkers === 0) {
                    if (importedCount > 0 && importedCount % chunkSize !== 0) {
                        chunkTimelineMs.push(performance.now() - startedAt);
                    }
                    cleanup();
                    resolve({
                        totalMs: performance.now() - startedAt,
                        importedCount,
                        chunkTimelineMs
                    });
                }
                return;
            }
            const entry = fitEntries[nextTaskIndex];
            nextTaskIndex += 1;
            worker.postMessage({
                taskId: nextTaskIndex,
                entryName: entry.name,
                arrayBuffer: entry.bytes.buffer.slice(
                    entry.bytes.byteOffset,
                    entry.bytes.byteOffset + entry.bytes.byteLength
                ),
                existingStartTimes: [],
                encodingOptions: PIPELINE_ENCODING_OPTIONS
            });
        };

        for (const worker of workers) {
            worker.addEventListener("error", (event) => {
                cleanup();
                reject(event.error || new Error(event.message || "FIT worker failed"));
            });
            worker.addEventListener("message", (event) => {
                const data = event.data || {};
                if (data.type !== "fit-entry-result") {
                    return;
                }
                if (data.status === "completed") {
                    importedCount += 1;
                    if (importedCount % chunkSize === 0) {
                        chunkTimelineMs.push(performance.now() - startedAt);
                    }
                }
                dispatchTask(worker);
            });
        }

        for (const worker of workers) {
            dispatchTask(worker);
        }
    });
}

async function runStreamingSimulationZipJsSerial(file, chunkSize) {
    configureZipJs({
        useWebWorkers: false,
        maxWorkers: 1,
        useCompressionStream: false
    });
    const startedAt = performance.now();
    const reader = new ZipReader(new BlobReader(file), {
        useWebWorkers: false,
        maxWorkers: 1,
        useCompressionStream: false
    });
    const entries = await reader.getEntries();
    const relevantEntries = entries
        .filter((entry) => !entry.directory && isRelevantFitEntry(entry.filename))
        .sort((left, right) => left.filename.localeCompare(right.filename));
    const seenStartTimes = new Set();
    const chunkTimelineMs = [];
    let importedCount = 0;

    for (const entry of relevantEntries) {
        const bytes = await entry.getData(new Uint8ArrayWriter(), {
            useWebWorkers: false,
            maxWorkers: 1,
            useCompressionStream: false
        });
        const result = processFitEntryToWoa({
            name: entry.filename,
            bytes
        }, seenStartTimes);
        if (result.status !== "completed") {
            continue;
        }
        importedCount += 1;
        if (importedCount % chunkSize === 0) {
            chunkTimelineMs.push(performance.now() - startedAt);
        }
    }
    if (importedCount > 0 && importedCount % chunkSize !== 0) {
        chunkTimelineMs.push(performance.now() - startedAt);
    }
    await reader.close();

    return {
        totalMs: performance.now() - startedAt,
        importedCount,
        chunkTimelineMs
    };
}

async function runBenchmark() {
    const file = fileInput?.files?.[0];
    const repeats = Math.max(1, Math.min(10, Number.parseInt(repeatsInput?.value || "3", 10) || 3));
    const includeAsync = includeAsyncInput?.checked === true;
    const includePipeline = includePipelineInput?.checked === true;
    const includeStreamingSim = includeStreamingSimInput?.checked === true;
    const pipelineWorkers = Math.max(1, Math.min(8, Number.parseInt(pipelineWorkersInput?.value || "4", 10) || 4));
    const chunkSize = Math.max(1, Math.min(500, Number.parseInt(chunkSizeInput?.value || "50", 10) || 50));
    const zipJsUseWorkers = zipJsUseWorkersInput?.checked === true;
    const zipJsWorkers = Math.max(1, Math.min(8, Number.parseInt(zipJsWorkersInput?.value || "4", 10) || 4));

    if (!file) {
        setStatus("Bitte zuerst eine ZIP-Datei auswaehlen.");
        return;
    }

    runButton.disabled = true;
    summaryNode.innerHTML = "";
    resultsNode.innerHTML = "";
    streamingResultsNode.innerHTML = "";
    rawOutputNode.innerHTML = "";

    try {
        setStatus("Quelldatei wird gelesen...");
        const zipBuffer = await file.arrayBuffer();
        const zipBytes = new Uint8Array(zipBuffer);

        const fflateRuns = [];
        const fflateAsyncRuns = [];
        const zipJsRuns = [];
        const zipJsAsyncRuns = [];
        const pipelineSerialRuns = [];
        const pipelineParallelRuns = [];
        const streamingFflateSerialRuns = [];
        const streamingFflateParallelRuns = [];
        const streamingZipJsSerialRuns = [];

        for (let iteration = 0; iteration < repeats; iteration += 1) {
            setStatus(`fflate Lauf ${iteration + 1}/${repeats}...`);
            fflateRuns.push(runFflateBenchmark(zipBytes));
        }

        if (includeAsync) {
            for (let iteration = 0; iteration < repeats; iteration += 1) {
                setStatus(`fflate async Lauf ${iteration + 1}/${repeats}...`);
                fflateAsyncRuns.push(await runFflateAsyncBenchmark(zipBytes));
            }
        }

        for (let iteration = 0; iteration < repeats; iteration += 1) {
            setStatus(`zip.js seriell Lauf ${iteration + 1}/${repeats}...`);
            zipJsRuns.push(await runZipJsBenchmark(file, {
                useWebWorkers: false,
                maxWorkers: 1
            }));
        }

        if (includeAsync) {
            for (let iteration = 0; iteration < repeats; iteration += 1) {
                setStatus(`zip.js async Lauf ${iteration + 1}/${repeats}...`);
                zipJsAsyncRuns.push(await runZipJsBenchmark(file, {
                    useWebWorkers: zipJsUseWorkers,
                    maxWorkers: zipJsWorkers
                }));
            }
        }

        if (includePipeline) {
            for (let iteration = 0; iteration < repeats; iteration += 1) {
                setStatus(`Upload-Semantik seriell ${iteration + 1}/${repeats}...`);
                pipelineSerialRuns.push(runUploadPipelineSerialBenchmark(zipBytes));
            }
            for (let iteration = 0; iteration < repeats; iteration += 1) {
                setStatus(`Upload-Semantik parallel ${iteration + 1}/${repeats}...`);
                pipelineParallelRuns.push(await runUploadPipelineParallelBenchmark(zipBytes, pipelineWorkers));
            }
        }

        if (includeStreamingSim) {
            for (let iteration = 0; iteration < repeats; iteration += 1) {
                setStatus(`Streaming-Sim fflate seriell ${iteration + 1}/${repeats}...`);
                streamingFflateSerialRuns.push(runStreamingSimulationFflateSerial(zipBytes, chunkSize));
            }
            for (let iteration = 0; iteration < repeats; iteration += 1) {
                setStatus(`Streaming-Sim fflate parallel ${iteration + 1}/${repeats}...`);
                streamingFflateParallelRuns.push(await runStreamingSimulationFflateParallel(zipBytes, pipelineWorkers, chunkSize));
            }
            for (let iteration = 0; iteration < repeats; iteration += 1) {
                setStatus(`Streaming-Sim zip.js seriell ${iteration + 1}/${repeats}...`);
                streamingZipJsSerialRuns.push(await runStreamingSimulationZipJsSerial(file, chunkSize));
            }
        }

        await terminateZipJsWorkers();

        renderResults({
            file,
            repeats,
            summaries: [
                summarizeRuns("fflate", "sync", fflateRuns),
                includeAsync ? summarizeRuns("fflate", "async", fflateAsyncRuns) : null,
                summarizeRuns("zip.js", "serial", zipJsRuns),
                includeAsync ? summarizeRuns("zip.js", zipJsUseWorkers ? `async (${zipJsWorkers} workers)` : "async (no workers)", zipJsAsyncRuns) : null,
                includePipeline ? summarizePipelineRuns("upload path", "serial", pipelineSerialRuns) : null,
                includePipeline ? summarizePipelineRuns("upload path", `parallel (${pipelineWorkers} workers)`, pipelineParallelRuns) : null
            ],
            rawRuns: {
                fflateRuns,
                fflateAsyncRuns,
                zipJsRuns,
                zipJsAsyncRuns,
                pipelineSerialRuns,
                pipelineParallelRuns,
                streamingFflateSerialRuns,
                streamingFflateParallelRuns,
                streamingZipJsSerialRuns,
                chunkSize
            }
        });

        if (includeStreamingSim) {
            const streamingRows = [
                summarizeStreamingRuns("stream sim", "fflate + serial FIT", streamingFflateSerialRuns),
                summarizeStreamingRuns("stream sim", `fflate + parallel FIT (${pipelineWorkers})`, streamingFflateParallelRuns),
                summarizeStreamingRuns("stream sim", "zip.js + serial FIT", streamingZipJsSerialRuns)
            ];
            streamingResultsNode.innerHTML = `
                <h2>Streaming-Simulation</h2>
                <p class="muted">
                    Gemessen wird, wann jeweils ein weiterer Chunk mit ${chunkSize} Workouts theoretisch in einen Request-Stream
                    geschrieben werden koennte.
                </p>
                ${buildStreamingTable(streamingRows)}
            `;
            console.table(streamingRows);
        }
        setStatus("Benchmark abgeschlossen.");
    } catch (error) {
        console.error("[zip-benchmark] failed", error);
        setStatus(`Fehler: ${error?.message || String(error)}`);
    } finally {
        try {
            await terminateZipJsWorkers();
        } catch {
            // ignore benchmark cleanup errors
        }
        runButton.disabled = false;
    }
}
