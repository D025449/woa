import fs from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";

import "../config/env.js";

import { parseFitBufferTyped } from "../services/fit-import-typed-service.js";
import { decodeWoa1Buffer } from "../services/woa1Service.js";
import { createWoa1File } from "../public/js/woa-format.js";

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

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
    sampleRateSeconds: 5,
    repeats: 1,
    decode: true
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

    if (arg === "--repeats" && next) {
      out.repeats = parsePositiveInt(next, 1);
      index += 1;
      continue;
    }

    if (arg === "--no-decode") {
      out.decode = false;
    }
  }

  if (!out.file) {
    throw new Error("Missing required --file <fit-file>");
  }

  if (out.gpsGzipLevel == null) {
    out.gpsGzipLevel = out.gzipLevel;
  }

  return out;
}

function nowMs() {
  return performance.now();
}

function average(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatMs(value) {
  return `${Number(value || 0).toFixed(3)} ms`;
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

async function run() {
  const options = parseArgs();
  const resolvedPath = path.resolve(options.file);
  const fitBuffer = await fs.readFile(resolvedPath);

  const parseSamplesMs = [];
  const encodeSamplesMs = [];
  const decodeSamplesMs = [];
  const quantizedPowerSamples = [];
  const quantizedCadenceSamples = [];
  const quantizedHrSamples = [];
  const quantizedAltitudeSamples = [];
  let finalParsed = null;
  let finalWoa = null;
  let finalDecoded = null;
  let finalQuantizationStats = {
    powerStep: options.powerStep,
    cadenceStep: options.cadenceStep,
    hrStep: options.hrStep,
    altitudeStep: options.altitudeStep,
    quantizedPowerSamples: 0,
    quantizedCadenceSamples: 0,
    quantizedHrSamples: 0,
    quantizedAltitudeSamples: 0
  };

  for (let iteration = 0; iteration < options.repeats; iteration += 1) {
    const parseStartedAt = nowMs();
    const parsed = parseFitBufferTyped(fitBuffer);
    parseSamplesMs.push(nowMs() - parseStartedAt);
    const quantized = applySeriesQuantization(parsed, {
      powerStep: options.powerStep,
      cadenceStep: options.cadenceStep,
      hrStep: options.hrStep,
      altitudeStep: options.altitudeStep
    });
    finalParsed = quantized.parsed;
    finalQuantizationStats = quantized.stats;
    quantizedPowerSamples.push(Number(quantized.stats.quantizedPowerSamples || 0));
    quantizedCadenceSamples.push(Number(quantized.stats.quantizedCadenceSamples || 0));
    quantizedHrSamples.push(Number(quantized.stats.quantizedHrSamples || 0));
    quantizedAltitudeSamples.push(Number(quantized.stats.quantizedAltitudeSamples || 0));

    const encodeStartedAt = nowMs();
    const woa = createWoa1File(quantized.parsed, {
      sourceName: path.basename(resolvedPath),
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
    encodeSamplesMs.push(nowMs() - encodeStartedAt);
    finalWoa = woa;

    if (options.decode) {
      const decodeStartedAt = nowMs();
      finalDecoded = await decodeWoa1Buffer(woa.bytes);
      decodeSamplesMs.push(nowMs() - decodeStartedAt);
    }
  }

  const meta = finalWoa?.meta || {};
  const blockBytes = meta.blockBytes || {};
  const blockStats = meta.blockStats?.workout_stream || {};
  const decodedRecordCount = Number(finalDecoded?.recordsTyped?.recordCount || 0);
  const decodedGpsPointCount = Number(finalDecoded?.gpsTrack?.pointCount || 0);

  console.log("[fit-woa-bench] start", {
    file: resolvedPath,
    fitBytes: fitBuffer.byteLength,
    gzipLevel: options.gzipLevel,
    gpsGzipLevel: options.gpsGzipLevel,
    powerStep: options.powerStep,
    cadenceStep: options.cadenceStep,
    hrStep: options.hrStep,
    altitudeStep: options.altitudeStep,
    sampleRateSeconds: options.sampleRateSeconds,
    repeats: options.repeats,
    decode: options.decode
  });

  console.table([{
    file: path.basename(resolvedPath),
    sessions: Array.isArray(finalParsed?.sessions) ? finalParsed.sessions.length : 0,
    records: Number(finalParsed?.recordsTyped?.recordCount || 0),
    reducedGpsPoints: Number(finalWoa?.gpsTrack?.pointCount || 0),
    fitBytes: fitBuffer.byteLength,
    woaBytes: Number(finalWoa?.bytes?.byteLength || 0),
    workoutRawBytes: Number(blockBytes.workout_stream_raw || 0),
    workoutGzipBytes: Number(blockBytes.workout_stream_compressed || 0),
    gpsRawBytes: Number(blockBytes.gps_track_raw || 0),
    gpsGzipBytes: Number(blockBytes.gps_track_compressed || 0),
    powerStep: Number(finalQuantizationStats.powerStep || 1),
    cadenceStep: Number(finalQuantizationStats.cadenceStep || 1),
    hrStep: Number(finalQuantizationStats.hrStep || 1),
    altitudeStep: Number(finalQuantizationStats.altitudeStep || 0.25),
    quantizedPowerSamples: Number(average(quantizedPowerSamples).toFixed(0)),
    quantizedCadenceSamples: Number(average(quantizedCadenceSamples).toFixed(0)),
    quantizedHrSamples: Number(average(quantizedHrSamples).toFixed(0)),
    quantizedAltitudeSamples: Number(average(quantizedAltitudeSamples).toFixed(0)),
    speedFallbackWorkouts: Number(blockStats.usesSpeedFallback ? 1 : 0),
    speedFallbackRecords: Number(blockStats.speedFallbackRecordCount || 0),
    avgParseMs: Number(average(parseSamplesMs).toFixed(3)),
    avgEncodeMs: Number(average(encodeSamplesMs).toFixed(3)),
    avgDecodeMs: Number(average(decodeSamplesMs).toFixed(3)),
    gzipLevel: options.gzipLevel,
    gpsGzipLevel: options.gpsGzipLevel
  }]);

  console.log("Notes:");
  console.log(`- FIT source bytes: ${formatBytes(fitBuffer.byteLength)}`);
  console.log(`- WOA1 bytes: ${formatBytes(Number(finalWoa?.bytes?.byteLength || 0))}`);
  console.log(`- Workout stream raw/gzip: ${formatBytes(Number(blockBytes.workout_stream_raw || 0))} -> ${formatBytes(Number(blockBytes.workout_stream_compressed || 0))}`);
  console.log(`- GPS track raw/gzip: ${formatBytes(Number(blockBytes.gps_track_raw || 0))} -> ${formatBytes(Number(blockBytes.gps_track_compressed || 0))}`);
  console.log(`- Avg parse FIT: ${formatMs(average(parseSamplesMs))}`);
  console.log(`- Avg encode WOA1: ${formatMs(average(encodeSamplesMs))}`);
  console.log(`- Power quantization step: ${Number(finalQuantizationStats.powerStep || 1)} W`);
  console.log(`- Quantized power samples (avg): ${Number(average(quantizedPowerSamples).toFixed(0))}`);
  console.log(`- Cadence quantization step: ${Number(finalQuantizationStats.cadenceStep || 1)} rpm`);
  console.log(`- Quantized cadence samples (avg): ${Number(average(quantizedCadenceSamples).toFixed(0))}`);
  console.log(`- Heart rate quantization step: ${Number(finalQuantizationStats.hrStep || 1)} bpm`);
  console.log(`- Quantized heart rate samples (avg): ${Number(average(quantizedHrSamples).toFixed(0))}`);
  console.log(`- Altitude quantization step: ${Number(finalQuantizationStats.altitudeStep || 0.25)} m`);
  console.log(`- Quantized altitude samples (avg): ${Number(average(quantizedAltitudeSamples).toFixed(0))}`);
  if (options.decode) {
    console.log(`- Avg decode WOA1: ${formatMs(average(decodeSamplesMs))}`);
    console.log(`- Decoded records / GPS points: ${decodedRecordCount} / ${decodedGpsPointCount}`);
  }
  if (Number(blockStats.usesSpeedFallback ? 1 : 0) > 0) {
    console.log(`- Speed fallback active for ${Number(blockStats.speedFallbackRecordCount || 0)} records in this workout.`);
  } else {
    console.log("- Speed fallback inactive for this workout.");
  }
}

run().catch((error) => {
  console.error("[fit-woa-bench] failed", error);
  process.exit(1);
});
