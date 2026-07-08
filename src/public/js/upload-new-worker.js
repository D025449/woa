import { parseFitBufferTypedBrowser } from "./fit-import-typed-browser.js";
import { applyCompactEncodingOptions, parseFitBufferCompactBrowser } from "./fit-import-compact-browser.js";
import { createWoa1File } from "./woa-format.js";
import { createWoa1FileFromCompact } from "./woa-format-compact.js";
import { encodeWoaTransportContainer } from "./woa-transport-container.js";
import { gzipSync, unzipSync, zipSync } from "/vendor/fflate/browser.js";

const PER_FILE_GZIP_LEVEL = 4;
const OUTER_ZIP_LEVEL = 0;
const DEFAULT_BENCH_REPEAT_COUNT = 10;
const MIN_WORKOUT_RECORD_COUNT = 300;
const TEXT_DECODER = new TextDecoder();
const CUSTOM_CONTAINER_GZIP_LEVEL = 4;
let prewarmedFitWorkers = [];
const preparedZipSources = new Map();

async function compressGzip(bytes, level = PER_FILE_GZIP_LEVEL) {
  return gzipSync(bytes, { level });
}

function nowMs() {
  return performance.now();
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

  return Number.isFinite(minStartTimeMs)
    ? new Date(minStartTimeMs).toISOString()
    : null;
}

function getParsedRecordCount(parsed) {
  return Number(
    parsed?.recordsTyped?.recordCount
      ?? parsed?.compactRecords?.recordCount
      ?? 0
  );
}

function getParsedSessionCount(parsed) {
  return Array.isArray(parsed?.sessions) ? parsed.sessions.length : 0;
}

function adjustParsedForEncoding(parsed, parserVariant, encodingOptions) {
  return parserVariant === "compact"
    ? applyCompactEncodingOptions(parsed, encodingOptions)
    : applyEncodingOptions(parsed, encodingOptions);
}

function createWoaFromParsed(parsed, parserVariant, fileName, encodingOptions) {
  if (parserVariant === "compact") {
    const adjustedParsed = adjustParsedForEncoding(parsed, parserVariant, encodingOptions);
    return {
      adjustedParsed,
      result: createWoa1FileFromCompact(adjustedParsed, {
        sourceName: fileName,
        sampleRateSeconds: 5,
        powerEncoding: encodingOptions?.compactPowerEncoding === "raw16" ? "raw16" : "delta8-q4w",
        distanceEncoding: encodingOptions?.compactDistanceEncoding === "default" ? "default" : "uint8-q02",
        altitudeEncoding: encodingOptions?.compactAltitudeEncoding === "delta8-q1m" ? "delta8-q1m" : "rle-delta-q1m",
        compressWorkoutStream: (bytes, options = {}) => gzipSync(bytes, options),
        compressGpsTrack: (bytes, options = {}) => gzipSync(bytes, options)
      })
    };
  }

  const adjustedParsed = adjustParsedForEncoding(parsed, parserVariant, encodingOptions);
  return {
    adjustedParsed,
    result: createWoa1File(adjustedParsed, {
      sourceName: fileName,
      sampleRateSeconds: 5,
      compressWorkoutStream: (bytes, options = {}) => gzipSync(bytes, options),
      compressGpsTrack: (bytes, options = {}) => gzipSync(bytes, options)
    })
  };
}

function isTooShortWorkout(parsed) {
  const recordCount = getParsedRecordCount(parsed);
  return recordCount < MIN_WORKOUT_RECORD_COUNT;
}

function isRealFitZipEntry(entryName) {
  const normalized = String(entryName || "").replace(/\\/g, "/");
  const baseName = normalized.split("/").pop() || "";

  if (!normalized.toLowerCase().endsWith(".fit")) {
    return false;
  }

  if (normalized.startsWith("__MACOSX/")) {
    return false;
  }
  if (baseName.startsWith("._")) {
    return false;
  }

  return true;
}

function isRealWoaZipEntry(entryName) {
  const normalized = String(entryName || "").replace(/\\/g, "/");
  const baseName = normalized.split("/").pop() || "";

  if (!normalized.toLowerCase().endsWith(".woa1")) {
    return false;
  }

  if (normalized.startsWith("__MACOSX/")) {
    return false;
  }
  if (baseName.startsWith("._")) {
    return false;
  }

  return true;
}

function shouldExtractZipEntry(file) {
  const entryName = String(file?.name || "");
  return isRealFitZipEntry(entryName) || isRealWoaZipEntry(entryName);
}

function average(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length;
}

function averageTimingMaps(samples = []) {
  if (!Array.isArray(samples) || samples.length === 0) {
    return {};
  }

  const totals = new Map();
  for (const sample of samples) {
    if (!sample || typeof sample !== "object") {
      continue;
    }
    for (const [key, value] of Object.entries(sample)) {
      totals.set(key, (totals.get(key) || 0) + Number(value || 0));
    }
  }

  const averages = {};
  for (const [key, total] of totals.entries()) {
    averages[key] = total / samples.length;
  }
  return averages;
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
  const powerStep = Math.max(1, Number.parseInt(String(encodingOptions.powerStep ?? 4), 10) || 4);
  const cadenceStep = Math.max(1, Number.parseInt(String(encodingOptions.cadenceStep ?? 2), 10) || 2);
  const hrStep = Math.max(1, Number.parseInt(String(encodingOptions.hrStep ?? 2), 10) || 2);
  return {
    ...parsed,
    recordsTyped: {
      ...source,
      powersW: quantizeSeries(source.powersW, recordCount, powerStep),
      cadencesRpm: quantizeSeries(source.cadencesRpm, recordCount, cadenceStep),
      heartRatesBpm: quantizeSeries(source.heartRatesBpm, recordCount, hrStep)
    }
  };
}

