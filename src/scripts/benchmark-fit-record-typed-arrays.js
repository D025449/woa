import fs from "node:fs/promises";
import path from "node:path";

import "../config/env.js";

import { parseFitBufferStandard } from "../services/fit-parser-service.js";
import { parseFitBufferFast } from "../services/fit-parser-fast-service.js";
import { extractFitRecordTypedArrays } from "../services/fit-record-typed-array-extractor.js";

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function toRecordTypedArraysFromParsed(parsed) {
  const records = Array.isArray(parsed?.records) ? parsed.records : [];
  const length = records.length;

  const timestampsMs = new Float64Array(length);
  const distancesM = new Float64Array(length);
  const powersW = new Float64Array(length);
  const heartRatesBpm = new Float64Array(length);
  const cadencesRpm = new Float64Array(length);
  const speedsMps = new Float64Array(length);
  const altitudesM = new Float64Array(length);
  const positionLatsDeg = new Float64Array(length);
  const positionLongsDeg = new Float64Array(length);

  for (let index = 0; index < length; index += 1) {
    const record = records[index] || {};
    timestampsMs[index] = record.timestamp instanceof Date ? record.timestamp.getTime() : Number.NaN;
    distancesM[index] = Number.isFinite(record.distance) ? Number(record.distance) : Number.NaN;
    powersW[index] = Number.isFinite(record.power) ? Number(record.power) : Number.NaN;
    heartRatesBpm[index] = Number.isFinite(record.heart_rate) ? Number(record.heart_rate) : Number.NaN;
    cadencesRpm[index] = Number.isFinite(record.cadence) ? Number(record.cadence) : Number.NaN;
    speedsMps[index] = Number.isFinite(record.enhanced_speed)
      ? Number(record.enhanced_speed)
      : (Number.isFinite(record.speed) ? Number(record.speed) : Number.NaN);
    altitudesM[index] = Number.isFinite(record.enhanced_altitude)
      ? Number(record.enhanced_altitude)
      : (Number.isFinite(record.altitude) ? Number(record.altitude) : Number.NaN);
    positionLatsDeg[index] = Number.isFinite(record.position_lat) ? Number(record.position_lat) : Number.NaN;
    positionLongsDeg[index] = Number.isFinite(record.position_long) ? Number(record.position_long) : Number.NaN;
  }

  return {
    recordCount: length,
    timestampsMs,
    distancesM,
    powersW,
    heartRatesBpm,
    cadencesRpm,
    speedsMps,
    altitudesM,
    positionLatsDeg,
    positionLongsDeg
  };
}

function sampleSummary(result) {
  const firstIndex = 0;
  const lastIndex = Math.max(0, result.recordCount - 1);

  return {
    recordCount: result.recordCount,
    firstTimestampMs: result.timestampsMs[firstIndex],
    lastTimestampMs: result.timestampsMs[lastIndex],
    firstDistanceM: result.distancesM[firstIndex],
    lastDistanceM: result.distancesM[lastIndex],
    firstPowerW: result.powersW[firstIndex],
    firstHeartRateBpm: result.heartRatesBpm[firstIndex],
    firstCadenceRpm: result.cadencesRpm[firstIndex],
    firstSpeedMps: result.speedsMps[firstIndex],
    firstAltitudeM: result.altitudesM[firstIndex],
    firstPositionLatDeg: result.positionLatsDeg[firstIndex],
    firstPositionLongDeg: result.positionLongsDeg[firstIndex]
  };
}

async function run() {
  const inputPath = process.argv[2];
  const iterations = parsePositiveInt(process.argv[3], 25);

  if (!inputPath) {
    console.error("Usage: node src/scripts/benchmark-fit-record-typed-arrays.js <fit-file> [iterations]");
    process.exit(1);
  }

  const resolvedPath = path.resolve(inputPath);
  const buffer = await fs.readFile(resolvedPath);

  let standardResult = null;
  let fastResult = null;
  let directResult = null;
  let standardTotalMs = 0;
  let fastTotalMs = 0;
  let directTotalMs = 0;

  console.log("[fit-typed-bench] start", {
    file: resolvedPath,
    bytes: buffer.byteLength,
    iterations
  });

  for (let index = 0; index < iterations; index += 1) {
    const standardStartedAt = performance.now();
    const standardParsed = await parseFitBufferStandard(buffer);
    standardResult = toRecordTypedArraysFromParsed(standardParsed);
    standardTotalMs += performance.now() - standardStartedAt;

    const fastStartedAt = performance.now();
    const fastParsed = await parseFitBufferFast(buffer);
    fastResult = toRecordTypedArraysFromParsed(fastParsed);
    fastTotalMs += performance.now() - fastStartedAt;

    const directStartedAt = performance.now();
    directResult = extractFitRecordTypedArrays(buffer);
    directTotalMs += performance.now() - directStartedAt;
  }

  const standardAvgMs = standardTotalMs / iterations;
  const fastAvgMs = fastTotalMs / iterations;
  const directAvgMs = directTotalMs / iterations;

  console.table([
    {
      variant: "standard-parser-plus-convert",
      avgMs: Number(standardAvgMs.toFixed(3)),
      recordCount: standardResult?.recordCount ?? 0
    },
    {
      variant: "fast-parser-plus-convert",
      avgMs: Number(fastAvgMs.toFixed(3)),
      recordCount: fastResult?.recordCount ?? 0
    },
    {
      variant: "direct-record-typed-arrays",
      avgMs: Number(directAvgMs.toFixed(3)),
      recordCount: directResult?.recordCount ?? 0
    }
  ]);

  console.log("Direct extractor sample:");
  console.table([sampleSummary(directResult)]);
  console.log("Notes:");
  console.log("- timestampsMs are Unix epoch milliseconds.");
  console.log("- position lat/long are converted from FIT semicircles to degrees.");
  console.log("- speed prefers enhanced_speed, altitude prefers enhanced_altitude when present.");
}

run().catch((error) => {
  console.error("[fit-typed-bench] failed", error);
  process.exit(1);
});
