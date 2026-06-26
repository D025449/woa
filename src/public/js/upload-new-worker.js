import { parseFitBufferTypedBrowser } from "./fit-import-typed-browser.js";
import { createWoa1File } from "./woa-format.js";
import { gzipSync, unzipSync, zipSync } from "/vendor/fflate/browser.js";

const PER_FILE_GZIP_LEVEL = 4;
const OUTER_ZIP_LEVEL = 0;
const DEFAULT_BENCH_REPEAT_COUNT = 10;
const MIN_WORKOUT_RECORD_COUNT = 300;
const TEXT_DECODER = new TextDecoder();

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

function isTooShortWorkout(parsed) {
  const recordCount = Number(parsed?.recordsTyped?.recordCount || 0);
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
    existingStartTimes = []
  } = event.data || {};

  if (!arrayBuffer && (!Array.isArray(files) || files.length === 0)) {
    return;
  }

  try {
    if (type === "convert-zip-to-woa-zip") {
      await handleZipConversion({ fileName, arrayBuffer, existingStartTimes });
      return;
    }

    if (type === "convert-fit-files-to-woa-zip") {
      await handleFitFilesConversion({ fileName, files, existingStartTimes });
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
      const parsed = parseFitBufferTypedBrowser(arrayBuffer, {
        excludeStartTimes: existingStartTimes
      });
      parseSamplesMs.push(nowMs() - parseStartedAt);
      finalParsed = parsed;

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
          recordCount: Number(parsed?.recordsTyped?.recordCount || 0)
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
      const result = createWoa1File(parsed, {
        sourceName: fileName,
        sampleRateSeconds: 5,
        compressWorkoutStream: (bytes, options = {}) => gzipSync(bytes, options),
        compressGpsTrack: (bytes, options = {}) => gzipSync(bytes, options)
      });
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
      sessionsCount: Array.isArray(finalParsed.sessions) ? finalParsed.sessions.length : 0,
      recordCount: Number(finalParsed.recordsTyped?.recordCount || 0),
      gpsPointCount: finalGpsPointCount,
      timings: {
        repeatCount: normalizedRepeatCount,
        parseMs: average(parseSamplesMs),
        buildWoaMs: average(buildSamplesMs),
        buildWoaStepsMs: averageTimingMaps(buildTimingSamples),
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
  sourceBytes = 0
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

  for (const fitEntry of sortedFitEntries) {
    self.postMessage({
      type: "phase",
      phase: "zip-entry",
      entryName: fitEntry.name,
      processedEntries,
      totalEntries
    });

    try {
      const parseStartedAt = nowMs();
      const parsed = parseFitBufferTypedBrowser(fitEntry.bytes, {
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
          recordCount: Number(parsed?.recordsTyped?.recordCount || 0)
        });
        processedEntries += 1;
        continue;
      }

      const buildStartedAt = nowMs();
      const result = createWoa1File(parsed, {
        sourceName: fitEntry.name,
        sampleRateSeconds: 5,
        compressWorkoutStream: (bytes, options = {}) => gzipSync(bytes, options),
        compressGpsTrack: (bytes, options = {}) => gzipSync(bytes, options)
      });
      buildSamplesMs.push(nowMs() - buildStartedAt);
      buildTimingSamples.push(result.timings || {});
      speedFallbackWorkoutCount += Number(result.stats?.workoutStream?.usesSpeedFallback ? 1 : 0);
      speedFallbackRecordCount += Number(result.stats?.workoutStream?.speedFallbackRecordCount || 0);

      outputEntries.push({
        name: createUniqueEntryName(fitEntry.name.replace(/\.fit$/i, ".woa1"), usedOutputNames),
        bytes: result.bytes
      });
      {
        const acceptedStartTimeKey = buildParsedStartTimeKey(parsed);
        if (acceptedStartTimeKey) {
          dynamicExistingStartTimes.add(acceptedStartTimeKey);
        }
      }
      totalRecordCount += Number(parsed.recordsTyped?.recordCount || 0);
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

    outputEntries.push({
      name: createUniqueEntryName(woaEntry.name, usedOutputNames),
      bytes: woaEntry.bytes
    });
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

async function handleZipConversion({ fileName, arrayBuffer, existingStartTimes = [] }) {
  self.postMessage({
    type: "phase",
    phase: "reading-zip"
  });

  const zipBytes = new Uint8Array(arrayBuffer);
  const archive = unzipSync(zipBytes);
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

  await convertMixedEntriesToWoaZip({
    fileName,
    fitEntries,
    woaEntries,
    existingStartTimes,
    sourceBytes: zipBytes.byteLength
  });
}

async function handleFitFilesConversion({ fileName, files = [], existingStartTimes = [] }) {
  const fitEntries = [];
  const woaEntries = [];
  let sourceBytes = 0;

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
      const archive = unzipSync(bytes);
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
    }
  }

  await convertMixedEntriesToWoaZip({
    fileName,
    fitEntries,
    woaEntries,
    existingStartTimes,
    sourceBytes
  });
}
