import fs from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { unzipSync, zipSync } from "fflate";

import "../config/env.js";

import { parseFitBufferTyped } from "../services/fit-import-typed-service.js";
import { createWoa1File } from "../public/js/woa-format.js";

const OUTER_ZIP_LEVEL = 0;
const MIN_WORKOUT_RECORD_COUNT = 300;

function parsePositiveNumber(value, fallback) {
  const parsed = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    file: null,
    gzipLevel: 4,
    gpsGzipLevel: null,
    powerStep: 1,
    cadenceStep: 1,
    hrStep: 1,
    altitudeStep: 0.25,
    sampleRateSeconds: 5
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    if (arg === "--file" && next) {
      out.file = next;
      index += 1;
      continue;
    }

    if (arg === "--gzip-level" && next) {
      out.gzipLevel = Math.max(0, Math.min(9, Number.parseInt(next, 10) || 4));
      index += 1;
      continue;
    }

    if (arg === "--gps-gzip-level" && next) {
      out.gpsGzipLevel = Math.max(0, Math.min(9, Number.parseInt(next, 10) || out.gzipLevel));
      index += 1;
      continue;
    }

    if (arg === "--power-step" && next) {
      out.powerStep = Math.max(1, Number.parseInt(next, 10) || 1);
      index += 1;
      continue;
    }

    if (arg === "--cadence-step" && next) {
      out.cadenceStep = Math.max(1, Number.parseInt(next, 10) || 1);
      index += 1;
      continue;
    }

    if (arg === "--hr-step" && next) {
      out.hrStep = Math.max(1, Number.parseInt(next, 10) || 1);
      index += 1;
      continue;
    }

    if (arg === "--altitude-step" && next) {
      out.altitudeStep = parsePositiveNumber(next, 0.25);
      index += 1;
      continue;
    }

    if (arg === "--sample-rate" && next) {
      out.sampleRateSeconds = Math.max(1, Number.parseInt(next, 10) || 5);
      index += 1;
      continue;
    }
  }

  if (!out.file) {
    throw new Error("Missing required --file <zip-file>");
  }

  if (out.gpsGzipLevel == null) {
    out.gpsGzipLevel = out.gzipLevel;
  }

  return out;
}