function getFitParserVariant(encodingOptions = {}) {
  return encodingOptions?.fitParserVariant === "compact" ? "compact" : "typed";
}

function sumNumericField(samples = [], fieldName) {
  if (!Array.isArray(samples) || !fieldName) {
    return 0;
  }

  let total = 0;
  for (const sample of samples) {
    total += Number(sample?.[fieldName] || 0);
  }
  return total;
}

function normalizeExistingStartTimeSet(existingStartTimes = []) {
  return new Set(
    Array.isArray(existingStartTimes)
      ? existingStartTimes.filter((value) => typeof value === "string" && value)
      : []
  );
}

function resolveParallelWorkerCount(requestedCount) {
  const parsed = Number.parseInt(String(requestedCount || ""), 10);
  if (Number.isInteger(parsed) && parsed >= 1) {
    return Math.min(8, parsed);
  }
  const hardware = Number(self.navigator?.hardwareConcurrency || 0);
  if (Number.isFinite(hardware) && hardware > 2) {
    return Math.min(4, Math.max(2, hardware - 1));
  }
  return 2;
}

function ensurePrewarmedFitWorkerPool(workerCount) {
  const targetCount = Math.max(0, Number(workerCount || 0));
  const startedAt = nowMs();
  while (prewarmedFitWorkers.length < targetCount) {
    prewarmedFitWorkers.push(new Worker("/js/upload-fit-entry-worker.js", { type: "module" }));
  }
  while (prewarmedFitWorkers.length > targetCount) {
    const worker = prewarmedFitWorkers.pop();
    worker?.terminate();
  }
  return nowMs() - startedAt;
}

function acquireFitWorkers(workerCount) {
  ensurePrewarmedFitWorkerPool(workerCount);
  return prewarmedFitWorkers.splice(0, Math.min(workerCount, prewarmedFitWorkers.length));
}

function releaseFitWorkers(workers = []) {
  for (const worker of workers) {
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      prewarmedFitWorkers.push(worker);
    }
  }
}

function postStartupMetric(name, valueMs, extra = {}) {
  self.postMessage({
    type: "startup-metric",
    name,
    valueMs: Number(valueMs || 0),
    ...extra
  });
}

function prepareZipSource({ token, fileName, arrayBuffer }) {
  const zipBytes = new Uint8Array(arrayBuffer);
  const startedAt = nowMs();
  const unzipStartedAt = nowMs();
  const archive = unzipSync(zipBytes, {
    filter: shouldExtractZipEntry
  });
  const unzipMs = nowMs() - unzipStartedAt;
  const entryScanStartedAt = nowMs();
  const entryNames = Object.keys(archive);
  const fitEntries = entryNames
    .filter(isRealFitZipEntry)
    .sort((left, right) => left.localeCompare(right))
    .map((entryName) => ({
      name: entryName,
      bytes: archive[entryName]
    }));
  const woaEntries = entryNames
    .filter(isRealWoaZipEntry)
    .sort((left, right) => left.localeCompare(right))
    .map((entryName) => ({
      name: entryName,
      bytes: archive[entryName]
    }));
  const entryScanMs = nowMs() - entryScanStartedAt;

  preparedZipSources.set(token, {
    fileName,
    sourceBytes: zipBytes.byteLength,
    fitEntries,
    woaEntries,
    unzipMs,
    entryScanMs,
    preparedAt: Date.now()
  });

  return {
    token,
    fileName,
    sourceBytes: zipBytes.byteLength,
    fitEntryCount: fitEntries.length,
    woaEntryCount: woaEntries.length,
    unzipMs,
    entryScanMs,
    prepareMs: nowMs() - startedAt
  };
}

