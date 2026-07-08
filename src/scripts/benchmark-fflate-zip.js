import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { gzipSync, unzipSync } from "fflate";

import { FIT } from "../../vendor/fit-file-parser-fast/dist/fit.js";
import { parseFitBufferTyped } from "../services/fit-import-typed-service.js";
import { createWoa1File } from "../public/js/woa-format.js";
import { encodeWoaTransportContainer } from "../public/js/woa-transport-container.js";

const GARMIN_TIME_OFFSET_MS = 631065600000;
const SEMICIRCLES_TO_DEGREES = 180 / 0x80000000;
const MICRO_DEGREES = 1000000;
const DELTA_BLOCK_SIZE = 128;
const SESSION_BLOCK_VERSION = 1;
const SESSION_TIME_SCALE = 100;
const SESSION_DISTANCE_SCALE = 10;
const SESSION_ASCENT_SCALE = 10;
const SESSION_SPEED_SCALE = 100;
const SESSION_COORD_SCALE = 1e7;
const DEFAULT_STREAM_CODEC = "gzip";
const DEFAULT_GPS_TRACK_CODEC = "gzip";
const COMPACT_SENTINELS = {
  uint8: 0xff,
  uint16: 0xffff,
  uint32: 0xffffffff,
  int16: -0x8000,
  int32: -0x80000000,
};
const SESSION_SPEC = [
  { key: "timestamp", type: "time" },
  { key: "start_time", type: "time" },
  { key: "total_elapsed_time", type: "scaled-uint32", scale: SESSION_TIME_SCALE },
  { key: "total_timer_time", type: "scaled-uint32", scale: SESSION_TIME_SCALE },
  { key: "total_distance", type: "scaled-uint32", scale: SESSION_DISTANCE_SCALE },
  { key: "total_cycles", type: "uint32" },
  { key: "total_work", type: "uint32" },
  { key: "total_calories", type: "uint32" },
  { key: "total_ascent", type: "scaled-uint32", scale: SESSION_ASCENT_SCALE },
  { key: "total_descent", type: "scaled-uint32", scale: SESSION_ASCENT_SCALE },
  { key: "avg_speed", type: "scaled-uint16", scale: SESSION_SPEED_SCALE },
  { key: "avg_power", type: "uint16" },
  { key: "avg_heart_rate", type: "uint8" },
  { key: "avg_cadence", type: "uint8" },
  { key: "normalized_power", type: "uint16" },
  { key: "max_speed", type: "scaled-uint16", scale: SESSION_SPEED_SCALE },
  { key: "max_power", type: "uint16" },
  { key: "max_heart_rate", type: "uint8" },
  { key: "max_cadence", type: "uint8" },
  { key: "nec_lat", type: "coord" },
  { key: "nec_long", type: "coord" },
  { key: "swc_lat", type: "coord" },
  { key: "swc_long", type: "coord" },
  { key: "woa_manual_gps", type: "bool" },
];

function parseArgs(argv) {
  const options = {
    file: null,
    repeats: 5,
    writeOutput: null,
    gzipLevel: 4,
    variant: "both",
    powerStep: 2,
    cadenceStep: 2,
    hrStep: 2,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--file") options.file = argv[++index];
    else if (argument === "--repeats") options.repeats = Number(argv[++index]);
    else if (argument === "--write-output") options.writeOutput = argv[++index];
    else if (argument === "--gzip-level") options.gzipLevel = Number(argv[++index]);
    else if (argument === "--variant") options.variant = argv[++index];
    else if (argument === "--power-step") options.powerStep = Number(argv[++index]);
    else if (argument === "--cadence-step") options.cadenceStep = Number(argv[++index]);
    else if (argument === "--hr-step") options.hrStep = Number(argv[++index]);
    else if (!argument.startsWith("-") && !options.file) options.file = argument;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.file) throw new Error("Missing ZIP path. Use --file <archive.zip>.");
  if (!Number.isInteger(options.repeats) || options.repeats < 1) {
    throw new Error("--repeats must be a positive integer.");
  }
  if (!Number.isInteger(options.gzipLevel) || options.gzipLevel < 0 || options.gzipLevel > 9) {
    throw new Error("--gzip-level must be an integer between 0 and 9.");
  }
  if (!["node64", "compact", "both"].includes(options.variant)) {
    throw new Error("--variant must be one of: node64, compact, both.");
  }
  if (!Number.isInteger(options.powerStep) || options.powerStep < 1) {
    throw new Error("--power-step must be a positive integer.");
  }
  if (!Number.isInteger(options.cadenceStep) || options.cadenceStep < 1) {
    throw new Error("--cadence-step must be a positive integer.");
  }
  if (!Number.isInteger(options.hrStep) || options.hrStep < 1) {
    throw new Error("--hr-step must be a positive integer.");
  }
  return options;
}

function formatMs(value) {
  return value.toFixed(2);
}

function createSeriesAnalysis() {
  return {
    validCount: 0,
    uniqueCount: 0,
    repeatCount: 0,
    zeroDeltaCount: 0,
    deltaAbsLe1Count: 0,
    deltaAbsLe2Count: 0,
    deltaAbsLe4Count: 0,
  };
}

function createByteDictionaryAnalysis() {
  return {
    totalCount: 0,
    counts: new Uint32Array(256),
  };
}

function createRunLengthAnalysis() {
  return {
    runCount: 0,
    totalCount: 0,
    repeatedValueCount: 0,
    repeatedRunCount: 0,
    maxRunLength: 0,
    runsGe2: 0,
    runsGe3: 0,
    runsGe4: 0,
    runsGe8: 0,
    encodedBytesValueCount: 0,
    encodedBytesRunCount: 0,
  };
}

function createNonNegativeDeltaAnalysis() {
  return {
    deltaCount: 0,
    zeroCount: 0,
    le1Count: 0,
    le2Count: 0,
    le4Count: 0,
    le8Count: 0,
    le16Count: 0,
    maxDelta: 0,
  };
}

function createSignedDeltaAnalysis() {
  return {
    deltaCount: 0,
    zeroCount: 0,
    absLe1Count: 0,
    absLe2Count: 0,
    absLe4Count: 0,
    absLe8Count: 0,
    absLe16Count: 0,
    minDelta: Infinity,
    maxDelta: -Infinity,
  };
}

function analyzeCompactSeries(values, sentinel) {
  const unique = new Set();
  const stats = createSeriesAnalysis();
  let prev = null;
  let hasPrev = false;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === sentinel) continue;
    stats.validCount += 1;
    unique.add(value);
    if (hasPrev) {
      const delta = value - prev;
      const absDelta = Math.abs(delta);
      if (delta === 0) {
        stats.repeatCount += 1;
        stats.zeroDeltaCount += 1;
      }
      if (absDelta <= 1) stats.deltaAbsLe1Count += 1;
      if (absDelta <= 2) stats.deltaAbsLe2Count += 1;
      if (absDelta <= 4) stats.deltaAbsLe4Count += 1;
    }
    prev = value;
    hasPrev = true;
  }
  stats.uniqueCount = unique.size;
  return stats;
}

function analyzeNonNegativeDeltas(values, sentinel) {
  const stats = createNonNegativeDeltaAnalysis();
  let prev = null;
  let hasPrev = false;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === sentinel) continue;
    if (hasPrev) {
      const delta = value - prev;
      if (delta >= 0) {
        stats.deltaCount += 1;
        if (delta === 0) stats.zeroCount += 1;
        if (delta <= 1) stats.le1Count += 1;
        if (delta <= 2) stats.le2Count += 1;
        if (delta <= 4) stats.le4Count += 1;
        if (delta <= 8) stats.le8Count += 1;
        if (delta <= 16) stats.le16Count += 1;
        if (delta > stats.maxDelta) stats.maxDelta = delta;
      }
    }
    prev = value;
    hasPrev = true;
  }
  return stats;
}

function analyzeSignedDeltas(values, sentinel) {
  const stats = createSignedDeltaAnalysis();
  let prev = null;
  let hasPrev = false;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === sentinel) continue;
    if (hasPrev) {
      const delta = value - prev;
      stats.deltaCount += 1;
      if (delta === 0) stats.zeroCount += 1;
      const absDelta = Math.abs(delta);
      if (absDelta <= 1) stats.absLe1Count += 1;
      if (absDelta <= 2) stats.absLe2Count += 1;
      if (absDelta <= 4) stats.absLe4Count += 1;
      if (absDelta <= 8) stats.absLe8Count += 1;
      if (absDelta <= 16) stats.absLe16Count += 1;
      if (delta < stats.minDelta) stats.minDelta = delta;
      if (delta > stats.maxDelta) stats.maxDelta = delta;
    }
    prev = value;
    hasPrev = true;
  }
  if (!Number.isFinite(stats.minDelta)) stats.minDelta = 0;
  if (!Number.isFinite(stats.maxDelta)) stats.maxDelta = 0;
  return stats;
}

function mergeSeriesAnalysis(target, partial) {
  target.validCount += partial.validCount;
  target.uniqueCount += partial.uniqueCount;
  target.repeatCount += partial.repeatCount;
  target.zeroDeltaCount += partial.zeroDeltaCount;
  target.deltaAbsLe1Count += partial.deltaAbsLe1Count;
  target.deltaAbsLe2Count += partial.deltaAbsLe2Count;
  target.deltaAbsLe4Count += partial.deltaAbsLe4Count;
}

function mergeNonNegativeDeltaAnalysis(target, partial) {
  target.deltaCount += partial.deltaCount;
  target.zeroCount += partial.zeroCount;
  target.le1Count += partial.le1Count;
  target.le2Count += partial.le2Count;
  target.le4Count += partial.le4Count;
  target.le8Count += partial.le8Count;
  target.le16Count += partial.le16Count;
  if (partial.maxDelta > target.maxDelta) target.maxDelta = partial.maxDelta;
}

function mergeSignedDeltaAnalysis(target, partial) {
  target.deltaCount += partial.deltaCount;
  target.zeroCount += partial.zeroCount;
  target.absLe1Count += partial.absLe1Count;
  target.absLe2Count += partial.absLe2Count;
  target.absLe4Count += partial.absLe4Count;
  target.absLe8Count += partial.absLe8Count;
  target.absLe16Count += partial.absLe16Count;
  if (partial.minDelta < target.minDelta) target.minDelta = partial.minDelta;
  if (partial.maxDelta > target.maxDelta) target.maxDelta = partial.maxDelta;
}

function mergeInt8DeltaFitAnalysis(target, partial) {
  target.deltaCount += partial.deltaCount;
  target.int8FitCount += partial.int8FitCount;
  target.escapeCount += partial.escapeCount;
  target.zeroCount += partial.zeroCount;
  if (partial.minDelta < target.minDelta) target.minDelta = partial.minDelta;
  if (partial.maxDelta > target.maxDelta) target.maxDelta = partial.maxDelta;
}

function formatSeriesAnalysis(name, stats) {
  if (!stats.validCount) return `${name}(n:0)`;
  const transitions = Math.max(0, stats.validCount - 1);
  const repeatPct = transitions > 0 ? (stats.repeatCount * 100) / transitions : 0;
  const d1Pct = transitions > 0 ? (stats.deltaAbsLe1Count * 100) / transitions : 0;
  const d2Pct = transitions > 0 ? (stats.deltaAbsLe2Count * 100) / transitions : 0;
  const d4Pct = transitions > 0 ? (stats.deltaAbsLe4Count * 100) / transitions : 0;
  return (
    `${name}(n:${stats.validCount},u:${stats.uniqueCount},` +
    `rep:${repeatPct.toFixed(1)}%,d1:${d1Pct.toFixed(1)}%,d2:${d2Pct.toFixed(1)}%,d4:${d4Pct.toFixed(1)}%)`
  );
}

function formatNonNegativeDeltaAnalysis(name, stats) {
  if (!stats.deltaCount) return `${name}(n:0)`;
  const pct = (count) => ((count * 100) / stats.deltaCount).toFixed(1);
  return (
    `${name}(n:${stats.deltaCount},z:${pct(stats.zeroCount)}%,` +
    `d1:${pct(stats.le1Count)}%,d2:${pct(stats.le2Count)}%,` +
    `d4:${pct(stats.le4Count)}%,d8:${pct(stats.le8Count)}%,` +
    `d16:${pct(stats.le16Count)}%,max:${stats.maxDelta})`
  );
}

function formatSignedDeltaAnalysis(name, stats) {
  if (!stats.deltaCount) return `${name}(n:0)`;
  const pct = (count) => ((count * 100) / stats.deltaCount).toFixed(1);
  return (
    `${name}(n:${stats.deltaCount},z:${pct(stats.zeroCount)}%,` +
    `a1:${pct(stats.absLe1Count)}%,a2:${pct(stats.absLe2Count)}%,` +
    `a4:${pct(stats.absLe4Count)}%,a8:${pct(stats.absLe8Count)}%,` +
    `a16:${pct(stats.absLe16Count)}%,min:${stats.minDelta},max:${stats.maxDelta})`
  );
}

function mergeByteDictionaryAnalysis(target, values, sentinel) {
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === sentinel) continue;
    target.totalCount += 1;
    target.counts[value] += 1;
  }
}

function formatByteDictionaryAnalysis(name, stats) {
  const totalCount = Number(stats?.totalCount || 0);
  if (!totalCount) return `${name}Dict(n:0)`;

  const entries = [];
  for (let value = 0; value < 256; value += 1) {
    const count = Number(stats.counts?.[value] || 0);
    if (count > 0) entries.push({ value, count });
  }
  entries.sort((a, b) => b.count - a.count);

  const uniqueCount = entries.length;
  const bitsPerIndex = uniqueCount <= 1 ? 0 : Math.ceil(Math.log2(uniqueCount));
  const rawBytes = totalCount;
  const dictBytes = uniqueCount;
  const bitpackedBytes = bitsPerIndex > 0 ? Math.ceil((totalCount * bitsPerIndex) / 8) : 0;
  const totalDictionaryBytes = dictBytes + bitpackedBytes;
  const savePct = rawBytes > 0 ? ((rawBytes - totalDictionaryBytes) * 100) / rawBytes : 0;
  const topCoverageCount = entries.slice(0, 8).reduce((sum, entry) => sum + entry.count, 0);
  const topCoveragePct = totalCount > 0 ? (topCoverageCount * 100) / totalCount : 0;
  const topValues = entries
    .slice(0, 8)
    .map((entry) => `${entry.value}:${((entry.count * 100) / totalCount).toFixed(1)}%`)
    .join("|");

  return (
    `${name}Dict(n:${totalCount},u:${uniqueCount},bits:${bitsPerIndex},` +
    `raw:${(rawBytes / 1024 / 1024).toFixed(2)}MiB,` +
    `bitpack:${(bitpackedBytes / 1024 / 1024).toFixed(2)}MiB,` +
    `dict:${(dictBytes / 1024 / 1024).toFixed(4)}MiB,` +
    `total:${(totalDictionaryBytes / 1024 / 1024).toFixed(2)}MiB,` +
    `save:${savePct.toFixed(1)}%,top8:${topCoveragePct.toFixed(1)}%,vals:${topValues})`
  );
}

function mergeRunLengthAnalysis(target, values, sentinel) {
  let currentValue = null;
  let currentRunLength = 0;
  let hasRun = false;

  function flushRun() {
    if (!hasRun || currentRunLength <= 0) return;
    target.runCount += 1;
    target.totalCount += currentRunLength;
    if (currentRunLength > target.maxRunLength) target.maxRunLength = currentRunLength;
    if (currentRunLength >= 2) {
      target.repeatedRunCount += 1;
      target.repeatedValueCount += currentRunLength;
      target.runsGe2 += 1;
    }
    if (currentRunLength >= 3) target.runsGe3 += 1;
    if (currentRunLength >= 4) target.runsGe4 += 1;
    if (currentRunLength >= 8) target.runsGe8 += 1;

    let remaining = currentRunLength;
    while (remaining > 0) {
      const chunkLength = Math.min(remaining, 255);
      target.encodedBytesValueCount += 1;
      target.encodedBytesRunCount += 1;
      remaining -= chunkLength;
    }
  }

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === sentinel) {
      flushRun();
      currentValue = null;
      currentRunLength = 0;
      hasRun = false;
      continue;
    }
    if (!hasRun) {
      currentValue = value;
      currentRunLength = 1;
      hasRun = true;
      continue;
    }
    if (value === currentValue) {
      currentRunLength += 1;
      continue;
    }
    flushRun();
    currentValue = value;
    currentRunLength = 1;
    hasRun = true;
  }

  flushRun();
}

function formatRunLengthAnalysis(name, stats) {
  const totalCount = Number(stats?.totalCount || 0);
  if (!totalCount) return `${name}Rle(n:0)`;

  const repeatedPct = (stats.repeatedValueCount * 100) / totalCount;
  const avgRun = stats.runCount > 0 ? totalCount / stats.runCount : 0;
  const pctRuns = (count) => stats.runCount > 0 ? ((count * 100) / stats.runCount).toFixed(1) : "0.0";
  const encodedBytes = stats.encodedBytesValueCount + stats.encodedBytesRunCount;
  const savePct = totalCount > 0 ? ((totalCount - encodedBytes) * 100) / totalCount : 0;

  return (
    `${name}Rle(n:${totalCount},runs:${stats.runCount},avg:${avgRun.toFixed(2)},` +
    `repVals:${repeatedPct.toFixed(1)}%,r2:${pctRuns(stats.runsGe2)}%,r3:${pctRuns(stats.runsGe3)}%,` +
    `r4:${pctRuns(stats.runsGe4)}%,r8:${pctRuns(stats.runsGe8)}%,max:${stats.maxRunLength},` +
    `bytes:${(encodedBytes / 1024 / 1024).toFixed(2)}MiB,save:${savePct.toFixed(1)}%)`
  );
}

function buildUint8RunLengthPayload(values, sentinel) {
  const chunks = [];
  let totalBytes = 0;
  let currentValue = null;
  let currentRunLength = 0;
  let hasRun = false;

  function pushRun(value, length) {
    let remaining = length;
    while (remaining > 0) {
      const chunkLength = Math.min(remaining, 255);
      const chunk = new Uint8Array(2);
      chunk[0] = value;
      chunk[1] = chunkLength;
      chunks.push(chunk);
      totalBytes += 2;
      remaining -= chunkLength;
    }
  }

  function flushRun() {
    if (!hasRun || currentRunLength <= 0) return;
    pushRun(currentValue, currentRunLength);
  }

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === sentinel) {
      flushRun();
      hasRun = false;
      currentValue = null;
      currentRunLength = 0;
      continue;
    }
    if (!hasRun) {
      hasRun = true;
      currentValue = value;
      currentRunLength = 1;
      continue;
    }
    if (value === currentValue) {
      currentRunLength += 1;
      continue;
    }
    flushRun();
    currentValue = value;
    currentRunLength = 1;
    hasRun = true;
  }
  flushRun();

  const payload = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    payload.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return payload;
}

function analyzeDistanceDeltasForScale(values, sentinel, divisor, int8Escape = -128) {
  let deltaCount = 0;
  let int8FitCount = 0;
  let escapeCount = 0;
  let zeroCount = 0;
  let minDelta = Infinity;
  let maxDelta = -Infinity;
  let prev = null;
  let hasPrev = false;

  for (let index = 0; index < values.length; index += 1) {
    const raw = values[index];
    if (raw === sentinel) continue;
    const scaled = Math.round(raw / divisor);
    if (hasPrev) {
      const delta = scaled - prev;
      deltaCount += 1;
      if (delta === 0) zeroCount += 1;
      if (delta >= int8Escape + 1 && delta <= 127) {
        int8FitCount += 1;
      } else {
        escapeCount += 1;
      }
      if (delta < minDelta) minDelta = delta;
      if (delta > maxDelta) maxDelta = delta;
    }
    prev = scaled;
    hasPrev = true;
  }

  return {
    deltaCount,
    int8FitCount,
    escapeCount,
    zeroCount,
    minDelta: Number.isFinite(minDelta) ? minDelta : 0,
    maxDelta: Number.isFinite(maxDelta) ? maxDelta : 0,
  };
}

function formatInt8DeltaFitAnalysis(name, stats) {
  if (!stats.deltaCount) return `${name}(n:0)`;
  const pct = (count) => ((count * 100) / stats.deltaCount).toFixed(1);
  return (
    `${name}(n:${stats.deltaCount},fit:${pct(stats.int8FitCount)}%,` +
    `esc:${pct(stats.escapeCount)}%,z:${pct(stats.zeroCount)}%,` +
    `min:${stats.minDelta},max:${stats.maxDelta})`
  );
}

function createUint8EscapeDeltaAnalysis() {
  return {
    deltaCount: 0,
    directFitCount: 0,
    escapeCount: 0,
    markerCollisionCount: 0,
    negativeCount: 0,
    gt255Count: 0,
    zeroCount: 0,
    minDelta: Infinity,
    maxDelta: -Infinity,
  };
}

function analyzeUint8EscapeDeltas(values, sentinel, divisor, escapeValue = 255) {
  const stats = createUint8EscapeDeltaAnalysis();
  let prev = null;
  let hasPrev = false;

  for (let index = 0; index < values.length; index += 1) {
    const raw = values[index];
    if (raw === sentinel) continue;
    const scaled = Math.round(raw / divisor);
    if (hasPrev) {
      const delta = scaled - prev;
      stats.deltaCount += 1;
      if (delta === 0) stats.zeroCount += 1;
      if (delta < stats.minDelta) stats.minDelta = delta;
      if (delta > stats.maxDelta) stats.maxDelta = delta;

      if (delta >= 0 && delta < escapeValue) {
        stats.directFitCount += 1;
      } else {
        stats.escapeCount += 1;
        if (delta < 0) stats.negativeCount += 1;
        else if (delta === escapeValue) stats.markerCollisionCount += 1;
        else if (delta > escapeValue) stats.gt255Count += 1;
      }
    }
    prev = scaled;
    hasPrev = true;
  }

  if (!Number.isFinite(stats.minDelta)) stats.minDelta = 0;
  if (!Number.isFinite(stats.maxDelta)) stats.maxDelta = 0;
  return stats;
}

