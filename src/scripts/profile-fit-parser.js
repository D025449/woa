import fs from "node:fs/promises";
import path from "node:path";

import "../config/env.js";

import { parseFitBufferTyped } from "../services/fit-import-typed-service.js";
import { parseFitBufferStandard } from "../services/fit-parser-service.js";
import { parseFitBufferFast } from "../services/fit-parser-fast-service.js";

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function formatMs(ms) {
  return `${ms.toFixed(1)} ms`;
}

async function main() {
  const inputPath = process.argv[2];
  const iterations = parsePositiveInt(process.argv[3], 25);
  const requestedVariant = String(process.argv[4] || "standard").trim().toLowerCase();
  const parserVariant = requestedVariant === "fast" || requestedVariant === "typed"
    ? requestedVariant
    : "standard";
  const parse = parserVariant === "fast"
    ? parseFitBufferFast
    : (parserVariant === "typed" ? parseFitBufferTyped : parseFitBufferStandard);

  if (!inputPath) {
    console.error("Usage: node src/scripts/profile-fit-parser.js <fit-file> [iterations] [standard|fast|typed]");
    process.exit(1);
  }

  const resolvedPath = path.resolve(inputPath);
  const buffer = await fs.readFile(resolvedPath);
  const samples = [];
  let lastParsed = null;

  console.log("[fit-profile] start", {
    file: resolvedPath,
    bytes: buffer.byteLength,
    iterations,
    parserVariant
  });

  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    lastParsed = await parse(buffer);
    samples.push(performance.now() - startedAt);
  }

  const totalMs = samples.reduce((sum, ms) => sum + ms, 0);
  const minMs = Math.min(...samples);
  const maxMs = Math.max(...samples);
  const avgMs = totalMs / samples.length;
  const sorted = [...samples].sort((left, right) => left - right);
  const medianMs = sorted[Math.floor(sorted.length / 2)];

  console.log("[fit-profile] result", {
    file: resolvedPath,
    iterations,
    parserVariant,
    totalMs: Number(totalMs.toFixed(1)),
    avgMs: Number(avgMs.toFixed(1)),
    medianMs: Number(medianMs.toFixed(1)),
    minMs: Number(minMs.toFixed(1)),
    maxMs: Number(maxMs.toFixed(1)),
    sessions: Array.isArray(lastParsed?.sessions) ? lastParsed.sessions.length : 0,
    records: Array.isArray(lastParsed?.records) ? lastParsed.records.length : 0
  });

  console.log("");
  console.log("CPU profile command example:");
  console.log(`node --cpu-prof --cpu-prof-name fit-parser-${parserVariant}.cpuprofile src/scripts/profile-fit-parser.js ${JSON.stringify(resolvedPath)} ${iterations} ${parserVariant}`);
  console.log("");
  console.log(`Average parse time: ${formatMs(avgMs)}`);
}

main().catch((error) => {
  console.error("[fit-profile] failed", error);
  process.exit(1);
});