async function convertFitEntriesParallel({
  fitEntries = [],
  existingStartTimes = [],
  encodingOptions = {},
  onProgress,
  workerCount = 2
}) {
  if (!fitEntries.length) {
    return {
      completedEntries: [],
      skippedEntries: [],
      skippedExistingEntries: [],
      skippedTooShortEntries: [],
      parseSamplesMs: [],
      buildSamplesMs: [],
      buildTimingSamples: [],
      speedFallbackWorkoutCount: 0,
      speedFallbackRecordCount: 0,
      totalRecordCount: 0,
      totalGpsPointCount: 0
    };
  }

  const poolSize = Math.min(Math.max(1, workerCount), fitEntries.length);
  const fitWorkerPoolWarmStartedAt = nowMs();
  const workers = acquireFitWorkers(poolSize);
  postStartupMetric("fitWorkerPoolWarmMs", nowMs() - fitWorkerPoolWarmStartedAt, {
    workerCount: poolSize
  });
  while (workers.length < poolSize) {
    workers.push(new Worker("/js/upload-fit-entry-worker.js", { type: "module" }));
  }
  const completedEntries = [];
  const skippedEntries = [];
  const skippedExistingEntries = [];
  const skippedTooShortEntries = [];
  const parseSamplesMs = [];
  const buildSamplesMs = [];
  const buildTimingSamples = [];
  let speedFallbackWorkoutCount = 0;
  let speedFallbackRecordCount = 0;
  let totalRecordCount = 0;
  let totalGpsPointCount = 0;
  const seenAcceptedStartTimes = new Set(normalizeExistingStartTimeSet(existingStartTimes));
  let nextTaskIndex = 0;
  let resolvedCount = 0;
  const startedAt = nowMs();
  let firstDispatchAt = null;
  let firstResultAt = null;

  const dispatchTask = (worker, taskIndex) => {
    const entry = fitEntries[taskIndex];
    if (firstDispatchAt === null) {
      firstDispatchAt = nowMs();
      postStartupMetric("firstFitDispatchMs", firstDispatchAt - startedAt, {
        entryName: entry.name
      });
    }
    worker.postMessage({
      taskId: taskIndex,
      entryName: entry.name,
      arrayBuffer: entry.bytes.buffer.slice(
        entry.bytes.byteOffset,
        entry.bytes.byteOffset + entry.bytes.byteLength
      ),
      existingStartTimes,
      encodingOptions
    });
  };

  await new Promise((resolve, reject) => {
    let activeWorkers = poolSize;
    let settled = false;

    const cleanup = () => {
      releaseFitWorkers(workers);
    };

    for (const worker of workers) {
      worker.addEventListener("error", (event) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(event.error || new Error(event.message || "Parallel FIT worker failed"));
      });

      worker.addEventListener("message", (event) => {
        if (settled) {
          return;
        }

        const data = event.data || {};
        if (data.type !== "fit-entry-result") {
          return;
        }

        if (firstResultAt === null) {
          firstResultAt = nowMs();
          postStartupMetric("firstFitResultMs", firstResultAt - startedAt, {
            entryName: data.entryName
          });
        }

        resolvedCount += 1;
        if (typeof onProgress === "function") {
          onProgress({
            entryName: data.entryName,
            processedEntries: resolvedCount,
            totalEntries: fitEntries.length
          });
        }

        if (data.status === "completed") {
          if (data.startTime && seenAcceptedStartTimes.has(data.startTime)) {
            skippedExistingEntries.push({
              entryName: data.entryName,
              startTime: data.startTime
            });
          } else {
            if (data.startTime) {
              seenAcceptedStartTimes.add(data.startTime);
            }
            completedEntries.push({
              entryName: data.entryName,
              woaBytes: new Uint8Array(data.woaBytes),
              startTime: data.startTime
            });
            parseSamplesMs.push(Number(data.timings?.parseMs || 0));
            buildSamplesMs.push(Number(data.timings?.buildWoaMs || 0));
            buildTimingSamples.push(data.timings?.buildWoaStepsMs || {});
            speedFallbackWorkoutCount += Number(data.workoutStreamStats?.usesSpeedFallback ? 1 : 0);
            speedFallbackRecordCount += Number(data.workoutStreamStats?.speedFallbackRecordCount || 0);
            totalRecordCount += Number(data.recordCount || 0);
            totalGpsPointCount += Number(data.gpsPointCount || 0);
          }
        } else if (data.status === "skipped-existing") {
          skippedExistingEntries.push({
            entryName: data.entryName,
            startTime: data.startTime
          });
        } else if (data.status === "skipped-too-short") {
          skippedTooShortEntries.push({
            entryName: data.entryName,
            recordCount: Number(data.recordCount || 0)
          });
        } else if (data.status === "failed") {
          skippedEntries.push({
            entryName: data.entryName,
            error: data.error || "Unknown worker error"
          });
        }

        if (nextTaskIndex < fitEntries.length) {
          dispatchTask(worker, nextTaskIndex);
          nextTaskIndex += 1;
          return;
        }

        activeWorkers -= 1;
        if (activeWorkers === 0) {
          settled = true;
          cleanup();
          resolve();
        }
      });
    }

    for (const worker of workers) {
      if (nextTaskIndex >= fitEntries.length) {
        break;
      }
      dispatchTask(worker, nextTaskIndex);
      nextTaskIndex += 1;
    }
  });

  return {
    completedEntries,
    skippedEntries,
    skippedExistingEntries,
    skippedTooShortEntries,
    parseSamplesMs,
    buildSamplesMs,
    buildTimingSamples,
    speedFallbackWorkoutCount,
    speedFallbackRecordCount,
    totalRecordCount,
    totalGpsPointCount
  };
}

function createUniqueEntryName(entryName, usedNames) {
  const normalized = String(entryName || "workout.woa1");
  if (!usedNames.has(normalized)) {
    usedNames.add(normalized);
    return normalized;
  }

  const dotIndex = normalized.lastIndexOf(".");
  const baseName = dotIndex >= 0 ? normalized.slice(0, dotIndex) : normalized;
  const extension = dotIndex >= 0 ? normalized.slice(dotIndex) : "";

  let suffix = 2;
  while (true) {
    const candidate = `${baseName}-${suffix}${extension}`;
    if (!usedNames.has(candidate)) {
      usedNames.add(candidate);
      return candidate;
    }
    suffix += 1;
  }
}