function mergeUint8EscapeDeltaAnalysis(target, partial) {
  target.deltaCount += partial.deltaCount;
  target.directFitCount += partial.directFitCount;
  target.escapeCount += partial.escapeCount;
  target.markerCollisionCount += partial.markerCollisionCount;
  target.negativeCount += partial.negativeCount;
  target.gt255Count += partial.gt255Count;
  target.zeroCount += partial.zeroCount;
  if (partial.minDelta < target.minDelta) target.minDelta = partial.minDelta;
  if (partial.maxDelta > target.maxDelta) target.maxDelta = partial.maxDelta;
}

function formatUint8EscapeDeltaAnalysis(name, stats) {
  if (!stats.deltaCount) return `${name}(n:0)`;
  const pct = (count) => ((count * 100) / stats.deltaCount).toFixed(3);
  return (
    `${name}(n:${stats.deltaCount},fit:${pct(stats.directFitCount)}%,` +
    `esc:${pct(stats.escapeCount)}%,collision255:${pct(stats.markerCollisionCount)}%,` +
    `neg:${pct(stats.negativeCount)}%,gt255:${pct(stats.gt255Count)}%,` +
    `z:${pct(stats.zeroCount)}%,min:${stats.minDelta},max:${stats.maxDelta})`
  );
}

function createSignedInt8EscapeDeltaAnalysis() {
  return {
    deltaCount: 0,
    directFitCount: 0,
    escapeCount: 0,
    markerCollisionCount: 0,
    belowMinCount: 0,
    aboveMaxCount: 0,
    zeroCount: 0,
    minDelta: Infinity,
    maxDelta: -Infinity,
  };
}

function analyzeSignedInt8EscapeDeltas(values, sentinel, escapeValue = 127, divisor = 1) {
  const stats = createSignedInt8EscapeDeltaAnalysis();
  let prev = null;
  let hasPrev = false;

  for (let index = 0; index < values.length; index += 1) {
    const raw = values[index];
    if (raw === sentinel) continue;
    const value = Math.round(raw / divisor);
    if (hasPrev) {
      const delta = value - prev;
      stats.deltaCount += 1;
      if (delta === 0) stats.zeroCount += 1;
      if (delta < stats.minDelta) stats.minDelta = delta;
      if (delta > stats.maxDelta) stats.maxDelta = delta;

      if (delta >= -128 && delta < escapeValue) {
        stats.directFitCount += 1;
      } else {
        stats.escapeCount += 1;
        if (delta === escapeValue) stats.markerCollisionCount += 1;
        else if (delta < -128) stats.belowMinCount += 1;
        else if (delta > escapeValue) stats.aboveMaxCount += 1;
      }
    }
    prev = value;
    hasPrev = true;
  }

  if (!Number.isFinite(stats.minDelta)) stats.minDelta = 0;
  if (!Number.isFinite(stats.maxDelta)) stats.maxDelta = 0;
  return stats;
}

function mergeSignedInt8EscapeDeltaAnalysis(target, partial) {
  target.deltaCount += partial.deltaCount;
  target.directFitCount += partial.directFitCount;
  target.escapeCount += partial.escapeCount;
  target.markerCollisionCount += partial.markerCollisionCount;
  target.belowMinCount += partial.belowMinCount;
  target.aboveMaxCount += partial.aboveMaxCount;
  target.zeroCount += partial.zeroCount;
  if (partial.minDelta < target.minDelta) target.minDelta = partial.minDelta;
  if (partial.maxDelta > target.maxDelta) target.maxDelta = partial.maxDelta;
}

function formatSignedInt8EscapeDeltaAnalysis(name, stats) {
  if (!stats.deltaCount) return `${name}(n:0)`;
  const pct = (count) => ((count * 100) / stats.deltaCount).toFixed(3);
  return (
    `${name}(n:${stats.deltaCount},fit:${pct(stats.directFitCount)}%,` +
    `esc:${pct(stats.escapeCount)}%,collision127:${pct(stats.markerCollisionCount)}%,` +
    `lt-128:${pct(stats.belowMinCount)}%,gt127:${pct(stats.aboveMaxCount)}%,` +
    `z:${pct(stats.zeroCount)}%,min:${stats.minDelta},max:${stats.maxDelta})`
  );
}

class GrowableTypedArray {
  constructor(Type, initialCapacity = 1024) {
    this.Type = Type;
    this.buffer = new Type(initialCapacity);
    this.length = 0;
  }

  push(value) {
    if (this.length >= this.buffer.length) {
      const next = new this.Type(this.buffer.length * 2);
      next.set(this.buffer);
      this.buffer = next;
    }
    this.buffer[this.length] = value;
    this.length += 1;
  }

  toTypedArray() {
    return this.buffer.slice(0, this.length);
  }
}

class CompactRecordColumns {
  constructor(initialCapacity = 1024) {
    this.capacity = initialCapacity;
    this.length = 0;
    this.timestampOffsetsS = new Int32Array(initialCapacity);
    this.distancesQ = new Uint32Array(initialCapacity);
    this.powersW = new Uint16Array(initialCapacity);
    this.heartRatesBpm = new Uint8Array(initialCapacity);
    this.cadencesRpm = new Uint8Array(initialCapacity);
    this.speedsCmS = new Uint16Array(initialCapacity);
    this.altitudesQ = new Int16Array(initialCapacity);
    this.positionLatsE6 = new Int32Array(initialCapacity);
    this.positionLongsE6 = new Int32Array(initialCapacity);
  }

  grow() {
    const nextCapacity = this.capacity * 2;
    const growOne = (Type, current) => {
      const next = new Type(nextCapacity);
      next.set(current);
      return next;
    };
    this.timestampOffsetsS = growOne(Int32Array, this.timestampOffsetsS);
    this.distancesQ = growOne(Uint32Array, this.distancesQ);
    this.powersW = growOne(Uint16Array, this.powersW);
    this.heartRatesBpm = growOne(Uint8Array, this.heartRatesBpm);
    this.cadencesRpm = growOne(Uint8Array, this.cadencesRpm);
    this.speedsCmS = growOne(Uint16Array, this.speedsCmS);
    this.altitudesQ = growOne(Int16Array, this.altitudesQ);
    this.positionLatsE6 = growOne(Int32Array, this.positionLatsE6);
    this.positionLongsE6 = growOne(Int32Array, this.positionLongsE6);
    this.capacity = nextCapacity;
  }

  push(timestampOffset, distance, power, heartRate, cadence, speed, altitude, lat, lng) {
    if (this.length >= this.capacity) this.grow();
    const index = this.length;
    this.timestampOffsetsS[index] = timestampOffset;
    this.distancesQ[index] = distance;
    this.powersW[index] = power;
    this.heartRatesBpm[index] = heartRate;
    this.cadencesRpm[index] = cadence;
    this.speedsCmS[index] = speed;
    this.altitudesQ[index] = altitude;
    this.positionLatsE6[index] = lat;
    this.positionLongsE6[index] = lng;
    this.length = index + 1;
  }

  typedBytes() {
    return this.length * (4 + 4 + 2 + 1 + 1 + 2 + 2 + 4 + 4);
  }

  toColumns() {
    const length = this.length;
    return {
      timestampOffsetsS: this.timestampOffsetsS.slice(0, length),
      distancesQ: this.distancesQ.slice(0, length),
      powersW: this.powersW.slice(0, length),
      heartRatesBpm: this.heartRatesBpm.slice(0, length),
      cadencesRpm: this.cadencesRpm.slice(0, length),
      speedsCmS: this.speedsCmS.slice(0, length),
      altitudesQ: this.altitudesQ.slice(0, length),
      positionLatsE6: this.positionLatsE6.slice(0, length),
      positionLongsE6: this.positionLongsE6.slice(0, length),
    };
  }
}

function readRawFitValue(view, offset, size, baseType, littleEndian) {
  const type = baseType & 0x1f;
  switch (type) {
    case 0x00:
    case 0x02:
    case 0x0d:
      return view.getUint8(offset);
    case 0x01:
      return view.getInt8(offset);
    case 0x83:
    case 0x03:
      return view.getInt16(offset, littleEndian);
    case 0x84:
    case 0x04:
      return view.getUint16(offset, littleEndian);
    case 0x85:
    case 0x05:
      return view.getInt32(offset, littleEndian);
    case 0x86:
    case 0x06:
      return view.getUint32(offset, littleEndian);
    case 0x88:
    case 0x08:
      return view.getFloat32(offset, littleEndian);
    default: {
      let value = 0;
      const bytes = Math.min(size, 4);
      for (let index = 0; index < bytes; index += 1) {
        const source = littleEndian ? index : bytes - index - 1;
        value |= view.getUint8(offset + source) << (index * 8);
      }
      return value >>> 0;
    }
  }
}

function isInvalidRawValue(rawValue, size, baseType) {
  const type = baseType & 0x1f;
  if (type === 0x01) return rawValue === 0x7f;
  if (type === 0x83 || type === 0x03) return rawValue === 0x7fff;
  if (type === 0x85 || type === 0x05) return rawValue === 0x7fffffff;
  if (type === 0x02 || type === 0x00 || type === 0x0d) return rawValue === 0xff;
  if (type === 0x84 || type === 0x04) return rawValue === 0xffff;
  if (type === 0x86 || type === 0x06) return rawValue === 0xffffffff;
  if (size === 1) return rawValue === 0xff;
  if (size === 2) return rawValue === 0xffff;
  if (size === 4) return rawValue === 0xffffffff;
  return false;
}

function compactUint8(value) {
  return Number.isFinite(value) ? Math.max(0, Math.min(254, Math.round(value))) : COMPACT_SENTINELS.uint8;
}

function compactUint16(value) {
  return Number.isFinite(value) ? Math.max(0, Math.min(65534, Math.round(value))) : COMPACT_SENTINELS.uint16;
}

function compactSpeed(value) {
  return Number.isFinite(value) ? Math.max(0, Math.min(65534, Math.round(value * 100))) : COMPACT_SENTINELS.uint16;
}

function compactAltitude(value) {
  return Number.isFinite(value) ? Math.max(-32767, Math.min(32767, Math.round(value * 4))) : COMPACT_SENTINELS.int16;
}

function compactDistance(value) {
  return Number.isFinite(value) && value >= 0
    ? Math.max(0, Math.min(0xfffffffe, Math.round(value * 4)))
    : COMPACT_SENTINELS.uint32;
}

function compactCoord(value) {
  return Number.isFinite(value)
    ? Math.max(-0x7fffffff, Math.min(0x7fffffff, Math.round(value * 1000000)))
    : COMPACT_SENTINELS.int32;
}

function quantizeSeries(sourceArray, recordCount, step) {
  const normalizedStep = Math.max(1, Number.parseInt(String(step ?? 1), 10) || 1);
  if (normalizedStep <= 1 || !sourceArray || recordCount <= 0) {
    return {
      values: sourceArray,
      step: normalizedStep,
      quantizedSamples: 0,
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
    if (quantized !== value) quantizedSamples += 1;
  }

  return {
    values: quantizedValues,
    step: normalizedStep,
    quantizedSamples,
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
        quantizedPowerSamples: 0,
        quantizedCadenceSamples: 0,
        quantizedHrSamples: 0,
      },
    };
  }

  const recordCount = Number(source.recordCount);
  const power = quantizeSeries(source.powersW, recordCount, quantizationOptions.powerStep);
  const cadence = quantizeSeries(source.cadencesRpm, recordCount, quantizationOptions.cadenceStep);
  const heartRate = quantizeSeries(source.heartRatesBpm, recordCount, quantizationOptions.hrStep);

  return {
    parsed: {
      ...parsed,
      recordsTyped: {
        ...source,
        powersW: power.values,
        cadencesRpm: cadence.values,
        heartRatesBpm: heartRate.values,
      },
    },
    stats: {
      powerStep: power.step,
      cadenceStep: cadence.step,
      hrStep: heartRate.step,
      quantizedPowerSamples: power.quantizedSamples,
      quantizedCadenceSamples: cadence.quantizedSamples,
      quantizedHrSamples: heartRate.quantizedSamples,
    },
  };
}

function quantizeCompactUintArray(sourceArray, step, sentinel, maxValue) {
  const normalizedStep = Math.max(1, Number.parseInt(String(step ?? 1), 10) || 1);
  if (normalizedStep <= 1 || !sourceArray) {
    return {
      values: sourceArray,
      step: normalizedStep,
      quantizedSamples: 0,
    };
  }

  const quantizedValues = new sourceArray.constructor(sourceArray.length);
  let quantizedSamples = 0;
  for (let index = 0; index < sourceArray.length; index += 1) {
    const value = Number(sourceArray[index]);
    if (!Number.isFinite(value) || value === sentinel) {
      quantizedValues[index] = sentinel;
      continue;
    }
    const quantized = Math.max(0, Math.min(maxValue, Math.round(value / normalizedStep) * normalizedStep));
    quantizedValues[index] = quantized;
    if (quantized !== value) quantizedSamples += 1;
  }

  return {
    values: quantizedValues,
    step: normalizedStep,
    quantizedSamples,
  };
}

function applyCompactQuantization(compact, quantizationOptions = {}) {
  const power = quantizeCompactUintArray(compact.columns.powersW, quantizationOptions.powerStep, COMPACT_SENTINELS.uint16, COMPACT_SENTINELS.uint16 - 1);
  const cadence = quantizeCompactUintArray(compact.columns.cadencesRpm, quantizationOptions.cadenceStep, COMPACT_SENTINELS.uint8, COMPACT_SENTINELS.uint8 - 1);
  const heartRate = quantizeCompactUintArray(compact.columns.heartRatesBpm, quantizationOptions.hrStep, COMPACT_SENTINELS.uint8, COMPACT_SENTINELS.uint8 - 1);

  return {
    compact: {
      ...compact,
      columns: {
        ...compact.columns,
        powersW: power.values,
        cadencesRpm: cadence.values,
        heartRatesBpm: heartRate.values,
      },
    },
    stats: {
      powerStep: power.step,
      cadenceStep: cadence.step,
      hrStep: heartRate.step,
      quantizedPowerSamples: power.quantizedSamples,
      quantizedCadenceSamples: cadence.quantizedSamples,
      quantizedHrSamples: heartRate.quantizedSamples,
    },
  };
}


function parseFitBufferCompactRaw(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length < 12 || (bytes[0] !== 12 && bytes[0] !== 14)) {
    throw new Error("Invalid FIT header");
  }
  if (String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]) !== ".FIT") {
    throw new Error("Missing .FIT in FIT header");
  }

  const headerLength = bytes[0];
  const dataLength = bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24);
  const end = headerLength + dataLength;
  const definitions = [];
  const timestampOffsetsS = new GrowableTypedArray(Int32Array);
  const distancesQ = new GrowableTypedArray(Uint32Array);
  const powersW = new GrowableTypedArray(Uint16Array);
  const heartRatesBpm = new GrowableTypedArray(Uint8Array);
  const cadencesRpm = new GrowableTypedArray(Uint8Array);
  const speedsCmS = new GrowableTypedArray(Uint16Array);
  const altitudesQ = new GrowableTypedArray(Int16Array);
  const positionLatsE6 = new GrowableTypedArray(Int32Array);
  const positionLongsE6 = new GrowableTypedArray(Int32Array);
  let baseTimestampMs = null;
  let recordCount = 0;
  let sessionCount = 0;
  let cursor = headerLength;

  while (cursor < end) {
    const header = bytes[cursor];
    const compressed = (header & 0x80) !== 0;
    const localMessage = compressed ? ((header & 0x60) >> 5) : (header & 0x0f);
    if (!compressed && (header & 0x40) !== 0) {
      const hasDeveloper = (header & 0x20) !== 0;
      const littleEndian = bytes[cursor + 2] === 0;
      const globalMessage = littleEndian
        ? bytes[cursor + 3] | (bytes[cursor + 4] << 8)
        : bytes[cursor + 4] | (bytes[cursor + 3] << 8);
      const fieldCount = bytes[cursor + 5];
      const fields = [];
      let offset = cursor + 6;
      for (let index = 0; index < fieldCount; index += 1) {
        fields.push({
          number: bytes[offset],
          size: bytes[offset + 1],
          baseType: bytes[offset + 2],
        });
        offset += 3;
      }
      if (hasDeveloper) {
        const developerCount = bytes[offset];
        offset += 1 + developerCount * 3;
      }
      definitions[localMessage] = { globalMessage, littleEndian, fields };
      cursor = offset;
      continue;
    }

    const definition = definitions[localMessage];
    if (!definition) throw new Error(`Missing FIT message definition for local message type ${localMessage}`);
    const recordView = new DataView(bytes.buffer, bytes.byteOffset + cursor + 1);
    let offset = 0;
    if (definition.globalMessage === 20) {
      let timestampMs = Number.NaN;
      let distanceM = Number.NaN;
      let powerW = Number.NaN;
      let heartRateBpm = Number.NaN;
      let cadenceRpm = Number.NaN;
      let speedMps = Number.NaN;
      let altitudeM = Number.NaN;
      let positionLatDeg = Number.NaN;
      let positionLongDeg = Number.NaN;
      for (const field of definition.fields) {
        const raw = readRawFitValue(recordView, offset, field.size, field.baseType, definition.littleEndian);
        const valid = !isInvalidRawValue(raw, field.size, field.baseType);
        if (valid) {
          switch (field.number) {
            case 253:
              timestampMs = raw * 1000 + GARMIN_TIME_OFFSET_MS;
              break;
            case 0:
              positionLatDeg = raw * SEMICIRCLES_TO_DEGREES;
              break;
            case 1:
              positionLongDeg = raw * SEMICIRCLES_TO_DEGREES;
              break;
            case 2:
              if (!Number.isFinite(altitudeM)) altitudeM = raw / 5 - 500;
              break;
            case 3:
              heartRateBpm = raw;
              break;
            case 4:
              cadenceRpm = raw;
              break;
            case 5:
              distanceM = raw / 100;
              break;
            case 6:
              if (!Number.isFinite(speedMps)) speedMps = raw / 1000;
              break;
            case 7:
              powerW = raw;
              break;
            case 73:
              speedMps = raw / 1000;
              break;
            case 78:
              altitudeM = raw / 5 - 500;
              break;
            default:
              break;
          }
        }
        offset += field.size;
      }
      if (baseTimestampMs == null && Number.isFinite(timestampMs)) {
        baseTimestampMs = Math.round(timestampMs);
      }
      timestampOffsetsS.push(Number.isFinite(timestampMs) && baseTimestampMs != null
        ? Math.max(-0x7fffffff, Math.min(0x7fffffff, Math.round((timestampMs - baseTimestampMs) / 1000)))
        : COMPACT_SENTINELS.int32);
      distancesQ.push(compactDistance(distanceM));
      powersW.push(compactUint16(powerW));
      heartRatesBpm.push(compactUint8(heartRateBpm));
      cadencesRpm.push(compactUint8(cadenceRpm));
      speedsCmS.push(compactSpeed(speedMps));
      altitudesQ.push(compactAltitude(altitudeM));
      positionLatsE6.push(compactCoord(positionLatDeg));
      positionLongsE6.push(compactCoord(positionLongDeg));
      recordCount += 1;
    } else {
      for (const field of definition.fields) offset += field.size;
      if (definition.globalMessage === 18) sessionCount += 1;
    }
    cursor += 1 + offset;
  }

  const columns = {
    timestampOffsetsS: timestampOffsetsS.toTypedArray(),
    distancesQ: distancesQ.toTypedArray(),
    powersW: powersW.toTypedArray(),
    heartRatesBpm: heartRatesBpm.toTypedArray(),
    cadencesRpm: cadencesRpm.toTypedArray(),
    speedsCmS: speedsCmS.toTypedArray(),
    altitudesQ: altitudesQ.toTypedArray(),
    positionLatsE6: positionLatsE6.toTypedArray(),
    positionLongsE6: positionLongsE6.toTypedArray(),
  };
  const typedBytes = Object.values(columns).reduce((sum, column) => sum + column.byteLength, 0);
  return {
    recordCount,
    sessionCount,
    baseTimestampMs: baseTimestampMs ?? 0,
    typedBytes,
    columns,
  };
}