function nowMs() {
  return performance.now();
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatMs(value) {
  return `${Number(value || 0).toFixed(3)} ms`;
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

function quantizeSeries(sourceArray, recordCount, step, {
  activeThreshold = 1
} = {}) {
  const normalizedStep = parsePositiveNumber(step, 1);
  if (normalizedStep <= activeThreshold || !sourceArray || recordCount <= 0) {
    return {
      values: sourceArray,
      step: normalizedStep,
      quantizedSamples: 0
    };
  }

  const quantizedValues = new Float64Array(recordCount);
  let quantizedSamples = 0;

  for (let index = 0; index < recordCount; index += 1) {
    const value = Number(sourceArray[index]);
    if (!Number.isFinite(value)) {
      quantizedValues[index] = Number.NaN;
      continue;
    }

    const quantized = Math.round(value / normalizedStep) * normalizedStep;
    quantizedValues[index] = quantized;
    if (quantized !== value) {
      quantizedSamples += 1;
    }
  }

  return {
    values: quantizedValues,
    step: normalizedStep,
    quantizedSamples
  };
}

function applySeriesQuantization(parsed, quantizationOptions = {}) {
  const source = parsed?.recordsTyped;
  if (!source || !Number.isFinite(Number(source.recordCount))) {
    return {
      parsed,
      stats: {
        powerStep: 1,
        cadenceStep: 1,
        hrStep: 1,
        altitudeStep: 0.25,
        quantizedPowerSamples: 0,
        quantizedCadenceSamples: 0,
        quantizedHrSamples: 0,
        quantizedAltitudeSamples: 0
      }
    };
  }

  const recordCount = Number(source.recordCount);
  const power = quantizeSeries(source.powersW, recordCount, quantizationOptions.powerStep);
  const cadence = quantizeSeries(source.cadencesRpm, recordCount, quantizationOptions.cadenceStep);
  const heartRate = quantizeSeries(source.heartRatesBpm, recordCount, quantizationOptions.hrStep);
  const altitude = quantizeSeries(source.altitudesM, recordCount, quantizationOptions.altitudeStep, {
    activeThreshold: 0.25
  });

  return {
    parsed: {
      ...parsed,
      recordsTyped: {
        ...source,
        powersW: power.values,
        cadencesRpm: cadence.values,
        heartRatesBpm: heartRate.values,
        altitudesM: altitude.values
      }
    },
    stats: {
      powerStep: power.step,
      cadenceStep: cadence.step,
      hrStep: heartRate.step,
      altitudeStep: altitude.step,
      quantizedPowerSamples: power.quantizedSamples,
      quantizedCadenceSamples: cadence.quantizedSamples,
      quantizedHrSamples: heartRate.quantizedSamples,
      quantizedAltitudeSamples: altitude.quantizedSamples
    }
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

async function run() {
  const options = parseArgs();
  const resolvedPath = path.resolve(options.file);
  const zipBuffer = await fs.readFile(resolvedPath);

  console.log("[fit-woa-zip-bench] start", {
    file: resolvedPath,
    sourceZipBytes: zipBuffer.byteLength,
    gzipLevel: options.gzipLevel,
    gpsGzipLevel: options.gpsGzipLevel,
    powerStep: options.powerStep,
    cadenceStep: options.cadenceStep,
    hrStep: options.hrStep,
    altitudeStep: options.altitudeStep,
    sampleRateSeconds: options.sampleRateSeconds,
    outerZipLevel: OUTER_ZIP_LEVEL
  });

  const zipBytes = new Uint8Array(zipBuffer);
  const startedAt = nowMs();

  const archive = unzipSync(zipBytes);
  const entryNames = Object.keys(archive);
  const fitEntries = entryNames
    .filter(isRealFitZipEntry)
    .sort((left, right) => left.localeCompare(right))
    .map((entryName) => ({
      name: entryName,
      bytes: archive[entryName]
    }));

  const parseSamplesMs = [];
  const buildSamplesMs = [];
  const quantizedPowerSamples = [];
  const quantizedCadenceSamples = [];
  const quantizedHrSamples = [];
  const quantizedAltitudeSamples = [];
  const skippedTooShortEntries = [];
  const outputEntries = [];
  const usedOutputNames = new Set();

  let totalRecordCount = 0;
  let totalGpsPointCount = 0;
  let totalWorkoutRawBytes = 0;
  let totalWorkoutGzipBytes = 0;
  let totalGpsRawBytes = 0;
  let totalGpsGzipBytes = 0;
  let convertedEntries = 0;

  for (const fitEntry of fitEntries) {
    const parseStartedAt = nowMs();
    const parsed = parseFitBufferTyped(fitEntry.bytes);
    parseSamplesMs.push(nowMs() - parseStartedAt);

    const recordCount = Number(parsed?.recordsTyped?.recordCount || 0);
    if (recordCount < MIN_WORKOUT_RECORD_COUNT) {
      skippedTooShortEntries.push({
        entryName: fitEntry.name,
        recordCount
      });
      continue;
    }

    const quantized = applySeriesQuantization(parsed, {
      powerStep: options.powerStep,
      cadenceStep: options.cadenceStep,
      hrStep: options.hrStep,
      altitudeStep: options.altitudeStep
    });
    quantizedPowerSamples.push(Number(quantized.stats.quantizedPowerSamples || 0));
    quantizedCadenceSamples.push(Number(quantized.stats.quantizedCadenceSamples || 0));
    quantizedHrSamples.push(Number(quantized.stats.quantizedHrSamples || 0));
    quantizedAltitudeSamples.push(Number(quantized.stats.quantizedAltitudeSamples || 0));

    const buildStartedAt = nowMs();
    const result = createWoa1File(quantized.parsed, {
      sourceName: fitEntry.name,
      sampleRateSeconds: options.sampleRateSeconds,
      compressWorkoutStream: (bytes, gzipOptions = {}) => gzipSync(bytes, {
        ...gzipOptions,
        level: options.gzipLevel
      }),
      compressGpsTrack: (bytes, gzipOptions = {}) => gzipSync(bytes, {
        ...gzipOptions,
        level: options.gpsGzipLevel
      })
    });
    buildSamplesMs.push(nowMs() - buildStartedAt);

    outputEntries.push({
      name: createUniqueEntryName(fitEntry.name.replace(/\.fit$/i, ".woa1"), usedOutputNames),
      bytes: result.bytes
    });

    const blockBytes = result.meta?.blockBytes || {};
    totalRecordCount += recordCount;
    totalGpsPointCount += Number(result.gpsTrack?.pointCount || 0);
    totalWorkoutRawBytes += Number(blockBytes.workout_stream_raw || 0);
    totalWorkoutGzipBytes += Number(blockBytes.workout_stream_compressed || 0);
    totalGpsRawBytes += Number(blockBytes.gps_track_raw || 0);
    totalGpsGzipBytes += Number(blockBytes.gps_track_compressed || 0);
    convertedEntries += 1;
  }

  const zipBuildStartedAt = nowMs();
  const zipEntries = {};
  for (const entry of outputEntries) {
    zipEntries[entry.name] = [entry.bytes, { level: OUTER_ZIP_LEVEL }];
  }
  const outputZipBytes = zipSync(zipEntries, { level: OUTER_ZIP_LEVEL });
  const zipBuildMs = nowMs() - zipBuildStartedAt;
  const totalElapsedMs = nowMs() - startedAt;

  console.log("[fit-woa-zip-bench] parsed-archive", {
    fitEntriesSeen: fitEntries.length
  });

  console.table([{
    file: path.basename(resolvedPath),
    fitEntriesSeen: fitEntries.length,
    convertedEntries,
    skippedTooShortEntries: skippedTooShortEntries.length,
    totalRecords: totalRecordCount,
    reducedGpsPoints: totalGpsPointCount,
    sourceZipBytes: zipBuffer.byteLength,
    outputZipBytes: outputZipBytes.byteLength,
    workoutRawBytes: totalWorkoutRawBytes,
    workoutGzipBytes: totalWorkoutGzipBytes,
    gpsRawBytes: totalGpsRawBytes,
    gpsGzipBytes: totalGpsGzipBytes,
    powerStep: options.powerStep,
    cadenceStep: options.cadenceStep,
    hrStep: options.hrStep,
    altitudeStep: options.altitudeStep,
    quantizedPowerSamples: quantizedPowerSamples.reduce((sum, value) => sum + value, 0),
    quantizedCadenceSamples: quantizedCadenceSamples.reduce((sum, value) => sum + value, 0),
    quantizedHrSamples: quantizedHrSamples.reduce((sum, value) => sum + value, 0),
    quantizedAltitudeSamples: quantizedAltitudeSamples.reduce((sum, value) => sum + value, 0),
    avgParseMs: Number((parseSamplesMs.reduce((sum, value) => sum + value, 0) / Math.max(1, parseSamplesMs.length)).toFixed(3)),
    avgBuildMs: Number((buildSamplesMs.reduce((sum, value) => sum + value, 0) / Math.max(1, buildSamplesMs.length)).toFixed(3)),
    zipBuildMs: Number(zipBuildMs.toFixed(3)),
    totalMs: Number(totalElapsedMs.toFixed(3))
  }]);

  console.log("Notes:");
  console.log(`- Source ZIP bytes: ${formatBytes(zipBuffer.byteLength)}`);
  console.log(`- Output ZIP bytes: ${formatBytes(outputZipBytes.byteLength)}`);
  console.log(`- Workout stream raw/gzip total: ${formatBytes(totalWorkoutRawBytes)} -> ${formatBytes(totalWorkoutGzipBytes)}`);
  console.log(`- GPS track raw/gzip total: ${formatBytes(totalGpsRawBytes)} -> ${formatBytes(totalGpsGzipBytes)}`);
  console.log(`- Avg parse FIT: ${formatMs(parseSamplesMs.reduce((sum, value) => sum + value, 0) / Math.max(1, parseSamplesMs.length))}`);
  console.log(`- Avg build WOA1: ${formatMs(buildSamplesMs.reduce((sum, value) => sum + value, 0) / Math.max(1, buildSamplesMs.length))}`);
  console.log(`- Build output ZIP: ${formatMs(zipBuildMs)}`);
  console.log(`- Total worker-style time: ${formatMs(totalElapsedMs)}`);
  console.log(`- Quantized power samples total: ${quantizedPowerSamples.reduce((sum, value) => sum + value, 0)}`);
  console.log(`- Quantized cadence samples total: ${quantizedCadenceSamples.reduce((sum, value) => sum + value, 0)}`);
  console.log(`- Quantized heart-rate samples total: ${quantizedHrSamples.reduce((sum, value) => sum + value, 0)}`);
  console.log(`- Altitude quantization step: ${options.altitudeStep} m`);
  console.log(`- Quantized altitude samples total: ${quantizedAltitudeSamples.reduce((sum, value) => sum + value, 0)}`);
  if (skippedTooShortEntries.length > 0) {
    console.log(`- Too-short workouts skipped: ${skippedTooShortEntries.length}`);
  }
}

run().catch((error) => {
  console.error("[fit-woa-zip-bench] failed", error);
  process.exit(1);
});
