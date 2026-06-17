import fs from "node:fs/promises";
import path from "node:path";

import "../config/env.js";

import { parseFitBufferStandard } from "../services/fit-parser-service.js";
import { parseFitBufferFast } from "../services/fit-parser-fast-service.js";
import { parseFitBufferTyped } from "../services/fit-import-typed-service.js";
import { processFitRecords } from "../services/fitService.js";

function getParsedRecordCount(parsed) {
  if (Number.isFinite(Number(parsed?.recordsTyped?.recordCount))) {
    return Number(parsed.recordsTyped.recordCount);
  }
  return Array.isArray(parsed?.records) ? parsed.records.length : 0;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function run() {
  const inputPath = process.argv[2];
  const iterations = parsePositiveInt(process.argv[3], 10);

  if (!inputPath) {
    console.error("Usage: node src/scripts/benchmark-fit-import-path.js <fit-file> [iterations]");
    process.exit(1);
  }

  const resolvedPath = path.resolve(inputPath);
  const buffer = await fs.readFile(resolvedPath);

  console.log("[fit-import-bench] start", {
    file: resolvedPath,
    bytes: buffer.byteLength,
    iterations,
    typedArrayInitialCapacity: process.env.FIT_TYPED_ARRAY_INITIAL_CAPACITY || "1024(default)"
  });

  const variants = [
    { name: "standard", parse: parseFitBufferStandard, supportsImportPath: false },
    { name: "fast", parse: parseFitBufferFast, supportsImportPath: false },
    { name: "typed", parse: parseFitBufferTyped, supportsImportPath: true }
  ];

  const rows = [];

  for (const variant of variants) {
    let parseTotalMs = 0;
    let processTotalMs = 0;
    let totalMs = 0;
    let lastResult = null;
    let lastParsed = null;

    for (let index = 0; index < iterations; index += 1) {
      const totalStartedAt = performance.now();

      const parseStartedAt = performance.now();
      lastParsed = await variant.parse(buffer);
      parseTotalMs += performance.now() - parseStartedAt;

      if (variant.supportsImportPath) {
        const processStartedAt = performance.now();
        lastResult = processFitRecords(lastParsed, {
          computeSegments: false,
          sourceName: path.basename(resolvedPath)
        });
        processTotalMs += performance.now() - processStartedAt;
      } else {
        lastResult = null;
      }

      totalMs += performance.now() - totalStartedAt;
    }

    rows.push({
      variant: variant.name,
      avgParseMs: Number((parseTotalMs / iterations).toFixed(3)),
      avgProcessMs: variant.supportsImportPath
        ? Number((processTotalMs / iterations).toFixed(3))
        : null,
      avgTotalMs: Number((totalMs / iterations).toFixed(3)),
      importPathSupported: variant.supportsImportPath,
      sessions: Array.isArray(lastParsed?.sessions) ? lastParsed.sessions.length : 0,
      records: getParsedRecordCount(lastParsed),
      validGps: !!lastResult?.gps_track?.validGps,
      gpsTrackPoints: Array.isArray(lastResult?.gps_track?.track) ? lastResult.gps_track.track.length : 0,
      workoutLength: Number(lastResult?.workoutObject?.length || 0),
      normalizedPower: Number(lastResult?.workoutObject?.getNormalizedPower?.() || 0)
    });
  }

  console.table(rows);
  console.log("Notes:");
  console.log("- avgParseMs covers FIT decode only.");
  console.log("- avgProcessMs is only populated for the typed parser because the import pipeline now requires typed payloads.");
  console.log("- typed avgProcessMs covers aggregate + gap fill + altitude clean + GPS clean + Workout build.");
  console.log("- segments are disabled in this benchmark to isolate the sync preprocessing path.");
}

run().catch((error) => {
  console.error("[fit-import-bench] failed", error);
  process.exit(1);
});