function readU16LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32LE(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function readI32LE(bytes, offset) {
  return readU32LE(bytes, offset) | 0;
}

function readU16BE(bytes, offset) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readU32BE(bytes, offset) {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function readI32BE(bytes, offset) {
  return readU32BE(bytes, offset) | 0;
}

function compactCoordFromSemicircles(raw) {
  return Math.max(-0x7fffffff, Math.min(0x7fffffff, Math.round(raw * 180000000 / 0x80000000)));
}

function makeCompactRecordOps(fields, littleEndian) {
  const ops = [];
  let offset = 0;
  for (const field of fields) {
    const number = field.number;
    const size = field.size;
    const baseType = field.baseType & 0x1f;
    let kind = 0;
    if (number === 253 && size === 4) kind = 1;
    else if (number === 0 && size === 4) kind = 2;
    else if (number === 1 && size === 4) kind = 3;
    else if ((number === 2 || number === 78) && size === 2) kind = number === 78 ? 12 : 4;
    else if (number === 3 && size === 1) kind = 5;
    else if (number === 4 && size === 1) kind = 6;
    else if (number === 5 && size === 4) kind = 7;
    else if ((number === 6 || number === 73) && size === 2) kind = number === 73 ? 11 : 8;
    else if (number === 7 && size === 2) kind = 9;
    if (kind !== 0) {
      ops.push({ kind, offset, littleEndian, baseType });
    }
    offset += size;
  }
  return { ops, messageBytes: offset };
}

function makeSessionOps(fields, littleEndian) {
  const message = FIT.messages[18] || {};
  const ops = [];
  let offset = 0;
  for (const field of fields) {
    const definition = message[field.number] || {};
    if (SESSION_SPEC.some((spec) => spec.key === definition.field)) {
      ops.push({
        field: definition.field,
        type: definition.type || "byte",
        scale: definition.scale ?? null,
        valueOffset: definition.offset || 0,
        size: field.size,
        baseType: field.baseType,
        littleEndian,
        offset,
      });
    }
    offset += field.size;
  }
  return ops;
}

function decodeCompactSessionValue(rawValue, op) {
  if (rawValue == null || isInvalidRawValue(rawValue, op.size, op.baseType)) {
    return null;
  }
  switch (op.field) {
    case "timestamp":
    case "start_time":
      return (rawValue * 1000) + GARMIN_TIME_OFFSET_MS;
    case "nec_lat":
    case "nec_long":
    case "swc_lat":
    case "swc_long":
      return rawValue * SEMICIRCLES_TO_DEGREES;
    default:
      return op.scale ? (rawValue / op.scale) + op.valueOffset : rawValue;
  }
}

function parseFitBufferCompactFast(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length < 12 || (bytes[0] !== 12 && bytes[0] !== 14)) {
    throw new Error("Invalid FIT header");
  }
  if (bytes[8] !== 46 || bytes[9] !== 70 || bytes[10] !== 73 || bytes[11] !== 84) {
    throw new Error("Missing .FIT in FIT header");
  }

  const headerLength = bytes[0];
  const dataLength = readU32LE(bytes, 4);
  const end = headerLength + dataLength;
  const definitions = [];
  const columns = new CompactRecordColumns();
  let baseTimestampMs = -1;
  let recordCount = 0;
  const sessions = [];
  let cursor = headerLength;

  while (cursor < end) {
    const header = bytes[cursor];
    const compressed = (header & 0x80) !== 0;
    const localMessage = compressed ? ((header & 0x60) >> 5) : (header & 0x0f);
    if (!compressed && (header & 0x40) !== 0) {
      const hasDeveloper = (header & 0x20) !== 0;
      const littleEndian = bytes[cursor + 2] === 0;
      const globalMessage = littleEndian ? readU16LE(bytes, cursor + 3) : readU16BE(bytes, cursor + 3);
      const fieldCount = bytes[cursor + 5];
      const fields = new Array(fieldCount);
      let offset = cursor + 6;
      let messageBytes = 0;
      for (let index = 0; index < fieldCount; index += 1) {
        const size = bytes[offset + 1];
        fields[index] = {
          number: bytes[offset],
          size,
          baseType: bytes[offset + 2],
        };
        messageBytes += size;
        offset += 3;
      }
      if (hasDeveloper) {
        const developerCount = bytes[offset];
        offset += 1 + developerCount * 3;
      }
      definitions[localMessage] = {
        globalMessage,
        messageBytes,
        ...(globalMessage === 20 ? makeCompactRecordOps(fields, littleEndian) : { ops: null }),
        sessionOps: globalMessage === 18 ? makeSessionOps(fields, littleEndian) : null,
      };
      cursor = offset;
      continue;
    }

    const definition = definitions[localMessage];
    if (!definition) throw new Error(`Missing FIT message definition for local message type ${localMessage}`);
    const dataOffset = cursor + 1;
    if (definition.globalMessage === 20) {
      let timestampOffset = COMPACT_SENTINELS.int32;
      let distance = COMPACT_SENTINELS.uint32;
      let power = COMPACT_SENTINELS.uint16;
      let heartRate = COMPACT_SENTINELS.uint8;
      let cadence = COMPACT_SENTINELS.uint8;
      let speed = COMPACT_SENTINELS.uint16;
      let altitude = COMPACT_SENTINELS.int16;
      let lat = COMPACT_SENTINELS.int32;
      let lng = COMPACT_SENTINELS.int32;
      for (const op of definition.ops) {
        const o = dataOffset + op.offset;
        switch (op.kind) {
          case 1: {
            const raw = op.littleEndian ? readU32LE(bytes, o) : readU32BE(bytes, o);
            if (raw !== 0xffffffff) {
              const timestampMs = raw * 1000 + GARMIN_TIME_OFFSET_MS;
              if (baseTimestampMs < 0) baseTimestampMs = timestampMs;
              timestampOffset = Math.max(-0x7fffffff, Math.min(0x7fffffff, Math.round((timestampMs - baseTimestampMs) / 1000)));
            }
            break;
          }
          case 2: {
            const raw = op.littleEndian ? readI32LE(bytes, o) : readI32BE(bytes, o);
            if (raw !== 0x7fffffff) lat = compactCoordFromSemicircles(raw);
            break;
          }
          case 3: {
            const raw = op.littleEndian ? readI32LE(bytes, o) : readI32BE(bytes, o);
            if (raw !== 0x7fffffff) lng = compactCoordFromSemicircles(raw);
            break;
          }
          case 4: {
            const raw = op.littleEndian ? readU16LE(bytes, o) : readU16BE(bytes, o);
            if (raw !== 0xffff && altitude === COMPACT_SENTINELS.int16) altitude = Math.max(-32767, Math.min(32767, Math.round((raw / 5 - 500) * 4)));
            break;
          }
          case 5:
            if (bytes[o] !== 0xff) heartRate = bytes[o];
            break;
          case 6:
            if (bytes[o] !== 0xff) cadence = bytes[o];
            break;
          case 7: {
            const raw = op.littleEndian ? readU32LE(bytes, o) : readU32BE(bytes, o);
            if (raw !== 0xffffffff) distance = Math.min(0xfffffffe, Math.round(raw / 25));
            break;
          }
          case 8: {
            const raw = op.littleEndian ? readU16LE(bytes, o) : readU16BE(bytes, o);
            if (raw !== 0xffff && speed === COMPACT_SENTINELS.uint16) speed = Math.min(0xfffe, Math.round(raw / 10));
            break;
          }
          case 9: {
            const raw = op.littleEndian ? readU16LE(bytes, o) : readU16BE(bytes, o);
            if (raw !== 0xffff) power = Math.min(0xfffe, raw);
            break;
          }
          case 11: {
            const raw = op.littleEndian ? readU16LE(bytes, o) : readU16BE(bytes, o);
            if (raw !== 0xffff) speed = Math.min(0xfffe, Math.round(raw / 10));
            break;
          }
          case 12: {
            const raw = op.littleEndian ? readU16LE(bytes, o) : readU16BE(bytes, o);
            if (raw !== 0xffff) altitude = Math.max(-32767, Math.min(32767, Math.round((raw / 5 - 500) * 4)));
            break;
          }
          default:
            break;
        }
      }
      columns.push(timestampOffset, distance, power, heartRate, cadence, speed, altitude, lat, lng);
      recordCount += 1;
    } else if (definition.globalMessage === 18) {
      const session = {};
      for (const op of definition.sessionOps || []) {
        const raw = readRawFitValue(
          new DataView(bytes.buffer, bytes.byteOffset + dataOffset),
          op.offset,
          op.size,
          op.baseType,
          op.littleEndian,
        );
        session[op.field] = decodeCompactSessionValue(raw, op);
      }
      sessions.push(session);
    }
    cursor += 1 + definition.messageBytes;
  }

  const typedBytes = columns.typedBytes();
  return {
    recordCount,
    sessionCount: sessions.length,
    sessions,
    baseTimestampMs: baseTimestampMs < 0 ? 0 : baseTimestampMs,
    typedBytes,
    columns: columns.toColumns(),
  };
}

function writeUint16LE(target, offset, value) {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
}

function writeInt16LE(target, offset, value) {
  writeUint16LE(target, offset, value & 0xffff);
}

function writeUint32LE(target, offset, value) {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
  target[offset + 2] = (value >>> 16) & 0xff;
  target[offset + 3] = (value >>> 24) & 0xff;
}

function writeInt32LE(target, offset, value) {
  writeUint32LE(target, offset, value >>> 0);
}

function writeFloat64LE(target, offset, value) {
  new DataView(target.buffer, target.byteOffset + offset, 8).setFloat64(0, value, true);
}

function getSessionRecordSize() {
  return SESSION_SPEC.reduce((size, field) => {
    switch (field.type) {
      case "uint8":
      case "bool":
        return size + 1;
      case "uint16":
      case "scaled-uint16":
        return size + 2;
      case "uint32":
      case "scaled-uint32":
      case "time":
      case "coord":
        return size + 4;
      default:
        return size;
    }
  }, 0);
}

function encodeSessionTime(value) {
  const timestampMs = typeof value === "string" || value instanceof Date
    ? new Date(value).getTime()
    : Number(value);
  if (!Number.isFinite(timestampMs) || timestampMs < 0) return COMPACT_SENTINELS.uint32;
  return Math.max(0, Math.min(COMPACT_SENTINELS.uint32 - 1, Math.round(timestampMs / 1000)));
}

function encodeScaledUint32(value, scale) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return COMPACT_SENTINELS.uint32;
  return Math.max(0, Math.min(COMPACT_SENTINELS.uint32 - 1, Math.round(numeric * scale)));
}

function encodeScaledUint16(value, scale) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return COMPACT_SENTINELS.uint16;
  return Math.max(0, Math.min(COMPACT_SENTINELS.uint16 - 1, Math.round(numeric * scale)));
}

function encodeSessionCoord(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return COMPACT_SENTINELS.int32;
  return Math.max(COMPACT_SENTINELS.int32 + 1, Math.min(0x7fffffff, Math.round(numeric * SESSION_COORD_SCALE)));
}

function encodeSessionBlockCompat(sessions = []) {
  const normalizedSessions = Array.isArray(sessions) ? sessions : [];
  const recordSize = getSessionRecordSize();
  const headerBytes = 12;
  const bytes = new Uint8Array(headerBytes + normalizedSessions.length * recordSize);
  bytes.set([83, 69, 83, 49], 0); // SES1
  writeUint16LE(bytes, 4, SESSION_BLOCK_VERSION);
  writeUint16LE(bytes, 6, recordSize);
  writeUint32LE(bytes, 8, normalizedSessions.length);

  let offset = headerBytes;
  for (const session of normalizedSessions) {
    for (const field of SESSION_SPEC) {
      const value = session?.[field.key];
      switch (field.type) {
        case "time":
          writeUint32LE(bytes, offset, encodeSessionTime(value));
          offset += 4;
          break;
        case "scaled-uint32":
          writeUint32LE(bytes, offset, encodeScaledUint32(value, field.scale));
          offset += 4;
          break;
        case "uint32": {
          const numeric = Number(value);
          writeUint32LE(bytes, offset, Number.isFinite(numeric) && numeric >= 0
            ? Math.max(0, Math.min(COMPACT_SENTINELS.uint32 - 1, Math.round(numeric)))
            : COMPACT_SENTINELS.uint32);
          offset += 4;
          break;
        }
        case "scaled-uint16":
          writeUint16LE(bytes, offset, encodeScaledUint16(value, field.scale));
          offset += 2;
          break;
        case "uint16": {
          const numeric = Number(value);
          writeUint16LE(bytes, offset, Number.isFinite(numeric) && numeric >= 0
            ? Math.max(0, Math.min(COMPACT_SENTINELS.uint16 - 1, Math.round(numeric)))
            : COMPACT_SENTINELS.uint16);
          offset += 2;
          break;
        }
        case "uint8": {
          const numeric = Number(value);
          bytes[offset] = Number.isFinite(numeric) && numeric >= 0
            ? Math.max(0, Math.min(COMPACT_SENTINELS.uint8 - 1, Math.round(numeric)))
            : COMPACT_SENTINELS.uint8;
          offset += 1;
          break;
        }
        case "coord":
          writeInt32LE(bytes, offset, encodeSessionCoord(value));
          offset += 4;
          break;
        case "bool":
          bytes[offset] = value === true || Number(value) === 1 ? 1 : 0;
          offset += 1;
          break;
        default:
          break;
      }
    }
  }

  return bytes;
}

function buildDistancePayloadCompactValues(values) {
  const chunks = [];
  let totalBytes = 0;
  for (let start = 0; start < values.length; start += 128) {
    const count = Math.min(128, values.length - start);
    let canDeltaEncode = count > 0;
    for (let offset = 0; offset < count; offset += 1) {
      const current = values[start + offset];
      if (current === COMPACT_SENTINELS.uint32) {
        canDeltaEncode = false;
        break;
      }
      if (offset > 0) {
        const previous = values[start + offset - 1];
        const delta = current - previous;
        if (delta < -32767 || delta > 32767) {
          canDeltaEncode = false;
          break;
        }
      }
    }

    if (canDeltaEncode) {
      const chunk = new Uint8Array(1 + 2 + 4 + Math.max(0, count - 1) * 2);
      chunk[0] = 1;
      writeUint16LE(chunk, 1, count);
      writeUint32LE(chunk, 3, values[start]);
      let writeOffset = 7;
      for (let index = 1; index < count; index += 1) {
        writeInt16LE(chunk, writeOffset, values[start + index] - values[start + index - 1]);
        writeOffset += 2;
      }
      chunks.push(chunk);
      totalBytes += chunk.byteLength;
      continue;
    }

    const chunk = new Uint8Array(1 + 2 + count * 4);
    chunk[0] = 0;
    writeUint16LE(chunk, 1, count);
    let writeOffset = 3;
    for (let index = 0; index < count; index += 1) {
      writeUint32LE(chunk, writeOffset, values[start + index]);
      writeOffset += 4;
    }
    chunks.push(chunk);
    totalBytes += chunk.byteLength;
  }
  const payload = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    payload.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return payload;
}

function buildDistancePayloadCompactUint8Q02(values) {
  const DISTANCE_DIVISOR = 2;
  const DISTANCE_ESCAPE = 255;
  const chunks = [];
  let totalBytes = 0;
  for (let start = 0; start < values.length; start += DELTA_BLOCK_SIZE) {
    const count = Math.min(DELTA_BLOCK_SIZE, values.length - start);
    let canUint8Encode = count > 0 && values[start] !== COMPACT_SENTINELS.uint32;

    if (canUint8Encode) {
      const tokenBytes = new Uint8Array(Math.max(0, count - 1));
      const absoluteTailValues = [];
      let previousScaled = Math.round(values[start] / DISTANCE_DIVISOR);

      for (let offset = 1; offset < count; offset += 1) {
        const current = values[start + offset];
        if (current === COMPACT_SENTINELS.uint32) {
          canUint8Encode = false;
          break;
        }
        const currentScaled = Math.round(current / DISTANCE_DIVISOR);
        const delta = currentScaled - previousScaled;
        if (delta >= 0 && delta < DISTANCE_ESCAPE) {
          tokenBytes[offset - 1] = delta;
        } else {
          tokenBytes[offset - 1] = DISTANCE_ESCAPE;
          absoluteTailValues.push(currentScaled);
        }
        previousScaled = currentScaled;
      }

      if (canUint8Encode) {
        const chunk = new Uint8Array(1 + 2 + 4 + tokenBytes.byteLength + (absoluteTailValues.length * 4));
        chunk[0] = 3;
        writeUint16LE(chunk, 1, count);
        writeUint32LE(chunk, 3, Math.round(values[start] / DISTANCE_DIVISOR));
        chunk.set(tokenBytes, 7);
        let tailOffset = 7 + tokenBytes.byteLength;
        for (const absoluteValue of absoluteTailValues) {
          writeUint32LE(chunk, tailOffset, absoluteValue);
          tailOffset += 4;
        }
        chunks.push(chunk);
        totalBytes += chunk.byteLength;
        continue;
      }
    }

    const chunk = new Uint8Array(1 + 2 + count * 4);
    chunk[0] = 0;
    writeUint16LE(chunk, 1, count);
    let writeOffset = 3;
    for (let index = 0; index < count; index += 1) {
      writeUint32LE(chunk, writeOffset, values[start + index]);
      writeOffset += 4;
    }
    chunks.push(chunk);
    totalBytes += chunk.byteLength;
  }
  const payload = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    payload.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return payload;
}

function buildDistancePayloadCompactUint8Q05(values) {
  const DISTANCE_DIVISOR = 5;
  const DISTANCE_ESCAPE = 255;
  const chunks = [];
  let totalBytes = 0;
  for (let start = 0; start < values.length; start += DELTA_BLOCK_SIZE) {
    const count = Math.min(DELTA_BLOCK_SIZE, values.length - start);
    let canUint8Encode = count > 0 && values[start] !== COMPACT_SENTINELS.uint32;

    if (canUint8Encode) {
      const tokenBytes = new Uint8Array(Math.max(0, count - 1));
      const absoluteTailValues = [];
      let previousScaled = Math.round(values[start] / DISTANCE_DIVISOR);

      for (let offset = 1; offset < count; offset += 1) {
        const current = values[start + offset];
        if (current === COMPACT_SENTINELS.uint32) {
          canUint8Encode = false;
          break;
        }
        const currentScaled = Math.round(current / DISTANCE_DIVISOR);
        const delta = currentScaled - previousScaled;
        if (delta >= 0 && delta < DISTANCE_ESCAPE) {
          tokenBytes[offset - 1] = delta;
        } else {
          tokenBytes[offset - 1] = DISTANCE_ESCAPE;
          absoluteTailValues.push(currentScaled);
        }
        previousScaled = currentScaled;
      }

      if (canUint8Encode) {
        const chunk = new Uint8Array(1 + 2 + 4 + tokenBytes.byteLength + (absoluteTailValues.length * 4));
        chunk[0] = 3;
        writeUint16LE(chunk, 1, count);
        writeUint32LE(chunk, 3, Math.round(values[start] / DISTANCE_DIVISOR));
        chunk.set(tokenBytes, 7);
        let tailOffset = 7 + tokenBytes.byteLength;
        for (const absoluteValue of absoluteTailValues) {
          writeUint32LE(chunk, tailOffset, absoluteValue);
          tailOffset += 4;
        }
        chunks.push(chunk);
        totalBytes += chunk.byteLength;
        continue;
      }
    }

    const chunk = new Uint8Array(1 + 2 + count * 4);
    chunk[0] = 0;
    writeUint16LE(chunk, 1, count);
    let writeOffset = 3;
    for (let index = 0; index < count; index += 1) {
      writeUint32LE(chunk, writeOffset, values[start + index]);
      writeOffset += 4;
    }
    chunks.push(chunk);
    totalBytes += chunk.byteLength;
  }
  const payload = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    payload.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return payload;
}

function buildWorkoutStreamBlockCompact(compact) {
  const columns = compact.columns;
  const recordCount = compact.recordCount;
  let hasCompleteDistanceSeries = recordCount > 0;
  for (let index = 0; index < recordCount; index += 1) {
    if (columns.distancesQ[index] === COMPACT_SENTINELS.uint32) {
      hasCompleteDistanceSeries = false;
      break;
    }
  }
  const distancePayload = buildDistancePayloadCompactValues(columns.distancesQ);
  const distancesBytes = distancePayload.byteLength;
  const powersBytes = recordCount * 2;
  const heartRatesBytes = recordCount;
  const cadencesBytes = recordCount;
  const speedsBytes = hasCompleteDistanceSeries ? 0 : recordCount * 2;
  const altitudesBytes = recordCount * 2;
  const headerBytes = 4 + 4 + 8 + 4 + 6 * 4;
  const bytes = new Uint8Array(headerBytes + distancesBytes + powersBytes + heartRatesBytes + cadencesBytes + speedsBytes + altitudesBytes);
  bytes.set([87, 83, 84, 51], 0); // WST3
  writeUint32LE(bytes, 4, recordCount);
  writeFloat64LE(bytes, 8, compact.baseTimestampMs);
  writeUint32LE(bytes, 16, 1000);
  let headerOffset = 20;
  for (const length of [distancesBytes, powersBytes, heartRatesBytes, cadencesBytes, speedsBytes, altitudesBytes]) {
    writeUint32LE(bytes, headerOffset, length);
    headerOffset += 4;
  }
  let payloadOffset = headerBytes;
  bytes.set(distancePayload, payloadOffset);
  payloadOffset += distancesBytes;
  bytes.set(new Uint8Array(columns.powersW.buffer, columns.powersW.byteOffset, powersBytes), payloadOffset);
  payloadOffset += powersBytes;
  bytes.set(columns.heartRatesBpm, payloadOffset);
  payloadOffset += heartRatesBytes;
  bytes.set(columns.cadencesRpm, payloadOffset);
  payloadOffset += cadencesBytes;
  if (speedsBytes > 0) {
    bytes.set(new Uint8Array(columns.speedsCmS.buffer, columns.speedsCmS.byteOffset, speedsBytes), payloadOffset);
    payloadOffset += speedsBytes;
  }
  bytes.set(new Uint8Array(columns.altitudesQ.buffer, columns.altitudesQ.byteOffset, altitudesBytes), payloadOffset);
  return {
    bytes,
    distancePayloadBytes: distancePayload,
    powerPayloadBytes: new Uint8Array(columns.powersW.buffer, columns.powersW.byteOffset, powersBytes),
    heartRatePayloadBytes: columns.heartRatesBpm,
    cadencePayloadBytes: columns.cadencesRpm,
    speedPayloadBytes: speedsBytes > 0
      ? new Uint8Array(columns.speedsCmS.buffer, columns.speedsCmS.byteOffset, speedsBytes)
      : new Uint8Array(0),
    altitudePayloadBytes: new Uint8Array(columns.altitudesQ.buffer, columns.altitudesQ.byteOffset, altitudesBytes),
    stats: {
      recordCount,
      usesSpeedFallback: !hasCompleteDistanceSeries,
      speedFallbackRecordCount: hasCompleteDistanceSeries ? 0 : recordCount,
      blockBytes: {
        distances: distancesBytes,
        powers: powersBytes,
        heartRates: heartRatesBytes,
        cadences: cadencesBytes,
        speeds: speedsBytes,
        altitudes: altitudesBytes,
      }
    },
  };
}

