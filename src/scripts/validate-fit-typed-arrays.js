import fs from "node:fs/promises";
import path from "node:path";

import "../config/env.js";

import { parseFitBufferFast } from "../services/fit-parser-fast-service.js";
import { extractFitRecordTypedArrays } from "../services/fit-record-typed-array-extractor.js";

function parseToleranceFlag(args, flag, fallback) {
  const index = args.indexOf(flag);
  if (index === -1 || !args[index + 1]) {
    return fallback;
  }
  const parsed = Number(args[index + 1]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toComparableRecords(parsed) {
  const records = Array.isArray(parsed?.records) ? parsed.records : [];
  return records.map((record) => ({
    timestampMs: record.timestamp instanceof Date ? record.timestamp.getTime() : Number.NaN,
    distanceM: Number.isFinite(record.distance) ? Number(record.distance) : Number.NaN,
    powerW: Number.isFinite(record.power) ? Number(record.power) : Number.NaN,
    heartRateBpm: Number.isFinite(record.heart_rate) ? Number(record.heart_rate) : Number.NaN,
    cadenceRpm: Number.isFinite(record.cadence) ? Number(record.cadence) : Number.NaN,
    speedMps: Number.isFinite(record.enhanced_speed)
      ? Number(record.enhanced_speed)
      : (Number.isFinite(record.speed) ? Number(record.speed) : Number.NaN),
    altitudeM: Number.isFinite(record.enhanced_altitude)
      ? Number(record.enhanced_altitude)
      : (Number.isFinite(record.altitude) ? Number(record.altitude) : Number.NaN),
    positionLatDeg: Number.isFinite(record.position_lat) ? Number(record.position_lat) : Number.NaN,
    positionLongDeg: Number.isFinite(record.position_long) ? Number(record.position_long) : Number.NaN
  }));
}

function normalizeNumber(value) {
  return Number.isFinite(value) ? Number(value) : Number.NaN;
}

function compareField(name, expected, actual, tolerance, stats) {
  const bothNaN = Number.isNaN(expected) && Number.isNaN(actual);
  if (bothNaN) {
    stats.equalCount += 1;
    return;
  }

  if (Number.isNaN(expected) !== Number.isNaN(actual)) {
    stats.mismatchCount += 1;
    if (stats.samples.length < 5) {
      stats.samples.push({ field: name, expected, actual, reason: "nan-mismatch" });
    }
    return;
  }

  const delta = Math.abs(expected - actual);
  stats.maxDelta = Math.max(stats.maxDelta, delta);
  if (delta > tolerance) {
    stats.mismatchCount += 1;
    if (stats.samples.length < 5) {
      stats.samples.push({ field: name, expected, actual, delta, tolerance });
    }
    return;
  }

  stats.equalCount += 1;
}

async function run() {
  const args = process.argv.slice(2);
  const inputPath = args[0];

  if (!inputPath) {
    console.error("Usage: node src/scripts/validate-fit-typed-arrays.js <fit-file> [--timestamp-tolerance-ms 0] [--float-tolerance 0.0001]");
    process.exit(1);
  }

  const timestampToleranceMs = parseToleranceFlag(args, "--timestamp-tolerance-ms", 0);
  const floatTolerance = parseToleranceFlag(args, "--float-tolerance", 0.0001);

  const resolvedPath = path.resolve(inputPath);
  const buffer = await fs.readFile(resolvedPath);

  const parsed = await parseFitBufferFast(buffer);
  const expectedRecords = toComparableRecords(parsed);
  const actual = extractFitRecordTypedArrays(buffer);

  if (expectedRecords.length !== actual.recordCount) {
    console.error("[fit-typed-validate] record count mismatch", {
      expected: expectedRecords.length,
      actual: actual.recordCount
    });
    process.exit(1);
  }

  const fieldStats = {
    timestampMs: { equalCount: 0, mismatchCount: 0, maxDelta: 0, samples: [] },
    distanceM: { equalCount: 0, mismatchCount: 0, maxDelta: 0, samples: [] },
    powerW: { equalCount: 0, mismatchCount: 0, maxDelta: 0, samples: [] },
    heartRateBpm: { equalCount: 0, mismatchCount: 0, maxDelta: 0, samples: [] },
    cadenceRpm: { equalCount: 0, mismatchCount: 0, maxDelta: 0, samples: [] },
    speedMps: { equalCount: 0, mismatchCount: 0, maxDelta: 0, samples: [] },
    altitudeM: { equalCount: 0, mismatchCount: 0, maxDelta: 0, samples: [] },
    positionLatDeg: { equalCount: 0, mismatchCount: 0, maxDelta: 0, samples: [] },
    positionLongDeg: { equalCount: 0, mismatchCount: 0, maxDelta: 0, samples: [] }
  };

  for (let index = 0; index < expectedRecords.length; index += 1) {
    const expected = expectedRecords[index];

    compareField("timestampMs", normalizeNumber(expected.timestampMs), normalizeNumber(actual.timestampsMs[index]), timestampToleranceMs, fieldStats.timestampMs);
    compareField("distanceM", normalizeNumber(expected.distanceM), normalizeNumber(actual.distancesM[index]), floatTolerance, fieldStats.distanceM);
    compareField("powerW", normalizeNumber(expected.powerW), normalizeNumber(actual.powersW[index]), floatTolerance, fieldStats.powerW);
    compareField("heartRateBpm", normalizeNumber(expected.heartRateBpm), normalizeNumber(actual.heartRatesBpm[index]), floatTolerance, fieldStats.heartRateBpm);
    compareField("cadenceRpm", normalizeNumber(expected.cadenceRpm), normalizeNumber(actual.cadencesRpm[index]), floatTolerance, fieldStats.cadenceRpm);
    compareField("speedMps", normalizeNumber(expected.speedMps), normalizeNumber(actual.speedsMps[index]), floatTolerance, fieldStats.speedMps);
    compareField("altitudeM", normalizeNumber(expected.altitudeM), normalizeNumber(actual.altitudesM[index]), floatTolerance, fieldStats.altitudeM);
    compareField("positionLatDeg", normalizeNumber(expected.positionLatDeg), normalizeNumber(actual.positionLatsDeg[index]), floatTolerance, fieldStats.positionLatDeg);
    compareField("positionLongDeg", normalizeNumber(expected.positionLongDeg), normalizeNumber(actual.positionLongsDeg[index]), floatTolerance, fieldStats.positionLongDeg);
  }

  const summary = Object.entries(fieldStats).map(([field, stats]) => ({
    field,
    mismatches: stats.mismatchCount,
    maxDelta: Number(stats.maxDelta.toFixed(9))
  }));

  console.table(summary);

  const mismatchingFields = Object.entries(fieldStats).filter(([, stats]) => stats.mismatchCount > 0);
  if (mismatchingFields.length > 0) {
    console.log("Mismatch samples:");
    for (const [field, stats] of mismatchingFields) {
      console.log(field, stats.samples);
    }
    process.exit(1);
  }

  console.log("[fit-typed-validate] all compared fields match within tolerance", {
    file: resolvedPath,
    recordCount: actual.recordCount,
    timestampToleranceMs,
    floatTolerance
  });
}

run().catch((error) => {
  console.error("[fit-typed-validate] failed", error);
  process.exit(1);
});