function inspectWoaStartTimeKey(woaBytes) {
  const bytes = woaBytes instanceof Uint8Array ? woaBytes : new Uint8Array(woaBytes);
  if (bytes.byteLength < 16) {
    return null;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = TEXT_DECODER.decode(bytes.subarray(0, 4));
  if (magic !== "WOA1") {
    return null;
  }

  const metaLength = view.getUint32(4, true);
  const sessionsLength = view.getUint32(8, true);
  const workoutLength = view.getUint32(12, true);
  const requiredLength = 16 + metaLength + sessionsLength + workoutLength;
  if (requiredLength > bytes.byteLength) {
    return null;
  }

  try {
    const metaStart = 16;
    const metaEnd = metaStart + metaLength;
    const metaJson = TEXT_DECODER.decode(bytes.subarray(metaStart, metaEnd));
    const meta = JSON.parse(metaJson);
    const candidate = meta?.persistedRow?.start_time || meta?.startTime || null;
    if (!candidate) {
      return null;
    }
    const date = new Date(candidate);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  } catch {
    return null;
  }
}

self.addEventListener("message", async (event) => {
  const {
    type,
    fileName,
    arrayBuffer,
    files = [],
    repeatCount = DEFAULT_BENCH_REPEAT_COUNT,
    prewarmedZipToken = null,
    prewarmedZipTokens = [],
    prewarmedZipFiles = [],
    existingStartTimes = [],
    encodingOptions = {},
    outputMode = "zip",
    parallelFitPoolEnabled = false,
    parallelFitWorkers = null
  } = event.data || {};

  if (type === "prewarm-fit-worker-pool") {
    const enabled = event.data?.enabled !== false;
    const workerCount = enabled ? resolveParallelWorkerCount(event.data?.workerCount) : 0;
    const warmMs = ensurePrewarmedFitWorkerPool(workerCount);
    self.postMessage({
      type: "prewarm-complete",
      workerCount,
      warmMs
    });
    return;
  }

  if (type === "prepare-zip-source") {
    try {
      const result = prepareZipSource({
        token: event.data?.token,
        fileName,
        arrayBuffer
      });
      self.postMessage({
        type: "zip-prepare-complete",
        ...result
      });
    } catch (error) {
      self.postMessage({
        type: "zip-prepare-complete",
        token: event.data?.token,
        fileName,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    return;
  }

  const canUsePreparedZipSource = type === "convert-zip-to-woa-zip" && !!prewarmedZipToken;
  const canUsePreparedZipSources = type === "convert-fit-files-to-woa-zip"
    && Array.isArray(prewarmedZipFiles)
    && prewarmedZipFiles.length > 0;

  if (
    !arrayBuffer
    && !canUsePreparedZipSource
    && !canUsePreparedZipSources
    && (!Array.isArray(files) || files.length === 0)
  ) {
    return;
  }

  try {
    if (type === "convert-zip-to-woa-zip") {
      await handleZipConversion({
        fileName,
        arrayBuffer,
        prewarmedZipToken,
        existingStartTimes,
        encodingOptions,
        outputMode,
        parallelFitPoolEnabled,
        parallelFitWorkers
      });
      return;
    }

    if (type === "convert-fit-files-to-woa-zip") {
      await handleFitFilesConversion({
        fileName,
        files,
        prewarmedZipTokens,
        prewarmedZipFiles,
        existingStartTimes,
        encodingOptions,
        outputMode,
        parallelFitPoolEnabled,
        parallelFitWorkers
      });
      return;
    }

    if (type !== "convert-fit-to-woa") {
      return;
    }

    const startedAt = nowMs();
    const parseSamplesMs = [];
    const buildSamplesMs = [];
    const gzipSamplesMs = [];
    const buildTimingSamples = [];
    const workoutStreamStatSamples = [];
    let finalParsed = null;
    let finalWoaBytes = null;
    let finalGzipBytes = null;
    let finalMeta = null;
    let finalGpsPointCount = 0;

    self.postMessage({
      type: "phase",
      phase: "parsing-fit"
    });

    const normalizedRepeatCount = Number.isInteger(Number(repeatCount)) && Number(repeatCount) > 0
      ? Number(repeatCount)
      : DEFAULT_BENCH_REPEAT_COUNT;

    for (let iteration = 0; iteration < normalizedRepeatCount; iteration += 1) {
      const parseStartedAt = nowMs();
      const parserVariant = getFitParserVariant(encodingOptions);
      const parsed = parserVariant === "compact"
        ? parseFitBufferCompactBrowser(arrayBuffer, {
          excludeStartTimes: existingStartTimes
        })
        : parseFitBufferTypedBrowser(arrayBuffer, {
          excludeStartTimes: existingStartTimes
        });
      parseSamplesMs.push(nowMs() - parseStartedAt);

      if (parsed?.skippedExisting) {
        self.postMessage({
          type: "skipped-existing",
          fileName,
          startTime: parsed.skippedStartTime || buildParsedStartTimeKey(parsed)
        });
        return;
      }

      if (isTooShortWorkout(parsed)) {
        self.postMessage({
          type: "skipped-too-short",
          fileName,
          recordCount: getParsedRecordCount(parsed)
        });
        return;
      }

      self.postMessage({
        type: "phase",
        phase: "building-woa",
        iteration: iteration + 1,
        totalIterations: normalizedRepeatCount
      });

      const woaStartedAt = nowMs();
      const { adjustedParsed, result } = createWoaFromParsed(parsed, parserVariant, fileName, encodingOptions);
      finalParsed = adjustedParsed;
      buildSamplesMs.push(nowMs() - woaStartedAt);
      buildTimingSamples.push(result.timings || {});
      workoutStreamStatSamples.push(result.stats?.workoutStream || {});
      finalWoaBytes = result.bytes;
      finalMeta = result.meta;
      finalGpsPointCount = Number(result.gpsTrack?.pointCount || 0);

      self.postMessage({
        type: "phase",
        phase: "compressing-gzip",
        iteration: iteration + 1,
        totalIterations: normalizedRepeatCount
      });

      const gzipStartedAt = nowMs();
      const gzipBytes = await compressGzip(result.bytes);
      gzipSamplesMs.push(nowMs() - gzipStartedAt);
      finalGzipBytes = gzipBytes;
    }

    const totalElapsedMs = nowMs() - startedAt;

    self.postMessage({
      type: "completed",
      fileName,
      outputFileName: fileName.replace(/\.fit$/i, ".woa1"),
      bytes: finalWoaBytes.buffer,
      gzipFileName: fileName.replace(/\.fit$/i, ".woa2"),
      gzipBytes: finalGzipBytes.buffer,
      meta: finalMeta,
      sessionsCount: getParsedSessionCount(finalParsed),
      recordCount: getParsedRecordCount(finalParsed),
      gpsPointCount: finalGpsPointCount,
      timings: {
        repeatCount: normalizedRepeatCount,
        parseMs: average(parseSamplesMs),
        buildWoaMs: average(buildSamplesMs),
        buildWoaStepsMs: averageTimingMaps(buildTimingSamples),
        parserVariant: getFitParserVariant(encodingOptions),
        workoutStreamStats: {
          fallbackWorkoutCount: sumNumericField(workoutStreamStatSamples, "usesSpeedFallback"),
          fallbackRecordCount: sumNumericField(workoutStreamStatSamples, "speedFallbackRecordCount")
        },
        gzipMs: average(gzipSamplesMs),
        totalMs: totalElapsedMs
      }
    }, [finalWoaBytes.buffer, finalGzipBytes.buffer]);
  } catch (error) {
    self.postMessage({
      type: "failed",
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

async function convertMixedEntriesToWoaZip({
  fileName,
  fitEntries = [],
  woaEntries = [],
  existingStartTimes = [],
  sourceBytes = 0,
  encodingOptions = {},
  outputMode = "zip",
  parallelFitPoolEnabled = false,
  parallelFitWorkers = null
}) {
  const startedAt = nowMs();
  const existingStartTimeSet = normalizeExistingStartTimeSet(existingStartTimes);
  const sortedFitEntries = [...fitEntries]
    .filter((entry) => entry?.name && entry?.bytes)
    .sort((left, right) => String(left.name).localeCompare(String(right.name)));
  const sortedWoaEntries = [...woaEntries]
    .filter((entry) => entry?.name && entry?.bytes)
    .sort((left, right) => String(left.name).localeCompare(String(right.name)));

  if (sortedFitEntries.length === 0 && sortedWoaEntries.length === 0) {
    throw new Error("The selected input does not contain any .fit or .woa1 entries");
  }

  const outputEntries = [];
  const usedOutputNames = new Set();
  const parseSamplesMs = [];
  const buildSamplesMs = [];
  const gzipSamplesMs = [];
  const buildTimingSamples = [];
  let speedFallbackWorkoutCount = 0;
  let speedFallbackRecordCount = 0;
  const skippedEntries = [];
  const skippedExistingEntries = [];
  const skippedTooShortEntries = [];
  let totalRecordCount = 0;
  let totalGpsPointCount = 0;
  let convertedFitEntries = 0;
  let passedThroughWoaEntries = 0;
  const totalEntries = sortedFitEntries.length + sortedWoaEntries.length;
  let processedEntries = 0;
  const dynamicExistingStartTimes = new Set(existingStartTimeSet);
  let firstSerialFitDispatchAt = null;
  let firstSerialFitResultAt = null;

  if (parallelFitPoolEnabled && sortedFitEntries.length > 1) {
    const parallelResult = await convertFitEntriesParallel({
      fitEntries: sortedFitEntries,
      existingStartTimes,
      encodingOptions,
      workerCount: resolveParallelWorkerCount(parallelFitWorkers),
      onProgress: ({ entryName, processedEntries: workerProcessedEntries, totalEntries: workerTotalEntries }) => {
        self.postMessage({
          type: "phase",
          phase: "zip-entry",
          entryName,
          processedEntries: workerProcessedEntries,
          totalEntries: workerTotalEntries + sortedWoaEntries.length
        });
      }
    });

    for (const item of parallelResult.completedEntries.sort((left, right) => String(left.entryName).localeCompare(String(right.entryName)))) {
      outputEntries.push({
        name: createUniqueEntryName(String(item.entryName).replace(/\.fit$/i, ".woa1"), usedOutputNames),
        bytes: item.woaBytes
      });
      if (item.startTime) {
        dynamicExistingStartTimes.add(item.startTime);
      }
      convertedFitEntries += 1;
    }

    skippedEntries.push(...parallelResult.skippedEntries);
    skippedExistingEntries.push(...parallelResult.skippedExistingEntries);
    skippedTooShortEntries.push(...parallelResult.skippedTooShortEntries);
    parseSamplesMs.push(...parallelResult.parseSamplesMs);
    buildSamplesMs.push(...parallelResult.buildSamplesMs);
    buildTimingSamples.push(...parallelResult.buildTimingSamples);
    speedFallbackWorkoutCount += Number(parallelResult.speedFallbackWorkoutCount || 0);
    speedFallbackRecordCount += Number(parallelResult.speedFallbackRecordCount || 0);
    totalRecordCount += Number(parallelResult.totalRecordCount || 0);
    totalGpsPointCount += Number(parallelResult.totalGpsPointCount || 0);
    processedEntries = sortedFitEntries.length;
  } else {
    for (const fitEntry of sortedFitEntries) {
      if (firstSerialFitDispatchAt === null) {
        firstSerialFitDispatchAt = nowMs();
        postStartupMetric("firstFitDispatchMs", firstSerialFitDispatchAt - startedAt, {
          entryName: fitEntry.name
        });
      }
      self.postMessage({
        type: "phase",
        phase: "zip-entry",
        entryName: fitEntry.name,
        processedEntries,
        totalEntries
      });

      try {
        const parseStartedAt = nowMs();
        const parserVariant = getFitParserVariant(encodingOptions);
        const parsed = parserVariant === "compact"
          ? parseFitBufferCompactBrowser(fitEntry.bytes, {
            excludeStartTimes: dynamicExistingStartTimes
          })
          : parseFitBufferTypedBrowser(fitEntry.bytes, {
            excludeStartTimes: dynamicExistingStartTimes
          });
        parseSamplesMs.push(nowMs() - parseStartedAt);

        if (parsed?.skippedExisting) {
          skippedExistingEntries.push({
            entryName: fitEntry.name,
            startTime: parsed.skippedStartTime || buildParsedStartTimeKey(parsed)
          });
          processedEntries += 1;
          continue;
        }

        if (isTooShortWorkout(parsed)) {
          skippedTooShortEntries.push({
            entryName: fitEntry.name,
            recordCount: getParsedRecordCount(parsed)
          });
          processedEntries += 1;
          continue;
        }

        const buildStartedAt = nowMs();
        const { result } = createWoaFromParsed(parsed, parserVariant, fitEntry.name, encodingOptions);
        buildSamplesMs.push(nowMs() - buildStartedAt);
        buildTimingSamples.push(result.timings || {});
        speedFallbackWorkoutCount += Number(result.stats?.workoutStream?.usesSpeedFallback ? 1 : 0);
        speedFallbackRecordCount += Number(result.stats?.workoutStream?.speedFallbackRecordCount || 0);

        const outputEntry = {
          name: createUniqueEntryName(fitEntry.name.replace(/\.fit$/i, ".woa1"), usedOutputNames),
          bytes: result.bytes
        };
        if (firstSerialFitResultAt === null) {
          firstSerialFitResultAt = nowMs();
          postStartupMetric("firstFitResultMs", firstSerialFitResultAt - startedAt, {
            entryName: fitEntry.name
          });
        }
        outputEntries.push(outputEntry);
        {
          const acceptedStartTimeKey = buildParsedStartTimeKey(parsed);
          if (acceptedStartTimeKey) {
            dynamicExistingStartTimes.add(acceptedStartTimeKey);
          }
        }
        totalRecordCount += getParsedRecordCount(parsed);
        totalGpsPointCount += Number(result.gpsTrack?.pointCount || 0);
        convertedFitEntries += 1;
      } catch (error) {
        skippedEntries.push({
          entryName: fitEntry.name,
          error: error instanceof Error ? error.message : String(error)
        });
      }

      processedEntries += 1;
    }
  }

  for (const woaEntry of sortedWoaEntries) {
    self.postMessage({
      type: "phase",
      phase: "zip-entry",
      entryName: woaEntry.name,
      processedEntries,
      totalEntries
    });

    const startTimeKey = inspectWoaStartTimeKey(woaEntry.bytes);
    if (startTimeKey && dynamicExistingStartTimes.has(startTimeKey)) {
      skippedExistingEntries.push({
        entryName: woaEntry.name,
        startTime: startTimeKey
      });
      processedEntries += 1;
      continue;
    }

    const outputEntry = {
      name: createUniqueEntryName(woaEntry.name, usedOutputNames),
      bytes: woaEntry.bytes
    };
    outputEntries.push(outputEntry);
    if (startTimeKey) {
      dynamicExistingStartTimes.add(startTimeKey);
    }
    passedThroughWoaEntries += 1;
    processedEntries += 1;
  }

  const totalOutputEntries = convertedFitEntries + passedThroughWoaEntries;

  if (
    totalOutputEntries === 0
    && (skippedExistingEntries.length > 0 || skippedTooShortEntries.length > 0)
    && skippedEntries.length === 0
  ) {
    const totalElapsedMs = nowMs() - startedAt;
    self.postMessage({
      type: "completed-zip",
      fileName,
      outputFileName: fileName.replace(/\.zip$/i, ".woa1.zip"),
      bytes: new ArrayBuffer(0),
      stats: {
        fitEntries: sortedFitEntries.length,
        woaEntries: sortedWoaEntries.length,
        convertedEntries: convertedFitEntries,
        passedThroughEntries: passedThroughWoaEntries,
        skippedEntries: 0,
        skippedExistingEntries: skippedExistingEntries.length,
        skippedTooShortEntries: skippedTooShortEntries.length,
        totalRecordCount: 0,
        totalGpsPointCount: 0,
        sourceZipBytes: sourceBytes,
        outputZipBytes: 0,
        outerZipLevel: OUTER_ZIP_LEVEL
      },
      skipped: [],
      skippedExisting: skippedExistingEntries,
      skippedTooShort: skippedTooShortEntries,
      timings: {
        parseMs: average(parseSamplesMs),
        buildWoaMs: average(buildSamplesMs),
        buildWoaStepsMs: averageTimingMaps(buildTimingSamples),
        gzipMs: average(gzipSamplesMs),
        zipBuildMs: 0,
        totalMs: totalElapsedMs
      }
    });
    return;
  }

  if (totalOutputEntries === 0) {
    throw new Error("No supported entries could be converted or passed through");
  }

  if (outputMode === "container-gzip") {
    self.postMessage({
      type: "phase",
      phase: "building-container",
      totalEntries
    });

    const containerBuildStartedAt = nowMs();
    const rawContainerBytes = encodeWoaTransportContainer(outputEntries);
    const gzipContainerBytes = gzipSync(rawContainerBytes, { level: CUSTOM_CONTAINER_GZIP_LEVEL });
    const containerBuildMs = nowMs() - containerBuildStartedAt;
    const totalElapsedMs = nowMs() - startedAt;

    self.postMessage({
      type: "completed-container",
      fileName,
      outputFileName: fileName.replace(/\.zip$/i, ".woat.gz"),
      bytes: gzipContainerBytes.buffer,
      stats: {
        fitEntries: sortedFitEntries.length,
        woaEntries: sortedWoaEntries.length,
        convertedEntries: convertedFitEntries,
        passedThroughEntries: passedThroughWoaEntries,
        skippedEntries: skippedEntries.length,
        skippedExistingEntries: skippedExistingEntries.length,
        skippedTooShortEntries: skippedTooShortEntries.length,
        totalRecordCount,
        totalGpsPointCount,
        sourceZipBytes: sourceBytes,
        outputContainerBytes: gzipContainerBytes.byteLength,
        rawContainerBytes: rawContainerBytes.byteLength,
        containerGzipLevel: CUSTOM_CONTAINER_GZIP_LEVEL
      },
      skipped: skippedEntries,
      skippedExisting: skippedExistingEntries,
      skippedTooShort: skippedTooShortEntries,
      timings: {
        parseMs: average(parseSamplesMs),
        buildWoaMs: average(buildSamplesMs),
        buildWoaStepsMs: averageTimingMaps(buildTimingSamples),
        workoutStreamStats: {
          fallbackWorkoutCount: speedFallbackWorkoutCount,
          fallbackRecordCount: speedFallbackRecordCount
        },
        gzipMs: average(gzipSamplesMs),
        zipBuildMs: 0,
        containerBuildMs,
        totalMs: totalElapsedMs
      }
    }, [gzipContainerBytes.buffer]);
    return;
  }

  self.postMessage({
    type: "phase",
    phase: "building-zip",
    totalEntries
  });

  const zipBuildStartedAt = nowMs();
  const zipEntries = {};
  for (const entry of outputEntries) {
    zipEntries[entry.name] = [entry.bytes, { level: OUTER_ZIP_LEVEL }];
  }
  const outputZipBytes = zipSync(zipEntries, { level: OUTER_ZIP_LEVEL });
  const zipBuildMs = nowMs() - zipBuildStartedAt;
  const totalElapsedMs = nowMs() - startedAt;

  self.postMessage({
    type: "completed-zip",
    fileName,
    outputFileName: fileName.replace(/\.zip$/i, ".woa1.zip"),
    bytes: outputZipBytes.buffer,
    stats: {
      fitEntries: sortedFitEntries.length,
      woaEntries: sortedWoaEntries.length,
      convertedEntries: convertedFitEntries,
      passedThroughEntries: passedThroughWoaEntries,
      skippedEntries: skippedEntries.length,
      skippedExistingEntries: skippedExistingEntries.length,
      skippedTooShortEntries: skippedTooShortEntries.length,
      totalRecordCount,
      totalGpsPointCount,
      sourceZipBytes: sourceBytes,
      outputZipBytes: outputZipBytes.byteLength,
      outerZipLevel: OUTER_ZIP_LEVEL
    },
    skipped: skippedEntries,
    skippedExisting: skippedExistingEntries,
    skippedTooShort: skippedTooShortEntries,
    timings: {
      parseMs: average(parseSamplesMs),
      buildWoaMs: average(buildSamplesMs),
      buildWoaStepsMs: averageTimingMaps(buildTimingSamples),
      workoutStreamStats: {
        fallbackWorkoutCount: speedFallbackWorkoutCount,
        fallbackRecordCount: speedFallbackRecordCount
      },
      gzipMs: average(gzipSamplesMs),
      zipBuildMs,
      totalMs: totalElapsedMs
    }
  }, [outputZipBytes.buffer]);
}

async function handleZipConversion({
  fileName,
  arrayBuffer,
  prewarmedZipToken = null,
  existingStartTimes = [],
  encodingOptions = {},
  outputMode = "zip",
  parallelFitPoolEnabled = false,
  parallelFitWorkers = null
}) {
  self.postMessage({
    type: "phase",
    phase: "reading-zip"
  });

  let prepared = null;
  if (prewarmedZipToken && preparedZipSources.has(prewarmedZipToken)) {
    prepared = preparedZipSources.get(prewarmedZipToken);
    preparedZipSources.delete(prewarmedZipToken);
  }

  let fitEntries;
  let woaEntries;
  let sourceBytes;
  let unzipMs;
  let entryScanMs;

  if (prepared) {
    fitEntries = prepared.fitEntries;
    woaEntries = prepared.woaEntries;
    sourceBytes = prepared.sourceBytes;
    unzipMs = 0;
    entryScanMs = 0;
    postStartupMetric("unzipSyncMs", 0, {
      sourceBytes,
      reusedPreparedZip: true
    });
    postStartupMetric("entryScanMs", 0, {
      entryCount: fitEntries.length + woaEntries.length,
      fitEntryCount: fitEntries.length,
      woaEntryCount: woaEntries.length,
      reusedPreparedZip: true
    });
    postStartupMetric("zipOpenMs", 0, {
      sourceBytes,
      reusedPreparedZip: true
    });
  } else {
    const zipBytes = new Uint8Array(arrayBuffer);
    sourceBytes = zipBytes.byteLength;
    const unzipStartedAt = nowMs();
    const archive = unzipSync(zipBytes, {
      filter: shouldExtractZipEntry
    });
    unzipMs = nowMs() - unzipStartedAt;
    postStartupMetric("unzipSyncMs", unzipMs, {
      sourceBytes
    });
    const entryScanStartedAt = nowMs();
    const entryNames = Object.keys(archive);
    fitEntries = entryNames
      .filter(isRealFitZipEntry)
      .sort((left, right) => left.localeCompare(right))
      .map((entryName) => ({
        name: entryName,
        bytes: archive[entryName]
      }));
    woaEntries = entryNames
      .filter(isRealWoaZipEntry)
      .sort((left, right) => left.localeCompare(right))
      .map((entryName) => ({
        name: entryName,
        bytes: archive[entryName]
      }));
    entryScanMs = nowMs() - entryScanStartedAt;
    postStartupMetric("entryScanMs", entryScanMs, {
      entryCount: entryNames.length,
      fitEntryCount: fitEntries.length,
      woaEntryCount: woaEntries.length
    });
    postStartupMetric("zipOpenMs", unzipMs + entryScanMs, {
      sourceBytes
    });
  }

  await convertMixedEntriesToWoaZip({
    fileName,
    fitEntries,
    woaEntries,
    existingStartTimes,
    sourceBytes,
    encodingOptions,
    outputMode,
    parallelFitPoolEnabled,
    parallelFitWorkers
  });
}

async function handleFitFilesConversion({
  fileName,
  files = [],
  prewarmedZipTokens = [],
  prewarmedZipFiles = [],
  existingStartTimes = [],
  encodingOptions = {},
  outputMode = "zip",
  parallelFitPoolEnabled = false,
  parallelFitWorkers = null
}) {
  const fitEntries = [];
  const woaEntries = [];
  let sourceBytes = 0;
  let nestedZipCount = 0;
  let nestedUnzipMs = 0;
  let nestedEntryScanMs = 0;
  const preparedTokenQueue = Array.isArray(prewarmedZipTokens) ? [...prewarmedZipTokens] : [];
  const preparedZipFileQueue = Array.isArray(prewarmedZipFiles) ? [...prewarmedZipFiles] : [];

  for (const file of files) {
    if (!file?.name || !file?.arrayBuffer) {
      continue;
    }

    const lowerName = String(file.name).toLowerCase();
    const bytes = new Uint8Array(file.arrayBuffer);
    sourceBytes += Number(bytes.byteLength || 0);

    if (lowerName.endsWith(".fit")) {
      fitEntries.push({
        name: file.name,
        bytes
      });
      continue;
    }

    if (lowerName.endsWith(".zip")) {
      const preparedToken = preparedTokenQueue.shift() || null;
      if (preparedToken && preparedZipSources.has(preparedToken)) {
        const prepared = preparedZipSources.get(preparedToken);
        preparedZipSources.delete(preparedToken);
        sourceBytes += Number(prepared?.sourceBytes || 0) - Number(bytes.byteLength || 0);
        fitEntries.push(...prepared.fitEntries);
        woaEntries.push(...prepared.woaEntries);
        continue;
      }
      nestedZipCount += 1;
      const unzipStartedAt = nowMs();
      const archive = unzipSync(bytes, {
        filter: shouldExtractZipEntry
      });
      nestedUnzipMs += nowMs() - unzipStartedAt;
      const entryScanStartedAt = nowMs();
      const entryNames = Object.keys(archive);

      for (const entryName of entryNames.filter(isRealFitZipEntry)) {
        fitEntries.push({
          name: entryName,
          bytes: archive[entryName]
        });
      }

      for (const entryName of entryNames.filter(isRealWoaZipEntry)) {
        woaEntries.push({
          name: entryName,
          bytes: archive[entryName]
        });
      }
      nestedEntryScanMs += nowMs() - entryScanStartedAt;
    }
  }

  for (const zipFile of preparedZipFileQueue) {
    const preparedToken = preparedTokenQueue.shift() || null;
    if (preparedToken && preparedZipSources.has(preparedToken)) {
      const prepared = preparedZipSources.get(preparedToken);
      preparedZipSources.delete(preparedToken);
      sourceBytes += Number(prepared?.sourceBytes || zipFile?.size || 0);
      fitEntries.push(...prepared.fitEntries);
      woaEntries.push(...prepared.woaEntries);
    }
  }

  if (nestedZipCount > 0) {
    postStartupMetric("unzipSyncMs", nestedUnzipMs, {
      nestedZipCount
    });
    postStartupMetric("entryScanMs", nestedEntryScanMs, {
      nestedZipCount
    });
    postStartupMetric("zipOpenMs", nestedUnzipMs + nestedEntryScanMs, {
      nestedZipCount
    });
  }

  await convertMixedEntriesToWoaZip({
    fileName,
    fitEntries,
    woaEntries,
    existingStartTimes,
    sourceBytes,
    encodingOptions,
    outputMode,
    parallelFitPoolEnabled,
    parallelFitWorkers
  });
}