function gzipByteLength(bytes, level) {
  return gzipSync(bytes, { level }).byteLength;
}

function buildWorkoutStreamBlockCompactDistanceUint8Q02(compact) {
  const columns = compact.columns;
  const recordCount = compact.recordCount;
  let hasCompleteDistanceSeries = recordCount > 0;
  for (let index = 0; index < recordCount; index += 1) {
    if (columns.distancesQ[index] === COMPACT_SENTINELS.uint32) {
      hasCompleteDistanceSeries = false;
      break;
    }
  }
  const distancePayload = buildDistancePayloadCompactUint8Q02(columns.distancesQ);
  const distancesBytes = distancePayload.byteLength;
  const powersBytes = recordCount * 2;
  const heartRatesBytes = recordCount;
  const cadencesBytes = recordCount;
  const speedsBytes = hasCompleteDistanceSeries ? 0 : recordCount * 2;
  const altitudesBytes = recordCount * 2;
  const headerBytes = 4 + 4 + 8 + 4 + 6 * 4;
  const bytes = new Uint8Array(headerBytes + distancesBytes + powersBytes + heartRatesBytes + cadencesBytes + speedsBytes + altitudesBytes);
  bytes.set([87, 83, 84, 53], 0); // WST5 experimental distance uint8@0.2m
  writeUint32LE(bytes, 4, recordCount);
  writeFloat64LE(bytes, 8, compact.baseTimestampMs);
  writeUint32LE(bytes, 16, 1000);
  let headerOffset = 20;
  for (const length of [distancesBytes, powersBytes, heartRatesBytes, cadencesBytes, speedsBytes, altitudesBytes]) {
    writeUint32LE(bytes, headerOffset, length);
    headerOffset += 4;
  }
  let payloadOffset = headerBytes;
  bytes.set(distancePayload, payloadOffset);
  payloadOffset += distancesBytes;
  bytes.set(new Uint8Array(columns.powersW.buffer, columns.powersW.byteOffset, powersBytes), payloadOffset);
  payloadOffset += powersBytes;
  bytes.set(columns.heartRatesBpm, payloadOffset);
  payloadOffset += heartRatesBytes;
  bytes.set(columns.cadencesRpm, payloadOffset);
  payloadOffset += cadencesBytes;
  if (speedsBytes > 0) {
    bytes.set(new Uint8Array(columns.speedsCmS.buffer, columns.speedsCmS.byteOffset, speedsBytes), payloadOffset);
    payloadOffset += speedsBytes;
  }
  bytes.set(new Uint8Array(columns.altitudesQ.buffer, columns.altitudesQ.byteOffset, altitudesBytes), payloadOffset);
  return {
    bytes,
    distancePayloadBytes: distancePayload,
    powerPayloadBytes: new Uint8Array(columns.powersW.buffer, columns.powersW.byteOffset, powersBytes),
    heartRatePayloadBytes: columns.heartRatesBpm,
    cadencePayloadBytes: columns.cadencesRpm,
    speedPayloadBytes: speedsBytes > 0
      ? new Uint8Array(columns.speedsCmS.buffer, columns.speedsCmS.byteOffset, speedsBytes)
      : new Uint8Array(0),
    altitudePayloadBytes: new Uint8Array(columns.altitudesQ.buffer, columns.altitudesQ.byteOffset, altitudesBytes),
    stats: {
      recordCount,
      usesSpeedFallback: !hasCompleteDistanceSeries,
      speedFallbackRecordCount: hasCompleteDistanceSeries ? 0 : recordCount,
      distanceEncoding: "uint8-q02",
      blockBytes: {
        distances: distancesBytes,
        powers: powersBytes,
        heartRates: heartRatesBytes,
        cadences: cadencesBytes,
        speeds: speedsBytes,
        altitudes: altitudesBytes,
      }
    },
  };
}

function buildWorkoutStreamBlockCompactDistanceUint8Q05(compact) {
  const columns = compact.columns;
  const recordCount = compact.recordCount;
  let hasCompleteDistanceSeries = recordCount > 0;
  for (let index = 0; index < recordCount; index += 1) {
    if (columns.distancesQ[index] === COMPACT_SENTINELS.uint32) {
      hasCompleteDistanceSeries = false;
      break;
    }
  }
  const distancePayload = buildDistancePayloadCompactUint8Q05(columns.distancesQ);
  const distancesBytes = distancePayload.byteLength;
  const powersBytes = recordCount * 2;
  const heartRatesBytes = recordCount;
  const cadencesBytes = recordCount;
  const speedsBytes = hasCompleteDistanceSeries ? 0 : recordCount * 2;
  const altitudesBytes = recordCount * 2;
  const headerBytes = 4 + 4 + 8 + 4 + 6 * 4;
  const bytes = new Uint8Array(headerBytes + distancesBytes + powersBytes + heartRatesBytes + cadencesBytes + speedsBytes + altitudesBytes);
  bytes.set([87, 83, 84, 53], 0); // WST5 benchmark variant with distance uint8@0.5m
  writeUint32LE(bytes, 4, recordCount);
  writeFloat64LE(bytes, 8, compact.baseTimestampMs);
  writeUint32LE(bytes, 16, 1000);
  let headerOffset = 20;
  for (const length of [distancesBytes, powersBytes, heartRatesBytes, cadencesBytes, speedsBytes, altitudesBytes]) {
    writeUint32LE(bytes, headerOffset, length);
    headerOffset += 4;
  }
  let payloadOffset = headerBytes;
  bytes.set(distancePayload, payloadOffset);
  payloadOffset += distancesBytes;
  bytes.set(new Uint8Array(columns.powersW.buffer, columns.powersW.byteOffset, powersBytes), payloadOffset);
  payloadOffset += powersBytes;
  bytes.set(columns.heartRatesBpm, payloadOffset);
  payloadOffset += heartRatesBytes;
  bytes.set(columns.cadencesRpm, payloadOffset);
  payloadOffset += cadencesBytes;
  if (speedsBytes > 0) {
    bytes.set(new Uint8Array(columns.speedsCmS.buffer, columns.speedsCmS.byteOffset, speedsBytes), payloadOffset);
    payloadOffset += speedsBytes;
  }
  bytes.set(new Uint8Array(columns.altitudesQ.buffer, columns.altitudesQ.byteOffset, altitudesBytes), payloadOffset);
  return {
    bytes,
    distancePayloadBytes: distancePayload,
    powerPayloadBytes: new Uint8Array(columns.powersW.buffer, columns.powersW.byteOffset, powersBytes),
    heartRatePayloadBytes: columns.heartRatesBpm,
    cadencePayloadBytes: columns.cadencesRpm,
    speedPayloadBytes: speedsBytes > 0
      ? new Uint8Array(columns.speedsCmS.buffer, columns.speedsCmS.byteOffset, speedsBytes)
      : new Uint8Array(0),
    altitudePayloadBytes: new Uint8Array(columns.altitudesQ.buffer, columns.altitudesQ.byteOffset, altitudesBytes),
    stats: {
      recordCount,
      usesSpeedFallback: !hasCompleteDistanceSeries,
      speedFallbackRecordCount: hasCompleteDistanceSeries ? 0 : recordCount,
      distanceEncoding: "uint8-q05",
      blockBytes: {
        distances: distancesBytes,
        powers: powersBytes,
        heartRates: heartRatesBytes,
        cadences: cadencesBytes,
        speeds: speedsBytes,
        altitudes: altitudesBytes,
      }
    },
  };
}

function buildWorkoutStreamBlockCompactDelta16PowerDistanceUint8Q02(compact) {
  const columns = compact.columns;
  const recordCount = compact.recordCount;
  let hasCompleteDistanceSeries = recordCount > 0;
  for (let index = 0; index < recordCount; index += 1) {
    if (columns.distancesQ[index] === COMPACT_SENTINELS.uint32) {
      hasCompleteDistanceSeries = false;
      break;
    }
  }
  const distancePayload = buildDistancePayloadCompactUint8Q02(columns.distancesQ);
  const powerPayload = buildPowerDeltaPayloadCompact(columns.powersW);
  const distancesBytes = distancePayload.byteLength;
  const powersBytes = powerPayload.bytes.byteLength;
  const heartRatesBytes = recordCount;
  const cadencesBytes = recordCount;
  const speedsBytes = hasCompleteDistanceSeries ? 0 : recordCount * 2;
  const altitudesBytes = recordCount * 2;
  const headerBytes = 4 + 4 + 8 + 4 + 6 * 4;
  const bytes = new Uint8Array(headerBytes + distancesBytes + powersBytes + heartRatesBytes + cadencesBytes + speedsBytes + altitudesBytes);
  bytes.set([87, 83, 84, 54], 0); // WST6 experimental power-delta + distance-u8@0.2m
  writeUint32LE(bytes, 4, recordCount);
  writeFloat64LE(bytes, 8, compact.baseTimestampMs);
  writeUint32LE(bytes, 16, 1000);
  let headerOffset = 20;
  for (const length of [distancesBytes, powersBytes, heartRatesBytes, cadencesBytes, speedsBytes, altitudesBytes]) {
    writeUint32LE(bytes, headerOffset, length);
    headerOffset += 4;
  }
  let payloadOffset = headerBytes;
  bytes.set(distancePayload, payloadOffset);
  payloadOffset += distancesBytes;
  bytes.set(powerPayload.bytes, payloadOffset);
  payloadOffset += powersBytes;
  bytes.set(columns.heartRatesBpm, payloadOffset);
  payloadOffset += heartRatesBytes;
  bytes.set(columns.cadencesRpm, payloadOffset);
  payloadOffset += cadencesBytes;
  if (speedsBytes > 0) {
    bytes.set(new Uint8Array(columns.speedsCmS.buffer, columns.speedsCmS.byteOffset, speedsBytes), payloadOffset);
    payloadOffset += speedsBytes;
  }
  bytes.set(new Uint8Array(columns.altitudesQ.buffer, columns.altitudesQ.byteOffset, altitudesBytes), payloadOffset);
  return {
    bytes,
    distancePayloadBytes: distancePayload,
    powerPayloadBytes: powerPayload.bytes,
    heartRatePayloadBytes: columns.heartRatesBpm,
    cadencePayloadBytes: columns.cadencesRpm,
    speedPayloadBytes: speedsBytes > 0
      ? new Uint8Array(columns.speedsCmS.buffer, columns.speedsCmS.byteOffset, speedsBytes)
      : new Uint8Array(0),
    altitudePayloadBytes: new Uint8Array(columns.altitudesQ.buffer, columns.altitudesQ.byteOffset, altitudesBytes),
    stats: {
      recordCount,
      usesSpeedFallback: !hasCompleteDistanceSeries,
      speedFallbackRecordCount: hasCompleteDistanceSeries ? 0 : recordCount,
      powerEncoding: powerPayload.stats.encoding,
      powerEscapeCount: powerPayload.stats.escapeCount,
      powerAbsoluteCount: powerPayload.stats.absoluteCount,
      distanceEncoding: "uint8-q02",
      blockBytes: {
        distances: distancesBytes,
        powers: powersBytes,
        heartRates: heartRatesBytes,
        cadences: cadencesBytes,
        speeds: speedsBytes,
        altitudes: altitudesBytes,
      },
    },
  };
}

function buildWorkoutStreamBlockCompactDelta16PowerDistanceUint8Q05(compact) {
  const columns = compact.columns;
  const recordCount = compact.recordCount;
  let hasCompleteDistanceSeries = recordCount > 0;
  for (let index = 0; index < recordCount; index += 1) {
    if (columns.distancesQ[index] === COMPACT_SENTINELS.uint32) {
      hasCompleteDistanceSeries = false;
      break;
    }
  }
  const distancePayload = buildDistancePayloadCompactUint8Q05(columns.distancesQ);
  const powerPayload = buildPowerDeltaPayloadCompact(columns.powersW);
  const distancesBytes = distancePayload.byteLength;
  const powersBytes = powerPayload.bytes.byteLength;
  const heartRatesBytes = recordCount;
  const cadencesBytes = recordCount;
  const speedsBytes = hasCompleteDistanceSeries ? 0 : recordCount * 2;
  const altitudesBytes = recordCount * 2;
  const headerBytes = 4 + 4 + 8 + 4 + 6 * 4;
  const bytes = new Uint8Array(headerBytes + distancesBytes + powersBytes + heartRatesBytes + cadencesBytes + speedsBytes + altitudesBytes);
  bytes.set([87, 83, 84, 54], 0);
  writeUint32LE(bytes, 4, recordCount);
  writeFloat64LE(bytes, 8, compact.baseTimestampMs);
  writeUint32LE(bytes, 16, 1000);
  let headerOffset = 20;
  for (const length of [distancesBytes, powersBytes, heartRatesBytes, cadencesBytes, speedsBytes, altitudesBytes]) {
    writeUint32LE(bytes, headerOffset, length);
    headerOffset += 4;
  }
  let payloadOffset = headerBytes;
  bytes.set(distancePayload, payloadOffset);
  payloadOffset += distancesBytes;
  bytes.set(powerPayload.bytes, payloadOffset);
  payloadOffset += powersBytes;
  bytes.set(columns.heartRatesBpm, payloadOffset);
  payloadOffset += heartRatesBytes;
  bytes.set(columns.cadencesRpm, payloadOffset);
  payloadOffset += cadencesBytes;
  if (speedsBytes > 0) {
    bytes.set(new Uint8Array(columns.speedsCmS.buffer, columns.speedsCmS.byteOffset, speedsBytes), payloadOffset);
    payloadOffset += speedsBytes;
  }
  bytes.set(new Uint8Array(columns.altitudesQ.buffer, columns.altitudesQ.byteOffset, altitudesBytes), payloadOffset);
  return {
    bytes,
    distancePayloadBytes: distancePayload,
    powerPayloadBytes: powerPayload.bytes,
    heartRatePayloadBytes: columns.heartRatesBpm,
    cadencePayloadBytes: columns.cadencesRpm,
    speedPayloadBytes: speedsBytes > 0
      ? new Uint8Array(columns.speedsCmS.buffer, columns.speedsCmS.byteOffset, speedsBytes)
      : new Uint8Array(0),
    altitudePayloadBytes: new Uint8Array(columns.altitudesQ.buffer, columns.altitudesQ.byteOffset, altitudesBytes),
    stats: {
      recordCount,
      usesSpeedFallback: !hasCompleteDistanceSeries,
      speedFallbackRecordCount: hasCompleteDistanceSeries ? 0 : recordCount,
      powerEncoding: powerPayload.stats.encoding,
      powerEscapeCount: powerPayload.stats.escapeCount,
      powerAbsoluteCount: powerPayload.stats.absoluteCount,
      distanceEncoding: "uint8-q05",
      blockBytes: {
        distances: distancesBytes,
        powers: powersBytes,
        heartRates: heartRatesBytes,
        cadences: cadencesBytes,
        speeds: speedsBytes,
        altitudes: altitudesBytes,
      },
    },
  };
}

function buildPowerDeltaPayloadCompact(powersW) {
  const ESCAPE_DELTA = -32768;
  if (!powersW.length) {
    return {
      bytes: new Uint8Array(0),
      stats: {
        encoding: "delta16",
        deltaCount: 0,
        escapeCount: 0,
        absoluteCount: 0,
      },
    };
  }
  const deltaBytes = new Uint8Array(Math.max(0, powersW.length - 1) * 2);
  const absoluteTailBytes = new Uint8Array(Math.max(0, powersW.length - 1) * 2);
  const firstValueBytes = new Uint8Array(2);
  writeUint16LE(firstValueBytes, 0, powersW[0]);
  let prev = powersW[0];
  let deltaOffset = 0;
  let absoluteOffset = 0;
  let escapeCount = 0;
  for (let index = 1; index < powersW.length; index += 1) {
    const current = powersW[index];
    const prevValid = prev !== COMPACT_SENTINELS.uint16;
    const currentValid = current !== COMPACT_SENTINELS.uint16;
    const delta = currentValid && prevValid ? current - prev : NaN;
    if (!Number.isFinite(delta) || delta < -32767 || delta > 32767) {
      writeInt16LE(deltaBytes, deltaOffset, ESCAPE_DELTA);
      deltaOffset += 2;
      writeUint16LE(absoluteTailBytes, absoluteOffset, current);
      absoluteOffset += 2;
      escapeCount += 1;
      prev = current;
      continue;
    }
    writeInt16LE(deltaBytes, deltaOffset, delta);
    deltaOffset += 2;
    prev = current;
  }
  const bytes = new Uint8Array(firstValueBytes.byteLength + deltaOffset + absoluteOffset);
  let offset = 0;
  bytes.set(firstValueBytes, offset);
  offset += firstValueBytes.byteLength;
  bytes.set(deltaBytes.subarray(0, deltaOffset), offset);
  offset += deltaOffset;
  bytes.set(absoluteTailBytes.subarray(0, absoluteOffset), offset);
  return {
    bytes,
    stats: {
      encoding: "delta16",
      deltaCount: Math.max(0, powersW.length - 1),
      escapeCount,
      absoluteCount: 1 + escapeCount,
    },
  };
}

function buildAltitudeDeltaPayloadCompact(altitudesQ) {
  const ESCAPE_DELTA = 127;
  const ALTITUDE_DIVISOR = 4; // internal 0.25m units -> 1m encoded units
  if (!altitudesQ || altitudesQ.length <= 0) {
    return {
      bytes: new Uint8Array(0),
      stats: {
        encoding: "delta8-q1m",
        escapeCount: 0,
        absoluteCount: 0,
      },
    };
  }

  const tokenBytes = new Int8Array(Math.max(0, altitudesQ.length - 1));
  const absoluteTailBytes = new Uint8Array(Math.max(0, altitudesQ.length - 1) * 2);
  const firstValueBytes = new Uint8Array(2);
  const firstValue = altitudesQ[0] === COMPACT_SENTINELS.int16
    ? COMPACT_SENTINELS.int16
    : Math.round(altitudesQ[0] / ALTITUDE_DIVISOR);
  writeInt16LE(firstValueBytes, 0, firstValue);

  let prev = firstValue;
  let absoluteOffset = 0;
  let escapeCount = 0;

  for (let index = 1; index < altitudesQ.length; index += 1) {
    const currentRaw = altitudesQ[index];
    const current = currentRaw === COMPACT_SENTINELS.int16
      ? COMPACT_SENTINELS.int16
      : Math.round(currentRaw / ALTITUDE_DIVISOR);
    const prevValid = prev !== COMPACT_SENTINELS.int16;
    const currentValid = current !== COMPACT_SENTINELS.int16;
    const delta = currentValid && prevValid ? current - prev : Number.NaN;

    if (!Number.isFinite(delta) || delta < -128 || delta >= ESCAPE_DELTA) {
      tokenBytes[index - 1] = ESCAPE_DELTA;
      writeInt16LE(absoluteTailBytes, absoluteOffset, current);
      absoluteOffset += 2;
      escapeCount += 1;
      prev = current;
      continue;
    }

    tokenBytes[index - 1] = delta;
    prev = current;
  }

  const bytes = new Uint8Array(firstValueBytes.byteLength + tokenBytes.byteLength + absoluteOffset);
  let offset = 0;
  bytes.set(firstValueBytes, offset);
  offset += firstValueBytes.byteLength;
  bytes.set(new Uint8Array(tokenBytes.buffer, tokenBytes.byteOffset, tokenBytes.byteLength), offset);
  offset += tokenBytes.byteLength;
  bytes.set(absoluteTailBytes.subarray(0, absoluteOffset), offset);
  return {
    bytes,
    stats: {
      encoding: "delta8-q1m",
      escapeCount,
      absoluteCount: 1 + escapeCount,
    },
  };
}

function buildAltitudeRunLengthPayloadCompact(altitudesQ) {
  const ALTITUDE_DIVISOR = 4; // internal 0.25m units -> 1m encoded units
  if (!altitudesQ || altitudesQ.length <= 0) {
    return {
      bytes: new Uint8Array(0),
      stats: {
        encoding: "rle-q1m",
        runCount: 0,
      },
    };
  }

  const chunks = [];
  let totalBytes = 0;
  let runCount = 0;
  let previous = altitudesQ[0] === COMPACT_SENTINELS.int16
    ? COMPACT_SENTINELS.int16
    : Math.round(altitudesQ[0] / ALTITUDE_DIVISOR);
  let runLength = 1;

  const flushRun = (value, count) => {
    let remaining = count;
    while (remaining > 0) {
      const chunkLength = Math.min(255, remaining);
      const chunk = new Uint8Array(3);
      chunk[0] = chunkLength;
      writeInt16LE(chunk, 1, value);
      chunks.push(chunk);
      totalBytes += chunk.byteLength;
      runCount += 1;
      remaining -= chunkLength;
    }
  };

  for (let index = 1; index < altitudesQ.length; index += 1) {
    const raw = altitudesQ[index];
    const current = raw === COMPACT_SENTINELS.int16
      ? COMPACT_SENTINELS.int16
      : Math.round(raw / ALTITUDE_DIVISOR);
    if (current === previous) {
      runLength += 1;
      continue;
    }
    flushRun(previous, runLength);
    previous = current;
    runLength = 1;
  }
  flushRun(previous, runLength);

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    bytes,
    stats: {
      encoding: "rle-q1m",
      runCount,
    },
  };
}

function buildWorkoutStreamBlockCompactDelta16Power(compact) {
  const columns = compact.columns;
  const recordCount = compact.recordCount;
  let hasCompleteDistanceSeries = recordCount > 0;
  for (let index = 0; index < recordCount; index += 1) {
    if (columns.distancesQ[index] === COMPACT_SENTINELS.uint32) {
      hasCompleteDistanceSeries = false;
      break;
    }
  }
  const distancePayload = buildDistancePayloadCompactValues(columns.distancesQ);
  const powerPayload = buildPowerDeltaPayloadCompact(columns.powersW);
  const distancesBytes = distancePayload.byteLength;
  const powersBytes = powerPayload.bytes.byteLength;
  const heartRatesBytes = recordCount;
  const cadencesBytes = recordCount;
  const speedsBytes = hasCompleteDistanceSeries ? 0 : recordCount * 2;
  const altitudesBytes = recordCount * 2;
  const headerBytes = 4 + 4 + 8 + 4 + 6 * 4;
  const bytes = new Uint8Array(headerBytes + distancesBytes + powersBytes + heartRatesBytes + cadencesBytes + speedsBytes + altitudesBytes);
  bytes.set([87, 83, 84, 52], 0); // WST4 experimental delta16 power block
  writeUint32LE(bytes, 4, recordCount);
  writeFloat64LE(bytes, 8, compact.baseTimestampMs);
  writeUint32LE(bytes, 16, 1000);
  let headerOffset = 20;
  for (const length of [distancesBytes, powersBytes, heartRatesBytes, cadencesBytes, speedsBytes, altitudesBytes]) {
    writeUint32LE(bytes, headerOffset, length);
    headerOffset += 4;
  }
  let payloadOffset = headerBytes;
  bytes.set(distancePayload, payloadOffset);
  payloadOffset += distancesBytes;
  bytes.set(powerPayload.bytes, payloadOffset);
  payloadOffset += powersBytes;
  bytes.set(columns.heartRatesBpm, payloadOffset);
  payloadOffset += heartRatesBytes;
  bytes.set(columns.cadencesRpm, payloadOffset);
  payloadOffset += cadencesBytes;
  if (speedsBytes > 0) {
    bytes.set(new Uint8Array(columns.speedsCmS.buffer, columns.speedsCmS.byteOffset, speedsBytes), payloadOffset);
    payloadOffset += speedsBytes;
  }
  bytes.set(new Uint8Array(columns.altitudesQ.buffer, columns.altitudesQ.byteOffset, altitudesBytes), payloadOffset);
  return {
    bytes,
    distancePayloadBytes: distancePayload,
    powerPayloadBytes: powerPayload.bytes,
    heartRatePayloadBytes: columns.heartRatesBpm,
    cadencePayloadBytes: columns.cadencesRpm,
    speedPayloadBytes: speedsBytes > 0
      ? new Uint8Array(columns.speedsCmS.buffer, columns.speedsCmS.byteOffset, speedsBytes)
      : new Uint8Array(0),
    altitudePayloadBytes: new Uint8Array(columns.altitudesQ.buffer, columns.altitudesQ.byteOffset, altitudesBytes),
    stats: {
      recordCount,
      usesSpeedFallback: !hasCompleteDistanceSeries,
      speedFallbackRecordCount: hasCompleteDistanceSeries ? 0 : recordCount,
      powerEncoding: powerPayload.stats.encoding,
      powerEscapeCount: powerPayload.stats.escapeCount,
      powerAbsoluteCount: powerPayload.stats.absoluteCount,
      blockBytes: {
        distances: distancesBytes,
        powers: powersBytes,
        heartRates: heartRatesBytes,
        cadences: cadencesBytes,
        speeds: speedsBytes,
        altitudes: altitudesBytes,
      },
    },
  };
}

function buildWorkoutStreamBlockCompactDelta16PowerDistanceUint8Q02AltitudeInt8(compact) {
  const columns = compact.columns;
  const recordCount = compact.recordCount;
  let hasCompleteDistanceSeries = recordCount > 0;
  for (let index = 0; index < recordCount; index += 1) {
    if (columns.distancesQ[index] === COMPACT_SENTINELS.uint32) {
      hasCompleteDistanceSeries = false;
      break;
    }
  }
  const distancePayload = buildDistancePayloadCompactUint8Q02(columns.distancesQ);
  const powerPayload = buildPowerDeltaPayloadCompact(columns.powersW);
  const altitudePayload = buildAltitudeDeltaPayloadCompact(columns.altitudesQ);
  const distancesBytes = distancePayload.byteLength;
  const powersBytes = powerPayload.bytes.byteLength;
  const heartRatesBytes = recordCount;
  const cadencesBytes = recordCount;
  const speedsBytes = hasCompleteDistanceSeries ? 0 : recordCount * 2;
  const altitudesBytes = altitudePayload.bytes.byteLength;
  const headerBytes = 4 + 4 + 8 + 4 + 6 * 4;
  const bytes = new Uint8Array(headerBytes + distancesBytes + powersBytes + heartRatesBytes + cadencesBytes + speedsBytes + altitudesBytes);
  bytes.set([87, 83, 84, 55], 0); // WST7 experimental power-delta + distance-u8@0.2m + altitude-delta8
  writeUint32LE(bytes, 4, recordCount);
  writeFloat64LE(bytes, 8, compact.baseTimestampMs);
  writeUint32LE(bytes, 16, 1000);
  let headerOffset = 20;
  for (const length of [distancesBytes, powersBytes, heartRatesBytes, cadencesBytes, speedsBytes, altitudesBytes]) {
    writeUint32LE(bytes, headerOffset, length);
    headerOffset += 4;
  }
  let payloadOffset = headerBytes;
  bytes.set(distancePayload, payloadOffset);
  payloadOffset += distancesBytes;
  bytes.set(powerPayload.bytes, payloadOffset);
  payloadOffset += powersBytes;
  bytes.set(columns.heartRatesBpm, payloadOffset);
  payloadOffset += heartRatesBytes;
  bytes.set(columns.cadencesRpm, payloadOffset);
  payloadOffset += cadencesBytes;
  if (speedsBytes > 0) {
    bytes.set(new Uint8Array(columns.speedsCmS.buffer, columns.speedsCmS.byteOffset, speedsBytes), payloadOffset);
    payloadOffset += speedsBytes;
  }
  bytes.set(altitudePayload.bytes, payloadOffset);
  return {
    bytes,
    distancePayloadBytes: distancePayload,
    powerPayloadBytes: powerPayload.bytes,
    heartRatePayloadBytes: columns.heartRatesBpm,
    cadencePayloadBytes: columns.cadencesRpm,
    speedPayloadBytes: speedsBytes > 0
      ? new Uint8Array(columns.speedsCmS.buffer, columns.speedsCmS.byteOffset, speedsBytes)
      : new Uint8Array(0),
    altitudePayloadBytes: altitudePayload.bytes,
    stats: {
      recordCount,
      usesSpeedFallback: !hasCompleteDistanceSeries,
      speedFallbackRecordCount: hasCompleteDistanceSeries ? 0 : recordCount,
      powerEncoding: powerPayload.stats.encoding,
      powerEscapeCount: powerPayload.stats.escapeCount,
      powerAbsoluteCount: powerPayload.stats.absoluteCount,
      distanceEncoding: "uint8-q02",
      altitudeEncoding: altitudePayload.stats.encoding,
      altitudeEscapeCount: altitudePayload.stats.escapeCount,
      altitudeAbsoluteCount: altitudePayload.stats.absoluteCount,
      blockBytes: {
        distances: distancesBytes,
        powers: powersBytes,
        heartRates: heartRatesBytes,
        cadences: cadencesBytes,
        speeds: speedsBytes,
        altitudes: altitudesBytes,
      }
    },
  };
}

function buildWorkoutStreamBlockCompactDelta16PowerDistanceUint8Q02AltitudeRle(compact) {
  const columns = compact.columns;
  const recordCount = compact.recordCount;
  let hasCompleteDistanceSeries = recordCount > 0;
  for (let index = 0; index < recordCount; index += 1) {
    if (columns.distancesQ[index] === COMPACT_SENTINELS.uint32) {
      hasCompleteDistanceSeries = false;
      break;
    }
  }
  const distancePayload = buildDistancePayloadCompactUint8Q02(columns.distancesQ);
  const powerPayload = buildPowerDeltaPayloadCompact(columns.powersW);
  const altitudePayload = buildAltitudeRunLengthPayloadCompact(columns.altitudesQ);
  const distancesBytes = distancePayload.byteLength;
  const powersBytes = powerPayload.bytes.byteLength;
  const heartRatesBytes = recordCount;
  const cadencesBytes = recordCount;
  const speedsBytes = hasCompleteDistanceSeries ? 0 : recordCount * 2;
  const altitudesBytes = altitudePayload.bytes.byteLength;
  const headerBytes = 4 + 4 + 8 + 4 + 6 * 4;
  const bytes = new Uint8Array(headerBytes + distancesBytes + powersBytes + heartRatesBytes + cadencesBytes + speedsBytes + altitudesBytes);
  bytes.set([87, 83, 84, 57], 0); // WST9 benchmark variant with altitude RLE
  writeUint32LE(bytes, 4, recordCount);
  writeFloat64LE(bytes, 8, compact.baseTimestampMs);
  writeUint32LE(bytes, 16, 1000);
  let headerOffset = 20;
  for (const length of [distancesBytes, powersBytes, heartRatesBytes, cadencesBytes, speedsBytes, altitudesBytes]) {
    writeUint32LE(bytes, headerOffset, length);
    headerOffset += 4;
  }
  let payloadOffset = headerBytes;
  bytes.set(distancePayload, payloadOffset);
  payloadOffset += distancesBytes;
  bytes.set(powerPayload.bytes, payloadOffset);
  payloadOffset += powersBytes;
  bytes.set(columns.heartRatesBpm, payloadOffset);
  payloadOffset += heartRatesBytes;
  bytes.set(columns.cadencesRpm, payloadOffset);
  payloadOffset += cadencesBytes;
  if (speedsBytes > 0) {
    bytes.set(new Uint8Array(columns.speedsCmS.buffer, columns.speedsCmS.byteOffset, speedsBytes), payloadOffset);
    payloadOffset += speedsBytes;
  }
  bytes.set(altitudePayload.bytes, payloadOffset);
  return {
    bytes,
    distancePayloadBytes: distancePayload,
    powerPayloadBytes: powerPayload.bytes,
    heartRatePayloadBytes: columns.heartRatesBpm,
    cadencePayloadBytes: columns.cadencesRpm,
    speedPayloadBytes: speedsBytes > 0
      ? new Uint8Array(columns.speedsCmS.buffer, columns.speedsCmS.byteOffset, speedsBytes)
      : new Uint8Array(0),
    altitudePayloadBytes: altitudePayload.bytes,
    stats: {
      recordCount,
      usesSpeedFallback: !hasCompleteDistanceSeries,
      speedFallbackRecordCount: hasCompleteDistanceSeries ? 0 : recordCount,
      powerEncoding: powerPayload.stats.encoding,
      powerEscapeCount: powerPayload.stats.escapeCount,
      powerAbsoluteCount: powerPayload.stats.absoluteCount,
      distanceEncoding: "uint8-q02",
      altitudeEncoding: altitudePayload.stats.encoding,
      altitudeRunCount: altitudePayload.stats.runCount || 0,
      cadenceEncoding: "raw8",
      blockBytes: {
        distances: distancesBytes,
        powers: powersBytes,
        heartRates: heartRatesBytes,
        cadences: cadencesBytes,
        speeds: speedsBytes,
        altitudes: altitudesBytes,
      }
    },
  };
}

function buildGpsCoordinatePayloadCompact(points) {
  const chunks = [];
  let totalBytes = 0;
  for (let start = 0; start < points.length; start += 128) {
    const count = Math.min(128, points.length - start);
    let canDeltaEncode = count > 0;
    for (let offset = 1; offset < count; offset += 1) {
      const current = points[start + offset];
      const previous = points[start + offset - 1];
      const deltaLat = current.lat - previous.lat;
      const deltaLng = current.lng - previous.lng;
      if (deltaLat < -32767 || deltaLat > 32767 || deltaLng < -32767 || deltaLng > 32767) {
        canDeltaEncode = false;
        break;
      }
    }
    if (canDeltaEncode) {
      const chunk = new Uint8Array(1 + 2 + 4 + Math.max(0, count - 1) * 2 + 4 + Math.max(0, count - 1) * 2);
      chunk[0] = 1;
      writeUint16LE(chunk, 1, count);
      writeInt32LE(chunk, 3, points[start].lat);
      let writeOffset = 7;
      for (let index = 1; index < count; index += 1) {
        writeInt16LE(chunk, writeOffset, points[start + index].lat - points[start + index - 1].lat);
        writeOffset += 2;
      }
      writeInt32LE(chunk, writeOffset, points[start].lng);
      writeOffset += 4;
      for (let index = 1; index < count; index += 1) {
        writeInt16LE(chunk, writeOffset, points[start + index].lng - points[start + index - 1].lng);
        writeOffset += 2;
      }
      chunks.push(chunk);
      totalBytes += chunk.byteLength;
      continue;
    }
    const chunk = new Uint8Array(1 + 2 + count * 8);
    chunk[0] = 0;
    writeUint16LE(chunk, 1, count);
    let writeOffset = 3;
    for (let index = 0; index < count; index += 1) {
      writeInt32LE(chunk, writeOffset, points[start + index].lat);
      writeOffset += 4;
    }
    for (let index = 0; index < count; index += 1) {
      writeInt32LE(chunk, writeOffset, points[start + index].lng);
      writeOffset += 4;
    }
    chunks.push(chunk);
    totalBytes += chunk.byteLength;
  }
  const payload = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    payload.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return payload;
}

function buildGpsTrackBlockCompact(compact, sampleRateSeconds = 5) {
  const columns = compact.columns;
  const sampleRate = Math.max(1, Math.round(sampleRateSeconds));
  const precision = 5;
  const points = [];
  let firstTimestampMs = 0;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (let index = 0; index < compact.recordCount; index += sampleRate) {
    const latRaw = columns.positionLatsE6[index];
    const lngRaw = columns.positionLongsE6[index];
    if (latRaw === COMPACT_SENTINELS.int32 || lngRaw === COMPACT_SENTINELS.int32 || (latRaw === 0 && lngRaw === 0)) {
      continue;
    }
    const latDeg = Number((latRaw / MICRO_DEGREES).toFixed(precision));
    const lngDeg = Number((lngRaw / MICRO_DEGREES).toFixed(precision));
    const lat = Math.round(latDeg * MICRO_DEGREES);
    const lng = Math.round(lngDeg * MICRO_DEGREES);
    if (points.length === 0) {
      firstTimestampMs = compact.baseTimestampMs + (columns.timestampOffsetsS[index] === COMPACT_SENTINELS.int32 ? 0 : columns.timestampOffsetsS[index] * 1000);
    }
    points.push({ lat, lng });
    if (latDeg < minLat) minLat = latDeg;
    if (latDeg > maxLat) maxLat = latDeg;
    if (lngDeg < minLng) minLng = lngDeg;
    if (lngDeg > maxLng) maxLng = lngDeg;
  }
  const coordinatePayload = buildGpsCoordinatePayloadCompact(points);
  const headerBytes = 4 + 2 + 2 + 4 + 8;
  const bytes = new Uint8Array(headerBytes + coordinatePayload.byteLength);
  bytes.set([71, 80, 83, 50], 0); // GPS2
  writeUint16LE(bytes, 4, 2);
  writeUint16LE(bytes, 6, sampleRate);
  writeUint32LE(bytes, 8, points.length);
  writeFloat64LE(bytes, 12, firstTimestampMs);
  bytes.set(coordinatePayload, headerBytes);
  return {
    bytes,
    gpsTrack: {
      sampleRateSeconds: sampleRate,
      pointCount: points.length,
      bbox: points.length >= 2 ? { minLat, maxLat, minLng, maxLng } : null,
      startPoint: points.length ? { lat: points[0].lat / MICRO_DEGREES, lng: points[0].lng / MICRO_DEGREES } : null,
      endPoint: points.length ? { lat: points[points.length - 1].lat / MICRO_DEGREES, lng: points[points.length - 1].lng / MICRO_DEGREES } : null,
    },
  };
}

function getISOWeekUTC(dateLike) {
  const date = new Date(dateLike);
  const utcDate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = utcDate.getUTCDay() || 7;
  utcDate.setUTCDate(utcDate.getUTCDate() + 4 - dayNum);
  const isoYear = utcDate.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const isoWeek = Math.ceil((((utcDate - yearStart) / 86400000) + 1) / 7);
  return { isoYear, isoWeek };
}

function aggregateSessions(sessions = []) {
  if (!Array.isArray(sessions) || sessions.length === 0) return null;
  const sum = (key) => sessions.reduce((acc, session) => acc + (Number(session?.[key]) || 0), 0);
  const weightedAvg = (key) => {
    const totalTime = sum("total_timer_time");
    if (!totalTime) return 0;
    return sessions.reduce((acc, session) => (
      acc + ((Number(session?.[key]) || 0) * (Number(session?.total_timer_time) || 0))
    ), 0) / totalTime;
  };
  const max = (key) => Math.max(...sessions.map((session) => Number(session?.[key]) || 0));
  const minDate = (key) => new Date(Math.min(...sessions.map((session) => new Date(session?.[key]).getTime()))).toISOString();
  const maxDate = (key) => new Date(Math.max(...sessions.map((session) => new Date(session?.[key]).getTime()))).toISOString();
  const validValues = (key) => sessions
    .map((session) => session?.[key])
    .filter((value) => value != null && Number.isFinite(Number(value)));

  return {
    start_time: minDate("start_time"),
    end_time: maxDate("timestamp"),
    total_elapsed_time: sum("total_elapsed_time"),
    total_timer_time: sum("total_timer_time"),
    total_distance: sum("total_distance"),
    total_cycles: sum("total_cycles"),
    total_work: sum("total_work"),
    total_calories: sum("total_calories"),
    total_ascent: sum("total_ascent"),
    total_descent: sum("total_descent"),
    avg_speed: weightedAvg("avg_speed"),
    avg_power: weightedAvg("avg_power"),
    avg_heart_rate: weightedAvg("avg_heart_rate"),
    avg_cadence: weightedAvg("avg_cadence"),
    max_speed: max("max_speed"),
    max_power: max("max_power"),
    max_heart_rate: max("max_heart_rate"),
    max_cadence: max("max_cadence"),
    nec_lat: Math.max(...validValues("nec_lat")),
    nec_long: Math.max(...validValues("nec_long")),
    swc_lat: Math.min(...validValues("swc_lat")),
    swc_long: Math.min(...validValues("swc_long")),
  };
}

function speedMsToKmh(value) {
  return Number.isFinite(Number(value)) ? Number(value) * 3.6 : 0;
}

function derivePersistedRowCompat(sessions, gpsTrack, sourceName = "") {
  const aggregated = aggregateSessions(sessions);
  if (!aggregated) return null;
  const startDate = new Date(aggregated.start_time);
  const year = startDate.getUTCFullYear();
  const month = startDate.getUTCMonth() + 1;
  const quarter = Math.ceil(month / 3);
  const yearMonth = Number(`${year}${String(month).padStart(2, "0")}`);
  const { isoYear, isoWeek } = getISOWeekUTC(aggregated.start_time);
  const yearWeek = Number(`${isoYear}${String(isoWeek).padStart(2, "0")}`);
  const yearQuarter = year * 10 + quarter;
  const validGps = Number(gpsTrack?.pointCount || 0) > 1;
  const bbox = validGps ? (gpsTrack?.bbox || null) : null;
  const trackStart = validGps ? (gpsTrack?.startPoint || null) : null;
  const trackEnd = validGps ? (gpsTrack?.endPoint || null) : null;
  const firstSession = sessions[0] || {};

  return {
    source_name: sourceName,
    start_time: aggregated.start_time,
    end_time: aggregated.end_time,
    total_elapsed_time: aggregated.total_elapsed_time,
    total_timer_time: aggregated.total_timer_time,
    total_distance: aggregated.total_distance,
    total_cycles: aggregated.total_cycles,
    total_work: aggregated.total_work,
    total_calories: aggregated.total_calories,
    total_ascent: aggregated.total_ascent,
    total_descent: aggregated.total_descent,
    avg_speed: speedMsToKmh(aggregated.avg_speed),
    max_speed: speedMsToKmh(aggregated.max_speed),
    avg_power: aggregated.avg_power,
    max_power: aggregated.max_power,
    avg_normalized_power: Math.round(Number(firstSession?.normalized_power) || 0),
    avg_heart_rate: aggregated.avg_heart_rate,
    max_heart_rate: aggregated.max_heart_rate,
    avg_cadence: aggregated.avg_cadence,
    max_cadence: aggregated.max_cadence,
    validGps,
    year,
    month,
    week: isoWeek,
    year_quarter: yearQuarter,
    year_month: yearMonth,
    year_week: yearWeek,
    points_count: validGps ? Number(gpsTrack?.pointCount || 0) : 0,
    sampleRateGPS: validGps ? Number(gpsTrack?.sampleRateSeconds || 1) : 1,
    gps_source: validGps ? (firstSession?.woa_manual_gps ? "manual_lookup" : "recorded") : null,
    bounds: bbox ? { minLat: bbox.minLat, maxLat: bbox.maxLat, minLng: bbox.minLng, maxLng: bbox.maxLng } : null,
    track_start: trackStart ? { lat: trackStart.lat, lng: trackStart.lng } : null,
    track_end: trackEnd ? { lat: trackEnd.lat, lng: trackEnd.lng } : null,
    stream_codec: DEFAULT_STREAM_CODEC,
    gps_track_blob_codec: DEFAULT_GPS_TRACK_CODEC,
  };
}

function deriveSummaryCompat(compact, sessions, gpsTrack, sourceName = "") {
  const normalizedSessions = Array.isArray(sessions) ? sessions : [];
  const firstSession = normalizedSessions[0] || {};
  const recordCount = Number(compact.recordCount || 0);
  const firstTimestamp = recordCount > 0 ? compact.baseTimestampMs : Number.NaN;
  const lastOffset = recordCount > 0 ? compact.columns.timestampOffsetsS[recordCount - 1] : COMPACT_SENTINELS.int32;
  const lastTimestamp = Number.isFinite(firstTimestamp) && lastOffset !== COMPACT_SENTINELS.int32
    ? firstTimestamp + (lastOffset * 1000)
    : Number.NaN;

  return {
    sourceName,
    sourceFormat: "fit",
    recordCount,
    pointsCount: Number(gpsTrack?.pointCount || 0),
    sampleRateGps: Number(gpsTrack?.sampleRateSeconds || 0),
    validGps: Number(gpsTrack?.pointCount || 0) > 1,
    gpsSource: firstSession.woa_manual_gps ? "manual_lookup" : "recorded",
    startTime: Number.isFinite(firstTimestamp) ? new Date(firstTimestamp).toISOString() : null,
    endTime: Number.isFinite(lastTimestamp) ? new Date(lastTimestamp).toISOString() : null,
    totalElapsedTime: firstSession.total_elapsed_time ?? null,
    totalTimerTime: firstSession.total_timer_time ?? null,
    totalDistance: firstSession.total_distance ?? null,
    totalCycles: firstSession.total_cycles ?? null,
    totalWork: firstSession.total_work ?? null,
    totalCalories: firstSession.total_calories ?? null,
    totalAscent: firstSession.total_ascent ?? null,
    totalDescent: firstSession.total_descent ?? null,
    avgSpeed: firstSession.avg_speed ?? null,
    maxSpeed: firstSession.max_speed ?? null,
    avgPower: firstSession.avg_power ?? null,
    maxPower: firstSession.max_power ?? null,
    avgHeartRate: firstSession.avg_heart_rate ?? null,
    maxHeartRate: firstSession.max_heart_rate ?? null,
    avgCadence: firstSession.avg_cadence ?? null,
    maxCadence: firstSession.max_cadence ?? null,
    normalizedPower: firstSession.normalized_power ?? null,
    bbox: gpsTrack?.bbox || null,
    startPoint: gpsTrack?.startPoint || null,
    endPoint: gpsTrack?.endPoint || null,
    persistedRow: derivePersistedRowCompat(normalizedSessions, gpsTrack, sourceName),
  };
}


function createWoa1FileFromCompact(compact, {
  sourceName = "",
  sessions = [],
  sampleRateSeconds = 5,
  gzipLevel = 4,
  powerEncoding = "raw16",
  distanceEncoding = "default",
  altitudeEncoding = "raw16",
  cadenceEncoding = "raw8",
} = {}) {
  const rawBuildStartedAt = performance.now();
  let workoutStreamBlock;
  if (powerEncoding === "delta16" && distanceEncoding === "uint8-q02" && altitudeEncoding === "rle1m") {
    workoutStreamBlock = buildWorkoutStreamBlockCompactDelta16PowerDistanceUint8Q02AltitudeRle(compact);
  } else if (powerEncoding === "delta16" && distanceEncoding === "uint8-q02" && altitudeEncoding === "delta8") {
    workoutStreamBlock = buildWorkoutStreamBlockCompactDelta16PowerDistanceUint8Q02AltitudeInt8(compact);
  } else if (powerEncoding === "delta16" && distanceEncoding === "uint8-q05") {
    workoutStreamBlock = buildWorkoutStreamBlockCompactDelta16PowerDistanceUint8Q05(compact);
  } else if (powerEncoding === "delta16" && distanceEncoding === "uint8-q02") {
    workoutStreamBlock = buildWorkoutStreamBlockCompactDelta16PowerDistanceUint8Q02(compact);
  } else if (distanceEncoding === "uint8-q05") {
    workoutStreamBlock = buildWorkoutStreamBlockCompactDistanceUint8Q05(compact);
  } else if (powerEncoding === "delta16") {
    workoutStreamBlock = buildWorkoutStreamBlockCompactDelta16Power(compact);
  } else if (distanceEncoding === "uint8-q02") {
    workoutStreamBlock = buildWorkoutStreamBlockCompactDistanceUint8Q02(compact);
  } else {
    workoutStreamBlock = buildWorkoutStreamBlockCompact(compact);
  }
  const workoutStreamRawBytes = workoutStreamBlock.bytes;
  const gpsResult = buildGpsTrackBlockCompact(compact, sampleRateSeconds);
  const gpsTrackRawBytes = gpsResult.bytes;
  const rawBuildMs = performance.now() - rawBuildStartedAt;
  const workoutGzipStartedAt = performance.now();
  const workoutStreamBytes = gzipSync(workoutStreamRawBytes, { level: gzipLevel });
  const workoutGzipMs = performance.now() - workoutGzipStartedAt;
  const gpsGzipStartedAt = performance.now();
  const gpsTrackBytes = gzipSync(gpsTrackRawBytes, { level: gzipLevel });
  const gpsGzipMs = performance.now() - gpsGzipStartedAt;
  const gzipMs = workoutGzipMs + gpsGzipMs;
  const assembleStartedAt = performance.now();
  const summary = deriveSummaryCompat(compact, sessions, gpsResult.gpsTrack, sourceName);
  if (summary?.persistedRow) {
    summary.persistedRow.stream_codec = DEFAULT_STREAM_CODEC;
    summary.persistedRow.gps_track_blob_codec = DEFAULT_GPS_TRACK_CODEC;
  }
  summary.blockCodecs = { workout_stream: DEFAULT_STREAM_CODEC, gps_track: DEFAULT_GPS_TRACK_CODEC };
  summary.blockBytes = {
    workout_stream_raw: workoutStreamRawBytes.byteLength,
    workout_stream_compressed: workoutStreamBytes.byteLength,
    gps_track_raw: gpsTrackRawBytes.byteLength,
    gps_track_compressed: gpsTrackBytes.byteLength,
  };
  summary.blockStats = { workout_stream: workoutStreamBlock.stats };
  const metaBytes = new TextEncoder().encode(JSON.stringify(summary));
  const sessionBytes = encodeSessionBlockCompat(sessions);
  const headerLength = 24;
  const bytes = new Uint8Array(headerLength + metaBytes.byteLength + sessionBytes.byteLength + workoutStreamBytes.byteLength + gpsTrackBytes.byteLength);
  bytes.set([87, 79, 65, 49], 0); // WOA1
  bytes[4] = 2;
  bytes[5] = 0;
  writeUint16LE(bytes, 6, 0);
  writeUint32LE(bytes, 8, metaBytes.byteLength);
  writeUint32LE(bytes, 12, sessionBytes.byteLength);
  writeUint32LE(bytes, 16, workoutStreamBytes.byteLength);
  writeUint32LE(bytes, 20, gpsTrackBytes.byteLength);
  let offset = headerLength;
  bytes.set(metaBytes, offset);
  offset += metaBytes.byteLength;
  bytes.set(sessionBytes, offset);
  offset += sessionBytes.byteLength;
  bytes.set(workoutStreamBytes, offset);
  offset += workoutStreamBytes.byteLength;
  bytes.set(gpsTrackBytes, offset);
  const assembleMs = performance.now() - assembleStartedAt;
  return {
    bytes,
    workoutStreamBlock,
    workoutStreamBytes,
    gpsTrackBytes,
    gpsTrack: gpsResult.gpsTrack,
    blockStats: {
      workout_stream: workoutStreamBlock.stats,
    },
    timings: { rawBuildMs, gzipMs, workoutGzipMs, gpsGzipMs, assembleMs },
  };
}

const options = parseArgs(process.argv.slice(2));
const filePath = path.resolve(options.file);

console.log(`File: ${filePath}`);
console.log(`Repeats: ${options.repeats}\n`);

for (let run = 1; run <= options.repeats; run += 1) {
  const includeNode64 = options.variant === "node64" || options.variant === "both";
  const includeCompact = options.variant === "compact" || options.variant === "both";
  const totalStartedAt = performance.now();
  const source = await readFile(filePath);
  const readDoneAt = performance.now();

  // unzipSync materializes every entry; its duration is the extraction time.
  const archive = unzipSync(new Uint8Array(source.buffer, source.byteOffset, source.byteLength));
  const unzipDoneAt = performance.now();

  const fitEntries = Object.entries(archive).filter(([name]) => name.toLowerCase().endsWith(".fit"));
  let outputBytes = 0;
  let checksum = 0n;
  let recordCount = 0;
  let sessionCount = 0;
  let parseMs = 0;
  let compactParseMs = 0;
  let compactTypedBytes = 0;
  let compactRecordCount = 0;
  let compactSessionCount = 0;
  let woaBuildMs = 0;
  let woaBytes = 0;
  let workoutStreamBytes = 0;
  let gpsTrackBytes = 0;
  let compactWoaBuildMs = 0;
  let compactWoaBytes = 0;
  let compactWorkoutStreamBytes = 0;
  let compactGpsTrackBytes = 0;
  let compactWoaRawBuildMs = 0;
  let compactWoaGzipMs = 0;
  let compactWorkoutGzipMs = 0;
  let compactGpsGzipMs = 0;
  let compactWoaAssembleMs = 0;
  let compactDistanceRawBytes = 0;
  let compactPowerRawBytes = 0;
  let compactHeartRateRawBytes = 0;
  let compactCadenceRawBytes = 0;
  let compactSpeedRawBytes = 0;
  let compactAltitudeRawBytes = 0;
  let compactDistanceGzipBytes = 0;
  let compactPowerGzipBytes = 0;
  let compactHeartRateGzipBytes = 0;
  let compactCadenceGzipBytes = 0;
  let compactSpeedGzipBytes = 0;
  let compactAltitudeGzipBytes = 0;
  const compactAltitudeSignedInt8EscapeSeries = createSignedInt8EscapeDeltaAnalysis();
  let compactDeltaPowerWoaBuildMs = 0;
  let compactDeltaPowerWoaBytes = 0;
  let compactDeltaPowerWorkoutStreamBytes = 0;
  let compactDeltaPowerRawBuildMs = 0;
  let compactDeltaPowerGzipMs = 0;
  let compactDeltaPowerWorkoutGzipMs = 0;
  let compactDeltaPowerGpsGzipMs = 0;
  let compactDeltaPowerAssembleMs = 0;
  let compactDeltaPowerContainerMs = 0;
  let compactDeltaPowerRawContainerBytes = 0;
  let compactDeltaPowerContainerGzipBytes = 0;
  let compactDeltaPowerEscapes = 0;
  let compactDeltaPowerAbsoluteCount = 0;
  let compactDeltaPowerPowerRawBytes = 0;
  let compactDeltaDistanceWoaBuildMs = 0;
  let compactDeltaDistanceWoaBytes = 0;
  let compactDeltaDistanceWorkoutStreamBytes = 0;
  let compactDeltaDistanceRawBuildMs = 0;
  let compactDeltaDistanceGzipMs = 0;
  let compactDeltaDistanceWorkoutGzipMs = 0;
  let compactDeltaDistanceGpsGzipMs = 0;
  let compactDeltaDistanceAssembleMs = 0;
  let compactDeltaDistanceContainerMs = 0;
  let compactDeltaDistanceRawContainerBytes = 0;
  let compactDeltaDistanceContainerGzipBytes = 0;
  let compactDeltaDistanceRawDistanceBytes = 0;
  let compactDeltaDistance05WoaBuildMs = 0;
  let compactDeltaDistance05WoaBytes = 0;
  let compactDeltaDistance05WorkoutStreamBytes = 0;
  let compactDeltaDistance05RawBuildMs = 0;
  let compactDeltaDistance05GzipMs = 0;
  let compactDeltaDistance05WorkoutGzipMs = 0;
  let compactDeltaDistance05GpsGzipMs = 0;
  let compactDeltaDistance05AssembleMs = 0;
  let compactDeltaDistance05ContainerMs = 0;
  let compactDeltaDistance05RawContainerBytes = 0;
  let compactDeltaDistance05ContainerGzipBytes = 0;
  let compactDeltaDistance05RawDistanceBytes = 0;
  let compactCombinedWoaBuildMs = 0;
  let compactCombinedWoaBytes = 0;
  let compactCombinedWorkoutStreamBytes = 0;
  let compactCombinedRawBuildMs = 0;
  let compactCombinedGzipMs = 0;
  let compactCombinedWorkoutGzipMs = 0;
  let compactCombinedGpsGzipMs = 0;
  let compactCombinedAssembleMs = 0;
  let compactCombinedContainerMs = 0;
  let compactCombinedRawContainerBytes = 0;
  let compactCombinedContainerGzipBytes = 0;
  let compactCombinedRawDistanceBytes = 0;
  let compactCombinedRawPowerBytes = 0;
  let compactCombinedEncodedDistanceBytes = 0;
  let compactCombinedEncodedPowerBytes = 0;
  let compactCombinedEncodedHeartRateBytes = 0;
  let compactCombinedEncodedCadenceBytes = 0;
  let compactCombinedEncodedSpeedBytes = 0;
  let compactCombinedEncodedAltitudeBytes = 0;
  let compactCombinedGzipDistanceBytes = 0;
  let compactCombinedGzipPowerBytes = 0;
  let compactCombinedGzipHeartRateBytes = 0;
  let compactCombinedGzipCadenceBytes = 0;
  let compactCombinedGzipSpeedBytes = 0;
  let compactCombinedGzipAltitudeBytes = 0;
  let compactCombinedPowerEscapes = 0;
  let compactCombinedPowerAbsoluteCount = 0;
  let compactCombinedAltWoaBuildMs = 0;
  let compactCombinedAltWoaBytes = 0;
  let compactCombinedAltWorkoutStreamBytes = 0;
  let compactCombinedAltRawBuildMs = 0;
  let compactCombinedAltGzipMs = 0;
  let compactCombinedAltWorkoutGzipMs = 0;
  let compactCombinedAltGpsGzipMs = 0;
  let compactCombinedAltAssembleMs = 0;
  let compactCombinedAltContainerMs = 0;
  let compactCombinedAltRawContainerBytes = 0;
  let compactCombinedAltContainerGzipBytes = 0;
  let compactCombinedAltEncodedAltitudeBytes = 0;
  let compactCombinedAltGzipAltitudeBytes = 0;
  let compactCombinedAltAltitudeEscapes = 0;
  let compactCombinedAltAltitudeAbsoluteCount = 0;
  let compactCombinedAltCadenceRleWoaBuildMs = 0;
  let compactCombinedAltCadenceRleWoaBytes = 0;
  let compactCombinedAltCadenceRleWorkoutStreamBytes = 0;
  let compactCombinedAltCadenceRleRawBuildMs = 0;
  let compactCombinedAltCadenceRleGzipMs = 0;
  let compactCombinedAltCadenceRleWorkoutGzipMs = 0;
  let compactCombinedAltCadenceRleGpsGzipMs = 0;
  let compactCombinedAltCadenceRleAssembleMs = 0;
  let compactCombinedAltCadenceRleContainerMs = 0;
  let compactCombinedAltCadenceRleRawContainerBytes = 0;
  let compactCombinedAltCadenceRleContainerGzipBytes = 0;
  let compactCombinedAltCadenceRleEncodedCadenceBytes = 0;
  let compactCombinedAltCadenceRleGzipCadenceBytes = 0;
  const compactPowerSeries = createSeriesAnalysis();
  const compactDistanceSeries = createSeriesAnalysis();
  const compactDistanceDeltaSeries = createNonNegativeDeltaAnalysis();
  const compactDistanceDelta02mInt8Series = {
    deltaCount: 0,
    int8FitCount: 0,
    escapeCount: 0,
    zeroCount: 0,
    minDelta: Infinity,
    maxDelta: -Infinity,
  };
  const compactDistanceDelta02mUint8EscapeSeries = createUint8EscapeDeltaAnalysis();
  const compactPowerDeltaSeries = createNonNegativeDeltaAnalysis();
  const compactPowerSignedDeltaSeries = createSignedDeltaAnalysis();
  const compactPowerSignedInt8EscapeSeries = createSignedInt8EscapeDeltaAnalysis();
  const compactCadenceSeries = createSeriesAnalysis();
  const compactHrSeries = createSeriesAnalysis();
  const compactAltitudeSeries = createSeriesAnalysis();
  const compactCadenceDict = createByteDictionaryAnalysis();
  const compactHrDict = createByteDictionaryAnalysis();
  const compactAltitudeDict = createByteDictionaryAnalysis();
  const compactCadenceRle = createRunLengthAnalysis();
  const compactHrRle = createRunLengthAnalysis();
  const compactAltitudeRle = createRunLengthAnalysis();
  let quantizedPowerSamples = 0;
  let quantizedCadenceSamples = 0;
  let quantizedHrSamples = 0;
  let compactQuantizedPowerSamples = 0;
  let compactQuantizedCadenceSamples = 0;
  let compactQuantizedHrSamples = 0;
  const outputEntries = [];
  const compactOutputEntries = [];
  const compactDeltaPowerOutputEntries = [];
  const compactDeltaDistanceOutputEntries = [];
  const compactDeltaDistance05OutputEntries = [];
  const compactCombinedOutputEntries = [];
  const compactCombinedAltOutputEntries = [];
  const compactCombinedAltCadenceRleOutputEntries = [];
  const checksumMask = (1n << 64n) - 1n;
  for (const [name, bytes] of fitEntries) {
    outputBytes += bytes.byteLength;
    if (bytes.byteLength > 0) {
      checksum = (checksum * 131n + BigInt(bytes[0]) + BigInt(bytes[bytes.byteLength - 1])) & checksumMask;
    }
    let parsed = null;
    if (includeNode64) {
      const parseStartedAt = performance.now();
      parsed = parseFitBufferTyped(bytes);
      parseMs += performance.now() - parseStartedAt;
      const quantized = applySeriesQuantization(parsed, {
        powerStep: options.powerStep,
        cadenceStep: options.cadenceStep,
        hrStep: options.hrStep,
      });
      parsed = quantized.parsed;
      quantizedPowerSamples += Number(quantized.stats.quantizedPowerSamples || 0);
      quantizedCadenceSamples += Number(quantized.stats.quantizedCadenceSamples || 0);
      quantizedHrSamples += Number(quantized.stats.quantizedHrSamples || 0);
      recordCount += Number(parsed?.recordsTyped?.recordCount || 0);
      sessionCount += Array.isArray(parsed?.sessions) ? parsed.sessions.length : 0;
    }

    if (includeCompact) {
      const compactStartedAt = performance.now();
      let compact = parseFitBufferCompactFast(bytes);
      compactParseMs += performance.now() - compactStartedAt;
      const quantizedCompact = applyCompactQuantization(compact, {
        powerStep: options.powerStep,
        cadenceStep: options.cadenceStep,
        hrStep: options.hrStep,
      });
      compact = quantizedCompact.compact;
      compactQuantizedPowerSamples += Number(quantizedCompact.stats.quantizedPowerSamples || 0);
      compactQuantizedCadenceSamples += Number(quantizedCompact.stats.quantizedCadenceSamples || 0);
      compactQuantizedHrSamples += Number(quantizedCompact.stats.quantizedHrSamples || 0);
      compactTypedBytes += compact.typedBytes;
      compactRecordCount += compact.recordCount;
      compactSessionCount += compact.sessionCount;
      mergeSeriesAnalysis(compactDistanceSeries, analyzeCompactSeries(compact.columns.distancesQ, COMPACT_SENTINELS.uint32));
      mergeNonNegativeDeltaAnalysis(
        compactDistanceDeltaSeries,
        analyzeNonNegativeDeltas(compact.columns.distancesQ, COMPACT_SENTINELS.uint32),
      );
      mergeInt8DeltaFitAnalysis(
        compactDistanceDelta02mInt8Series,
        analyzeDistanceDeltasForScale(compact.columns.distancesQ, COMPACT_SENTINELS.uint32, 2),
      );
      mergeUint8EscapeDeltaAnalysis(
        compactDistanceDelta02mUint8EscapeSeries,
        analyzeUint8EscapeDeltas(compact.columns.distancesQ, COMPACT_SENTINELS.uint32, 2, 255),
      );
      mergeSeriesAnalysis(compactPowerSeries, analyzeCompactSeries(compact.columns.powersW, COMPACT_SENTINELS.uint16));
      mergeNonNegativeDeltaAnalysis(
        compactPowerDeltaSeries,
        analyzeNonNegativeDeltas(compact.columns.powersW, COMPACT_SENTINELS.uint16),
      );
      mergeSignedDeltaAnalysis(
        compactPowerSignedDeltaSeries,
        analyzeSignedDeltas(compact.columns.powersW, COMPACT_SENTINELS.uint16),
      );
      mergeSignedInt8EscapeDeltaAnalysis(
        compactPowerSignedInt8EscapeSeries,
        analyzeSignedInt8EscapeDeltas(compact.columns.powersW, COMPACT_SENTINELS.uint16, 127, options.powerStep),
      );
      mergeSeriesAnalysis(compactCadenceSeries, analyzeCompactSeries(compact.columns.cadencesRpm, COMPACT_SENTINELS.uint8));
      mergeSeriesAnalysis(compactHrSeries, analyzeCompactSeries(compact.columns.heartRatesBpm, COMPACT_SENTINELS.uint8));
      mergeSeriesAnalysis(compactAltitudeSeries, analyzeCompactSeries(compact.columns.altitudesQ, COMPACT_SENTINELS.int16));
      mergeByteDictionaryAnalysis(compactCadenceDict, compact.columns.cadencesRpm, COMPACT_SENTINELS.uint8);
      mergeByteDictionaryAnalysis(compactHrDict, compact.columns.heartRatesBpm, COMPACT_SENTINELS.uint8);
      mergeByteDictionaryAnalysis(compactAltitudeDict, compact.columns.altitudesQ, COMPACT_SENTINELS.int16);
      mergeRunLengthAnalysis(compactCadenceRle, compact.columns.cadencesRpm, COMPACT_SENTINELS.uint8);
      mergeRunLengthAnalysis(compactHrRle, compact.columns.heartRatesBpm, COMPACT_SENTINELS.uint8);
      mergeRunLengthAnalysis(compactAltitudeRle, compact.columns.altitudesQ, COMPACT_SENTINELS.int16);
      mergeSignedInt8EscapeDeltaAnalysis(
        compactAltitudeSignedInt8EscapeSeries,
        analyzeSignedInt8EscapeDeltas(compact.columns.altitudesQ, COMPACT_SENTINELS.int16, 127, 4),
      );

      const compactWoaStartedAt = performance.now();
      const compactWoa = createWoa1FileFromCompact(compact, {
        sourceName: name,
        sessions: compact.sessions || [],
        sampleRateSeconds: 5,
        gzipLevel: options.gzipLevel,
      });
      compactWoaBuildMs += performance.now() - compactWoaStartedAt;
      compactWoaBytes += compactWoa.bytes.byteLength;
      compactWorkoutStreamBytes += compactWoa.workoutStreamBytes.byteLength;
      compactGpsTrackBytes += compactWoa.gpsTrackBytes.byteLength;
      compactWoaRawBuildMs += compactWoa.timings.rawBuildMs;
      compactWoaGzipMs += compactWoa.timings.gzipMs;
      compactWorkoutGzipMs += compactWoa.timings.workoutGzipMs;
      compactGpsGzipMs += compactWoa.timings.gpsGzipMs;
      compactWoaAssembleMs += compactWoa.timings.assembleMs;
      compactDistanceRawBytes += Number(compactWoa?.blockStats?.workout_stream?.blockBytes?.distances || 0);
      compactPowerRawBytes += Number(compactWoa?.blockStats?.workout_stream?.blockBytes?.powers || 0);
      compactHeartRateRawBytes += Number(compactWoa?.blockStats?.workout_stream?.blockBytes?.heartRates || 0);
      compactCadenceRawBytes += Number(compactWoa?.blockStats?.workout_stream?.blockBytes?.cadences || 0);
      compactSpeedRawBytes += Number(compactWoa?.blockStats?.workout_stream?.blockBytes?.speeds || 0);
      compactAltitudeRawBytes += Number(compactWoa?.blockStats?.workout_stream?.blockBytes?.altitudes || 0);
      compactDistanceGzipBytes += gzipByteLength(compactWoa.workoutStreamBlock.distancePayloadBytes, options.gzipLevel);
      compactPowerGzipBytes += gzipByteLength(compactWoa.workoutStreamBlock.powerPayloadBytes, options.gzipLevel);
      compactHeartRateGzipBytes += gzipByteLength(compactWoa.workoutStreamBlock.heartRatePayloadBytes, options.gzipLevel);
      compactCadenceGzipBytes += gzipByteLength(compactWoa.workoutStreamBlock.cadencePayloadBytes, options.gzipLevel);
      compactSpeedGzipBytes += gzipByteLength(compactWoa.workoutStreamBlock.speedPayloadBytes, options.gzipLevel);
      compactAltitudeGzipBytes += gzipByteLength(compactWoa.workoutStreamBlock.altitudePayloadBytes, options.gzipLevel);
      compactOutputEntries.push({
        name: name.replace(/\.fit$/i, ".woa1"),
        bytes: compactWoa.bytes,
      });

      const compactDeltaPowerStartedAt = performance.now();
      const compactDeltaPowerWoa = createWoa1FileFromCompact(compact, {
        sourceName: name,
        sessions: compact.sessions || [],
        sampleRateSeconds: 5,
        gzipLevel: options.gzipLevel,
        powerEncoding: "delta16",
      });
      compactDeltaPowerWoaBuildMs += performance.now() - compactDeltaPowerStartedAt;
      compactDeltaPowerWoaBytes += compactDeltaPowerWoa.bytes.byteLength;
      compactDeltaPowerWorkoutStreamBytes += compactDeltaPowerWoa.workoutStreamBytes.byteLength;
      compactDeltaPowerRawBuildMs += compactDeltaPowerWoa.timings.rawBuildMs;
      compactDeltaPowerGzipMs += compactDeltaPowerWoa.timings.gzipMs;
      compactDeltaPowerWorkoutGzipMs += compactDeltaPowerWoa.timings.workoutGzipMs;
      compactDeltaPowerGpsGzipMs += compactDeltaPowerWoa.timings.gpsGzipMs;
      compactDeltaPowerAssembleMs += compactDeltaPowerWoa.timings.assembleMs;
      compactDeltaPowerPowerRawBytes += Number(compactDeltaPowerWoa?.blockStats?.workout_stream?.blockBytes?.powers || 0);
      compactDeltaPowerEscapes += Number(compactDeltaPowerWoa?.blockStats?.workout_stream?.powerEscapeCount || 0);
      compactDeltaPowerAbsoluteCount += Number(compactDeltaPowerWoa?.blockStats?.workout_stream?.powerAbsoluteCount || 0);
      compactDeltaPowerOutputEntries.push({
        name: name.replace(/\.fit$/i, ".woa1"),
        bytes: compactDeltaPowerWoa.bytes,
      });

      const compactDeltaDistanceStartedAt = performance.now();
      const compactDeltaDistanceWoa = createWoa1FileFromCompact(compact, {
        sourceName: name,
        sessions: compact.sessions || [],
        sampleRateSeconds: 5,
        gzipLevel: options.gzipLevel,
        powerEncoding: "raw16",
        distanceEncoding: "uint8-q02",
      });
      compactDeltaDistanceWoaBuildMs += performance.now() - compactDeltaDistanceStartedAt;
      compactDeltaDistanceWoaBytes += compactDeltaDistanceWoa.bytes.byteLength;
      compactDeltaDistanceWorkoutStreamBytes += compactDeltaDistanceWoa.workoutStreamBytes.byteLength;
      compactDeltaDistanceRawBuildMs += compactDeltaDistanceWoa.timings.rawBuildMs;
      compactDeltaDistanceGzipMs += compactDeltaDistanceWoa.timings.gzipMs;
      compactDeltaDistanceWorkoutGzipMs += compactDeltaDistanceWoa.timings.workoutGzipMs;
      compactDeltaDistanceGpsGzipMs += compactDeltaDistanceWoa.timings.gpsGzipMs;
      compactDeltaDistanceAssembleMs += compactDeltaDistanceWoa.timings.assembleMs;
      compactDeltaDistanceRawDistanceBytes += Number(compactDeltaDistanceWoa?.blockStats?.workout_stream?.blockBytes?.distances || 0);
      compactDeltaDistanceOutputEntries.push({
        name: name.replace(/\.fit$/i, ".woa1"),
        bytes: compactDeltaDistanceWoa.bytes,
      });

      const compactDeltaDistance05StartedAt = performance.now();
      const compactDeltaDistance05Woa = createWoa1FileFromCompact(compact, {
        sourceName: name,
        sessions: compact.sessions || [],
        sampleRateSeconds: 5,
        gzipLevel: options.gzipLevel,
        powerEncoding: "raw16",
        distanceEncoding: "uint8-q05",
      });
      compactDeltaDistance05WoaBuildMs += performance.now() - compactDeltaDistance05StartedAt;
      compactDeltaDistance05WoaBytes += compactDeltaDistance05Woa.bytes.byteLength;
      compactDeltaDistance05WorkoutStreamBytes += compactDeltaDistance05Woa.workoutStreamBytes.byteLength;
      compactDeltaDistance05RawBuildMs += compactDeltaDistance05Woa.timings.rawBuildMs;
      compactDeltaDistance05GzipMs += compactDeltaDistance05Woa.timings.gzipMs;
      compactDeltaDistance05WorkoutGzipMs += compactDeltaDistance05Woa.timings.workoutGzipMs;
      compactDeltaDistance05GpsGzipMs += compactDeltaDistance05Woa.timings.gpsGzipMs;
      compactDeltaDistance05AssembleMs += compactDeltaDistance05Woa.timings.assembleMs;
      compactDeltaDistance05RawDistanceBytes += Number(compactDeltaDistance05Woa?.blockStats?.workout_stream?.blockBytes?.distances || 0);
      compactDeltaDistance05OutputEntries.push({
        name: name.replace(/\.fit$/i, ".woa1"),
        bytes: compactDeltaDistance05Woa.bytes,
      });

      const compactCombinedStartedAt = performance.now();
      const compactCombinedWoa = createWoa1FileFromCompact(compact, {
        sourceName: name,
        sessions: compact.sessions || [],
        sampleRateSeconds: 5,
        gzipLevel: options.gzipLevel,
        powerEncoding: "delta16",
        distanceEncoding: "uint8-q02",
      });
      compactCombinedWoaBuildMs += performance.now() - compactCombinedStartedAt;
      compactCombinedWoaBytes += compactCombinedWoa.bytes.byteLength;
      compactCombinedWorkoutStreamBytes += compactCombinedWoa.workoutStreamBytes.byteLength;
      compactCombinedRawBuildMs += compactCombinedWoa.timings.rawBuildMs;
      compactCombinedGzipMs += compactCombinedWoa.timings.gzipMs;
      compactCombinedWorkoutGzipMs += compactCombinedWoa.timings.workoutGzipMs;
      compactCombinedGpsGzipMs += compactCombinedWoa.timings.gpsGzipMs;
      compactCombinedAssembleMs += compactCombinedWoa.timings.assembleMs;
      compactCombinedRawDistanceBytes += Number(compactCombinedWoa?.blockStats?.workout_stream?.blockBytes?.distances || 0);
      compactCombinedRawPowerBytes += Number(compactCombinedWoa?.blockStats?.workout_stream?.blockBytes?.powers || 0);
      compactCombinedEncodedDistanceBytes += Number(compactCombinedWoa?.blockStats?.workout_stream?.blockBytes?.distances || 0);
      compactCombinedEncodedPowerBytes += Number(compactCombinedWoa?.blockStats?.workout_stream?.blockBytes?.powers || 0);
      compactCombinedEncodedHeartRateBytes += Number(compactCombinedWoa?.blockStats?.workout_stream?.blockBytes?.heartRates || 0);
      compactCombinedEncodedCadenceBytes += Number(compactCombinedWoa?.blockStats?.workout_stream?.blockBytes?.cadences || 0);
      compactCombinedEncodedSpeedBytes += Number(compactCombinedWoa?.blockStats?.workout_stream?.blockBytes?.speeds || 0);
      compactCombinedEncodedAltitudeBytes += Number(compactCombinedWoa?.blockStats?.workout_stream?.blockBytes?.altitudes || 0);
      compactCombinedGzipDistanceBytes += gzipByteLength(compactCombinedWoa.workoutStreamBlock.distancePayloadBytes, options.gzipLevel);
      compactCombinedGzipPowerBytes += gzipByteLength(compactCombinedWoa.workoutStreamBlock.powerPayloadBytes, options.gzipLevel);
      compactCombinedGzipHeartRateBytes += gzipByteLength(compactCombinedWoa.workoutStreamBlock.heartRatePayloadBytes, options.gzipLevel);
      compactCombinedGzipCadenceBytes += gzipByteLength(compactCombinedWoa.workoutStreamBlock.cadencePayloadBytes, options.gzipLevel);
      compactCombinedGzipSpeedBytes += gzipByteLength(compactCombinedWoa.workoutStreamBlock.speedPayloadBytes, options.gzipLevel);
      compactCombinedGzipAltitudeBytes += gzipByteLength(compactCombinedWoa.workoutStreamBlock.altitudePayloadBytes, options.gzipLevel);
      compactCombinedPowerEscapes += Number(compactCombinedWoa?.blockStats?.workout_stream?.powerEscapeCount || 0);
      compactCombinedPowerAbsoluteCount += Number(compactCombinedWoa?.blockStats?.workout_stream?.powerAbsoluteCount || 0);
      compactCombinedOutputEntries.push({
        name: name.replace(/\.fit$/i, ".woa1"),
        bytes: compactCombinedWoa.bytes,
      });

      const compactCombinedAltStartedAt = performance.now();
      const compactCombinedAltWoa = createWoa1FileFromCompact(compact, {
        sourceName: name,
        sessions: compact.sessions || [],
        sampleRateSeconds: 5,
        gzipLevel: options.gzipLevel,
        powerEncoding: "delta16",
        distanceEncoding: "uint8-q02",
        altitudeEncoding: "delta8",
      });
      compactCombinedAltWoaBuildMs += performance.now() - compactCombinedAltStartedAt;
      compactCombinedAltWoaBytes += compactCombinedAltWoa.bytes.byteLength;
      compactCombinedAltWorkoutStreamBytes += compactCombinedAltWoa.workoutStreamBytes.byteLength;
      compactCombinedAltRawBuildMs += compactCombinedAltWoa.timings.rawBuildMs;
      compactCombinedAltGzipMs += compactCombinedAltWoa.timings.gzipMs;
      compactCombinedAltWorkoutGzipMs += compactCombinedAltWoa.timings.workoutGzipMs;
      compactCombinedAltGpsGzipMs += compactCombinedAltWoa.timings.gpsGzipMs;
      compactCombinedAltAssembleMs += compactCombinedAltWoa.timings.assembleMs;
      compactCombinedAltEncodedAltitudeBytes += Number(compactCombinedAltWoa?.blockStats?.workout_stream?.blockBytes?.altitudes || 0);
      compactCombinedAltGzipAltitudeBytes += gzipByteLength(compactCombinedAltWoa.workoutStreamBlock.altitudePayloadBytes, options.gzipLevel);
      compactCombinedAltAltitudeEscapes += Number(compactCombinedAltWoa?.blockStats?.workout_stream?.altitudeEscapeCount || 0);
      compactCombinedAltAltitudeAbsoluteCount += Number(compactCombinedAltWoa?.blockStats?.workout_stream?.altitudeAbsoluteCount || 0);
      compactCombinedAltOutputEntries.push({
        name: name.replace(/\.fit$/i, ".woa1"),
        bytes: compactCombinedAltWoa.bytes,
      });

      const compactCombinedAltCadenceRleStartedAt = performance.now();
      const compactCombinedAltCadenceRleWoa = createWoa1FileFromCompact(compact, {
        sourceName: name,
        sessions: compact.sessions || [],
        sampleRateSeconds: 5,
        gzipLevel: options.gzipLevel,
        powerEncoding: "delta16",
        distanceEncoding: "uint8-q02",
        altitudeEncoding: "rle1m",
      });
      compactCombinedAltCadenceRleWoaBuildMs += performance.now() - compactCombinedAltCadenceRleStartedAt;
      compactCombinedAltCadenceRleWoaBytes += compactCombinedAltCadenceRleWoa.bytes.byteLength;
      compactCombinedAltCadenceRleWorkoutStreamBytes += compactCombinedAltCadenceRleWoa.workoutStreamBytes.byteLength;
      compactCombinedAltCadenceRleRawBuildMs += compactCombinedAltCadenceRleWoa.timings.rawBuildMs;
      compactCombinedAltCadenceRleGzipMs += compactCombinedAltCadenceRleWoa.timings.gzipMs;
      compactCombinedAltCadenceRleWorkoutGzipMs += compactCombinedAltCadenceRleWoa.timings.workoutGzipMs;
      compactCombinedAltCadenceRleGpsGzipMs += compactCombinedAltCadenceRleWoa.timings.gpsGzipMs;
      compactCombinedAltCadenceRleAssembleMs += compactCombinedAltCadenceRleWoa.timings.assembleMs;
      compactCombinedAltCadenceRleEncodedCadenceBytes += Number(
        compactCombinedAltCadenceRleWoa?.blockStats?.workout_stream?.blockBytes?.altitudes || 0,
      );
      compactCombinedAltCadenceRleGzipCadenceBytes += gzipByteLength(
        compactCombinedAltCadenceRleWoa.workoutStreamBlock.altitudePayloadBytes,
        options.gzipLevel,
      );
      compactCombinedAltCadenceRleOutputEntries.push({
        name: name.replace(/\.fit$/i, ".woa1"),
        bytes: compactCombinedAltCadenceRleWoa.bytes,
      });
    }

    if (includeNode64) {
      const woaStartedAt = performance.now();
      const woa = createWoa1File(parsed, {
        sourceName: name,
        sampleRateSeconds: 5,
        compressWorkoutStream: (rawBytes, gzipOptions = {}) => gzipSync(rawBytes, { level: options.gzipLevel, ...gzipOptions }),
        compressGpsTrack: (rawBytes, gzipOptions = {}) => gzipSync(rawBytes, { level: options.gzipLevel, ...gzipOptions }),
      });
      woaBuildMs += performance.now() - woaStartedAt;
      woaBytes += woa.bytes.byteLength;
      workoutStreamBytes += woa.workoutStreamBytes.byteLength;
      gpsTrackBytes += woa.gpsTrackBytes.byteLength;
      outputEntries.push({
        name: name.replace(/\.fit$/i, ".woa1"),
        bytes: woa.bytes,
      });
    }
  }

  let rawContainerBytes = new Uint8Array();
  let gzipContainerBytes = new Uint8Array();
  let node64ContainerMs = 0;
  let compactRawContainerBytes = new Uint8Array();
  let compactGzipContainerBytes = new Uint8Array();
  let compactContainerMs = 0;
  if (includeNode64) {
    const containerStartedAt = performance.now();
    rawContainerBytes = encodeWoaTransportContainer(outputEntries);
    gzipContainerBytes = gzipSync(rawContainerBytes, { level: options.gzipLevel });
    node64ContainerMs = performance.now() - containerStartedAt;
  }
  if (includeCompact) {
    const compactContainerStartedAt = performance.now();
    compactRawContainerBytes = encodeWoaTransportContainer(compactOutputEntries);
    compactGzipContainerBytes = gzipSync(compactRawContainerBytes, { level: options.gzipLevel });
    compactContainerMs = performance.now() - compactContainerStartedAt;
    const compactDeltaPowerContainerStartedAt = performance.now();
    const compactDeltaPowerRawContainer = encodeWoaTransportContainer(compactDeltaPowerOutputEntries);
    const compactDeltaPowerGzipContainer = gzipSync(compactDeltaPowerRawContainer, { level: options.gzipLevel });
    compactDeltaPowerContainerMs = performance.now() - compactDeltaPowerContainerStartedAt;
    compactDeltaPowerRawContainerBytes = compactDeltaPowerRawContainer.byteLength;
    compactDeltaPowerContainerGzipBytes = compactDeltaPowerGzipContainer.byteLength;
    const compactDeltaDistanceContainerStartedAt = performance.now();
    const compactDeltaDistanceRawContainer = encodeWoaTransportContainer(compactDeltaDistanceOutputEntries);
    const compactDeltaDistanceGzipContainer = gzipSync(compactDeltaDistanceRawContainer, { level: options.gzipLevel });
    compactDeltaDistanceContainerMs = performance.now() - compactDeltaDistanceContainerStartedAt;
    compactDeltaDistanceRawContainerBytes = compactDeltaDistanceRawContainer.byteLength;
    compactDeltaDistanceContainerGzipBytes = compactDeltaDistanceGzipContainer.byteLength;
    const compactDeltaDistance05ContainerStartedAt = performance.now();
    const compactDeltaDistance05RawContainer = encodeWoaTransportContainer(compactDeltaDistance05OutputEntries);
    const compactDeltaDistance05GzipContainer = gzipSync(compactDeltaDistance05RawContainer, { level: options.gzipLevel });
    compactDeltaDistance05ContainerMs = performance.now() - compactDeltaDistance05ContainerStartedAt;
    compactDeltaDistance05RawContainerBytes = compactDeltaDistance05RawContainer.byteLength;
    compactDeltaDistance05ContainerGzipBytes = compactDeltaDistance05GzipContainer.byteLength;
    const compactCombinedContainerStartedAt = performance.now();
    const compactCombinedRawContainer = encodeWoaTransportContainer(compactCombinedOutputEntries);
    const compactCombinedGzipContainer = gzipSync(compactCombinedRawContainer, { level: options.gzipLevel });
    compactCombinedContainerMs = performance.now() - compactCombinedContainerStartedAt;
    compactCombinedRawContainerBytes = compactCombinedRawContainer.byteLength;
    compactCombinedContainerGzipBytes = compactCombinedGzipContainer.byteLength;
    const compactCombinedAltContainerStartedAt = performance.now();
    const compactCombinedAltRawContainer = encodeWoaTransportContainer(compactCombinedAltOutputEntries);
    const compactCombinedAltGzipContainer = gzipSync(compactCombinedAltRawContainer, { level: options.gzipLevel });
    compactCombinedAltContainerMs = performance.now() - compactCombinedAltContainerStartedAt;
    compactCombinedAltRawContainerBytes = compactCombinedAltRawContainer.byteLength;
    compactCombinedAltContainerGzipBytes = compactCombinedAltGzipContainer.byteLength;
    const compactCombinedAltCadenceRleContainerStartedAt = performance.now();
    const compactCombinedAltCadenceRleRawContainer = encodeWoaTransportContainer(compactCombinedAltCadenceRleOutputEntries);
    const compactCombinedAltCadenceRleGzipContainer = gzipSync(compactCombinedAltCadenceRleRawContainer, {
      level: options.gzipLevel,
    });
    compactCombinedAltCadenceRleContainerMs = performance.now() - compactCombinedAltCadenceRleContainerStartedAt;
    compactCombinedAltCadenceRleRawContainerBytes = compactCombinedAltCadenceRleRawContainer.byteLength;
    compactCombinedAltCadenceRleContainerGzipBytes = compactCombinedAltCadenceRleGzipContainer.byteLength;
  }
  const enumerateDoneAt = performance.now();

  if (run === options.repeats && options.writeOutput) {
    await writeFile(path.resolve(options.writeOutput), gzipContainerBytes);
  }

  const readMs = readDoneAt - totalStartedAt;
  const unzipMs = unzipDoneAt - readDoneAt;
  const enumerateMs = enumerateDoneAt - unzipDoneAt;
  const totalMs = enumerateDoneAt - totalStartedAt;
  const outputMiB = outputBytes / 1024 / 1024;
  const commonInputMs = readMs + unzipMs;
  const node64ReadyMs = includeNode64 ? commonInputMs + parseMs + woaBuildMs + node64ContainerMs : 0;
  const compactReadyMs = includeCompact ? commonInputMs + compactParseMs + compactWoaBuildMs + compactContainerMs : 0;
  const compactDeltaPowerReadyMs =
    includeCompact ? commonInputMs + compactParseMs + compactDeltaPowerWoaBuildMs + compactDeltaPowerContainerMs : 0;
  const compactDeltaDistanceReadyMs =
    includeCompact ? commonInputMs + compactParseMs + compactDeltaDistanceWoaBuildMs + compactDeltaDistanceContainerMs : 0;
  const compactDeltaDistance05ReadyMs =
    includeCompact ? commonInputMs + compactParseMs + compactDeltaDistance05WoaBuildMs + compactDeltaDistance05ContainerMs : 0;
  const compactCombinedReadyMs =
    includeCompact ? commonInputMs + compactParseMs + compactCombinedWoaBuildMs + compactCombinedContainerMs : 0;
  const compactCombinedAltReadyMs =
    includeCompact ? commonInputMs + compactParseMs + compactCombinedAltWoaBuildMs + compactCombinedAltContainerMs : 0;
  const compactCombinedAltCadenceRleReadyMs =
    includeCompact
      ? commonInputMs + compactParseMs + compactCombinedAltCadenceRleWoaBuildMs + compactCombinedAltCadenceRleContainerMs
      : 0;

  console.log(
    `Run ${run}: read=${formatMs(readMs)} ms, unzip=${formatMs(unzipMs)} ms, ` +
      `enumerate=${formatMs(enumerateMs)} ms, total=${formatMs(totalMs)} ms, ` +
      `entries=${fitEntries.length}, output=${outputMiB.toFixed(2)} MiB, ` +
      `variant=${options.variant}, gzipLevel=${options.gzipLevel}, commonInput=${formatMs(commonInputMs)} ms, ` +
      `steps=${options.powerStep}/${options.cadenceStep}/${options.hrStep}, ` +
      `node64Ready=${includeNode64 ? formatMs(node64ReadyMs) : "n/a"} ms, compactReady=${includeCompact ? formatMs(compactReadyMs) : "n/a"} ms, ` +
      `compactDeltaPowerReady=${includeCompact ? formatMs(compactDeltaPowerReadyMs) : "n/a"} ms, ` +
      `compactDeltaDistanceReady=${includeCompact ? formatMs(compactDeltaDistanceReadyMs) : "n/a"} ms, ` +
      `compactDeltaDistance05Ready=${includeCompact ? formatMs(compactDeltaDistance05ReadyMs) : "n/a"} ms, ` +
      `compactCombinedReady=${includeCompact ? formatMs(compactCombinedReadyMs) : "n/a"} ms, ` +
      `compactCombinedAltReady=${includeCompact ? formatMs(compactCombinedAltReadyMs) : "n/a"} ms, ` +
      `compactCombinedAltRleReady=${includeCompact ? formatMs(compactCombinedAltCadenceRleReadyMs) : "n/a"} ms, ` +
      `parse=${formatMs(parseMs)} ms, records=${recordCount}, sessions=${sessionCount}, ` +
      `qPower=${quantizedPowerSamples}, qCadence=${quantizedCadenceSamples}, qHr=${quantizedHrSamples}, ` +
      `compactFastParse=${formatMs(compactParseMs)} ms, compactRecords=${compactRecordCount}, ` +
      `compactSessions=${compactSessionCount}, compactTyped=${(compactTypedBytes / 1024 / 1024).toFixed(2)} MiB, ` +
      `compactQPower=${compactQuantizedPowerSamples}, compactQCadence=${compactQuantizedCadenceSamples}, compactQHr=${compactQuantizedHrSamples}, ` +
      `woa=${formatMs(woaBuildMs)} ms, woaBytes=${(woaBytes / 1024 / 1024).toFixed(2)} MiB, ` +
      `workoutGzip=${(workoutStreamBytes / 1024 / 1024).toFixed(2)} MiB, ` +
      `gpsGzip=${(gpsTrackBytes / 1024 / 1024).toFixed(2)} MiB, ` +
      `compactWoa=${formatMs(compactWoaBuildMs)} ms, compactWoaBytes=${(compactWoaBytes / 1024 / 1024).toFixed(2)} MiB, ` +
      `compactWoaRaw=${formatMs(compactWoaRawBuildMs)} ms, compactWoaGzip=${formatMs(compactWoaGzipMs)} ms, ` +
      `compactWorkoutGzipMs=${formatMs(compactWorkoutGzipMs)} ms, compactGpsGzipMs=${formatMs(compactGpsGzipMs)} ms, ` +
      `compactWoaAssemble=${formatMs(compactWoaAssembleMs)} ms, ` +
      `compactRawBlocksMiB=` +
      `dist:${(compactDistanceRawBytes / 1024 / 1024).toFixed(2)}/` +
      `pow:${(compactPowerRawBytes / 1024 / 1024).toFixed(2)}/` +
      `hr:${(compactHeartRateRawBytes / 1024 / 1024).toFixed(2)}/` +
      `cad:${(compactCadenceRawBytes / 1024 / 1024).toFixed(2)}/` +
      `spd:${(compactSpeedRawBytes / 1024 / 1024).toFixed(2)}/` +
      `alt:${(compactAltitudeRawBytes / 1024 / 1024).toFixed(2)}, ` +
      `compactGzipBlocksMiB=` +
      `dist:${(compactDistanceGzipBytes / 1024 / 1024).toFixed(2)}/` +
      `pow:${(compactPowerGzipBytes / 1024 / 1024).toFixed(2)}/` +
      `hr:${(compactHeartRateGzipBytes / 1024 / 1024).toFixed(2)}/` +
      `cad:${(compactCadenceGzipBytes / 1024 / 1024).toFixed(2)}/` +
      `spd:${(compactSpeedGzipBytes / 1024 / 1024).toFixed(2)}/` +
      `alt:${(compactAltitudeGzipBytes / 1024 / 1024).toFixed(2)}, ` +
      `compactSeries=` +
      `${formatSeriesAnalysis("dist", compactDistanceSeries)}/` +
      `${formatNonNegativeDeltaAnalysis("distDelta", compactDistanceDeltaSeries)}/` +
      `${formatInt8DeltaFitAnalysis("distDelta02mInt8", compactDistanceDelta02mInt8Series)}/` +
      `${formatUint8EscapeDeltaAnalysis("distDelta02mUint8Esc255", compactDistanceDelta02mUint8EscapeSeries)}/` +
      `${formatSeriesAnalysis("pow", compactPowerSeries)}/` +
      `${formatNonNegativeDeltaAnalysis("powDelta", compactPowerDeltaSeries)}/` +
      `${formatSignedDeltaAnalysis("powSigned", compactPowerSignedDeltaSeries)}/` +
      `${formatSignedInt8EscapeDeltaAnalysis("powInt8Esc127", compactPowerSignedInt8EscapeSeries)}/` +
      `${formatSeriesAnalysis("cad", compactCadenceSeries)}/` +
      `${formatSeriesAnalysis("hr", compactHrSeries)}/` +
      `${formatByteDictionaryAnalysis("cad", compactCadenceDict)}/` +
      `${formatByteDictionaryAnalysis("hr", compactHrDict)}/` +
      `${formatByteDictionaryAnalysis("alt", compactAltitudeDict)}/` +
      `${formatRunLengthAnalysis("cad", compactCadenceRle)}/` +
      `${formatRunLengthAnalysis("hr", compactHrRle)}/` +
      `${formatRunLengthAnalysis("alt", compactAltitudeRle)}/` +
      `${formatSeriesAnalysis("alt", compactAltitudeSeries)}/` +
      `${formatSignedInt8EscapeDeltaAnalysis("altDelta1mInt8Esc127", compactAltitudeSignedInt8EscapeSeries)}, ` +
      `compactWorkoutGzip=${(compactWorkoutStreamBytes / 1024 / 1024).toFixed(2)} MiB, ` +
      `compactGpsGzip=${(compactGpsTrackBytes / 1024 / 1024).toFixed(2)} MiB, ` +
      `compactDeltaPowerWoa=${formatMs(compactDeltaPowerWoaBuildMs)} ms, ` +
      `compactDeltaPowerWoaBytes=${(compactDeltaPowerWoaBytes / 1024 / 1024).toFixed(2)} MiB, ` +
      `compactDeltaPowerRaw=${formatMs(compactDeltaPowerRawBuildMs)} ms, ` +
      `compactDeltaPowerGzip=${formatMs(compactDeltaPowerGzipMs)} ms, ` +
      `compactDeltaPowerWorkoutGzipMs=${formatMs(compactDeltaPowerWorkoutGzipMs)} ms, ` +
      `compactDeltaPowerGpsGzipMs=${formatMs(compactDeltaPowerGpsGzipMs)} ms, ` +
      `compactDeltaPowerAssemble=${formatMs(compactDeltaPowerAssembleMs)} ms, ` +
      `compactDeltaPowerRawPower=${(compactDeltaPowerPowerRawBytes / 1024 / 1024).toFixed(2)} MiB, ` +
      `compactDeltaPowerEscapes=${compactDeltaPowerEscapes}, compactDeltaPowerAbsolutes=${compactDeltaPowerAbsoluteCount}, ` +
      `compactDeltaPowerWorkoutGzip=${(compactDeltaPowerWorkoutStreamBytes / 1024 / 1024).toFixed(2)} MiB, ` +
      `compactDeltaDistanceWoa=${formatMs(compactDeltaDistanceWoaBuildMs)} ms, ` +
      `compactDeltaDistanceWoaBytes=${(compactDeltaDistanceWoaBytes / 1024 / 1024).toFixed(2)} MiB, ` +
      `compactDeltaDistanceRaw=${formatMs(compactDeltaDistanceRawBuildMs)} ms, ` +
      `compactDeltaDistanceGzip=${formatMs(compactDeltaDistanceGzipMs)} ms, ` +
      `compactDeltaDistanceWorkoutGzipMs=${formatMs(compactDeltaDistanceWorkoutGzipMs)} ms, ` +
      `compactDeltaDistanceGpsGzipMs=${formatMs(compactDeltaDistanceGpsGzipMs)} ms, ` +
      `compactDeltaDistanceAssemble=${formatMs(compactDeltaDistanceAssembleMs)} ms, ` +
      `compactDeltaDistanceRawDist=${(compactDeltaDistanceRawDistanceBytes / 1024 / 1024).toFixed(2)} MiB, ` +
      `compactDeltaDistanceWorkoutGzip=${(compactDeltaDistanceWorkoutStreamBytes / 1024 / 1024).toFixed(2)} MiB, ` +
      `compactDeltaDistance05Woa=${formatMs(compactDeltaDistance05WoaBuildMs)} ms, ` +
      `compactDeltaDistance05WoaBytes=${(compactDeltaDistance05WoaBytes / 1024 / 1024).toFixed(2)} MiB, ` +
      `compactDeltaDistance05Raw=${formatMs(compactDeltaDistance05RawBuildMs)} ms, ` +
      `compactDeltaDistance05Gzip=${formatMs(compactDeltaDistance05GzipMs)} ms, ` +
      `compactDeltaDistance05WorkoutGzipMs=${formatMs(compactDeltaDistance05WorkoutGzipMs)} ms, ` +
      `compactDeltaDistance05GpsGzipMs=${formatMs(compactDeltaDistance05GpsGzipMs)} ms, ` +
      `compactDeltaDistance05Assemble=${formatMs(compactDeltaDistance05AssembleMs)} ms, ` +
      `compactDeltaDistance05RawDist=${(compactDeltaDistance05RawDistanceBytes / 1024 / 1024).toFixed(2)} MiB, ` +
      `compactDeltaDistance05WorkoutGzip=${(compactDeltaDistance05WorkoutStreamBytes / 1024 / 1024).toFixed(2)} MiB, ` +
      `compactCombinedWoa=${formatMs(compactCombinedWoaBuildMs)} ms, ` +
      `compactCombinedWoaBytes=${(compactCombinedWoaBytes / 1024 / 1024).toFixed(2)} MiB, ` +
      `compactCombinedRaw=${formatMs(compactCombinedRawBuildMs)} ms, ` +
      `compactCombinedGzip=${formatMs(compactCombinedGzipMs)} ms, ` +
      `compactCombinedWorkoutGzipMs=${formatMs(compactCombinedWorkoutGzipMs)} ms, ` +
      `compactCombinedGpsGzipMs=${formatMs(compactCombinedGpsGzipMs)} ms, ` +
      `compactCombinedAssemble=${formatMs(compactCombinedAssembleMs)} ms, ` +
      `compactCombinedRawDist=${(compactCombinedRawDistanceBytes / 1024 / 1024).toFixed(2)} MiB, ` +
      `compactCombinedRawPower=${(compactCombinedRawPowerBytes / 1024 / 1024).toFixed(2)} MiB, ` +
      `compactCombinedEncodedBlocksMiB=` +
      `dist:${(compactCombinedEncodedDistanceBytes / 1024 / 1024).toFixed(2)}/` +
      `pow:${(compactCombinedEncodedPowerBytes / 1024 / 1024).toFixed(2)}/` +
      `hr:${(compactCombinedEncodedHeartRateBytes / 1024 / 1024).toFixed(2)}/` +
      `cad:${(compactCombinedEncodedCadenceBytes / 1024 / 1024).toFixed(2)}/` +
      `spd:${(compactCombinedEncodedSpeedBytes / 1024 / 1024).toFixed(2)}/` +
      `alt:${(compactCombinedEncodedAltitudeBytes / 1024 / 1024).toFixed(2)}, ` +
      `compactCombinedGzipBlocksMiB=` +
      `dist:${(compactCombinedGzipDistanceBytes / 1024 / 1024).toFixed(2)}/` +
      `pow:${(compactCombinedGzipPowerBytes / 1024 / 1024).toFixed(2)}/` +
      `hr:${(compactCombinedGzipHeartRateBytes / 1024 / 1024).toFixed(2)}/` +
      `cad:${(compactCombinedGzipCadenceBytes / 1024 / 1024).toFixed(2)}/` +
      `spd:${(compactCombinedGzipSpeedBytes / 1024 / 1024).toFixed(2)}/` +
      `alt:${(compactCombinedGzipAltitudeBytes / 1024 / 1024).toFixed(2)}, ` +
      `compactCombinedPowerEscapes=${compactCombinedPowerEscapes}, compactCombinedPowerAbsolutes=${compactCombinedPowerAbsoluteCount}, ` +
      `compactCombinedWorkoutGzip=${(compactCombinedWorkoutStreamBytes / 1024 / 1024).toFixed(2)} MiB, ` +
      `compactCombinedAltWoa=${formatMs(compactCombinedAltWoaBuildMs)} ms, ` +
      `compactCombinedAltWoaBytes=${(compactCombinedAltWoaBytes / 1024 / 1024).toFixed(2)} MiB, ` +
      `compactCombinedAltRaw=${formatMs(compactCombinedAltRawBuildMs)} ms, ` +
      `compactCombinedAltGzip=${formatMs(compactCombinedAltGzipMs)} ms, ` +
      `compactCombinedAltWorkoutGzipMs=${formatMs(compactCombinedAltWorkoutGzipMs)} ms, ` +
      `compactCombinedAltGpsGzipMs=${formatMs(compactCombinedAltGpsGzipMs)} ms, ` +
      `compactCombinedAltAssemble=${formatMs(compactCombinedAltAssembleMs)} ms, ` +
      `compactCombinedAltEncodedAlt=${(compactCombinedAltEncodedAltitudeBytes / 1024 / 1024).toFixed(2)} MiB, ` +
      `compactCombinedAltGzipAlt=${(compactCombinedAltGzipAltitudeBytes / 1024 / 1024).toFixed(2)} MiB, ` +
      `compactCombinedAltAltitudeEscapes=${compactCombinedAltAltitudeEscapes}, compactCombinedAltAltitudeAbsolutes=${compactCombinedAltAltitudeAbsoluteCount}, ` +
      `compactCombinedAltWorkoutGzip=${(compactCombinedAltWorkoutStreamBytes / 1024 / 1024).toFixed(2)} MiB, ` +
      `compactCombinedAltRleWoa=${formatMs(compactCombinedAltCadenceRleWoaBuildMs)} ms, ` +
      `compactCombinedAltRleWoaBytes=${(compactCombinedAltCadenceRleWoaBytes / 1024 / 1024).toFixed(2)} MiB, ` +
      `compactCombinedAltRleRaw=${formatMs(compactCombinedAltCadenceRleRawBuildMs)} ms, ` +
      `compactCombinedAltRleGzip=${formatMs(compactCombinedAltCadenceRleGzipMs)} ms, ` +
      `compactCombinedAltRleWorkoutGzipMs=${formatMs(compactCombinedAltCadenceRleWorkoutGzipMs)} ms, ` +
      `compactCombinedAltRleGpsGzipMs=${formatMs(compactCombinedAltCadenceRleGpsGzipMs)} ms, ` +
      `compactCombinedAltRleAssemble=${formatMs(compactCombinedAltCadenceRleAssembleMs)} ms, ` +
      `compactCombinedAltRleEncodedAlt=${(compactCombinedAltCadenceRleEncodedCadenceBytes / 1024 / 1024).toFixed(2)} MiB, ` +
      `compactCombinedAltRleGzipAlt=${(compactCombinedAltCadenceRleGzipCadenceBytes / 1024 / 1024).toFixed(2)} MiB, ` +
      `compactCombinedAltRleWorkoutGzip=${(compactCombinedAltCadenceRleWorkoutStreamBytes / 1024 / 1024).toFixed(2)} MiB, ` +
      `node64Container=${formatMs(node64ContainerMs)} ms, rawContainer=${(rawContainerBytes.byteLength / 1024 / 1024).toFixed(2)} MiB, ` +
      `containerGzip=${(gzipContainerBytes.byteLength / 1024 / 1024).toFixed(2)} MiB, ` +
      `compactContainer=${formatMs(compactContainerMs)} ms, ` +
      `compactRawContainer=${(compactRawContainerBytes.byteLength / 1024 / 1024).toFixed(2)} MiB, ` +
      `compactContainerGzip=${(compactGzipContainerBytes.byteLength / 1024 / 1024).toFixed(2)} MiB, ` +
      `compactDeltaPowerContainer=${formatMs(compactDeltaPowerContainerMs)} ms, ` +
      `compactDeltaPowerRawContainer=${(compactDeltaPowerRawContainerBytes / 1024 / 1024).toFixed(2)} MiB, ` +
      `compactDeltaPowerContainerGzip=${(compactDeltaPowerContainerGzipBytes / 1024 / 1024).toFixed(2)} MiB, ` +
      `compactDeltaDistanceContainer=${formatMs(compactDeltaDistanceContainerMs)} ms, ` +
      `compactDeltaDistanceRawContainer=${(compactDeltaDistanceRawContainerBytes / 1024 / 1024).toFixed(2)} MiB, ` +
      `compactDeltaDistanceContainerGzip=${(compactDeltaDistanceContainerGzipBytes / 1024 / 1024).toFixed(2)} MiB, ` +
      `compactDeltaDistance05Container=${formatMs(compactDeltaDistance05ContainerMs)} ms, ` +
      `compactDeltaDistance05RawContainer=${(compactDeltaDistance05RawContainerBytes / 1024 / 1024).toFixed(2)} MiB, ` +
      `compactDeltaDistance05ContainerGzip=${(compactDeltaDistance05ContainerGzipBytes / 1024 / 1024).toFixed(2)} MiB, ` +
      `compactCombinedContainer=${formatMs(compactCombinedContainerMs)} ms, ` +
      `compactCombinedRawContainer=${(compactCombinedRawContainerBytes / 1024 / 1024).toFixed(2)} MiB, ` +
      `compactCombinedContainerGzip=${(compactCombinedContainerGzipBytes / 1024 / 1024).toFixed(2)} MiB, ` +
      `compactCombinedAltContainer=${formatMs(compactCombinedAltContainerMs)} ms, ` +
      `compactCombinedAltRawContainer=${(compactCombinedAltRawContainerBytes / 1024 / 1024).toFixed(2)} MiB, ` +
      `compactCombinedAltContainerGzip=${(compactCombinedAltContainerGzipBytes / 1024 / 1024).toFixed(2)} MiB, ` +
      `compactCombinedAltRleContainer=${formatMs(compactCombinedAltCadenceRleContainerMs)} ms, ` +
      `compactCombinedAltRleRawContainer=${(compactCombinedAltCadenceRleRawContainerBytes / 1024 / 1024).toFixed(2)} MiB, ` +
      `compactCombinedAltRleContainerGzip=${(compactCombinedAltCadenceRleContainerGzipBytes / 1024 / 1024).toFixed(2)} MiB, ` +
      `unzipThroughput=${(outputMiB * 1000 / unzipMs).toFixed(2)} MiB/s, checksum=${checksum}`,
  );
}
