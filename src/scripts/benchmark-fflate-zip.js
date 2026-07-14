import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { brotliCompressSync, constants as zlibConstants } from "node:zlib";

import { gzipSync, unzipSync } from "fflate";

import {
  applyCompactEncodingOptions,
  parseFitBufferCompactBrowser,
} from "../public/js/fit-import-compact-browser.js";
import { buildGpsTrackBlock, createWoa1FileFromCompact } from "../public/js/woa-format-compact.js";
import { encodeWoaTransportContainer } from "../public/js/woa-transport-container.js";

const COMPRESSION_FORMATS = new Set(["gzip", "brotli", "identity", "none"]);
const UINT8_NAN = 0xFF;
const UINT32_NAN = 0xFFFFFFFF;
const MIN_WORKOUT_RECORD_COUNT = 300;
const MIB = 1024 * 1024;

function normalizeCompressionFormat(value, optionName) {
  const normalized = String(value || "gzip").trim().toLowerCase();
  if (!COMPRESSION_FORMATS.has(normalized)) {
    throw new Error(`${optionName} must be one of: gzip, brotli, identity, none.`);
  }
  return normalized === "none" ? "identity" : normalized;
}

function parseArgs(argv) {
  const options = {
    file: null,
    repeats: 5,
    writeOutput: null,
    gzipLevel: 4,
    brotliQuality: 4,
    innerCompression: "gzip",
    outerCompression: "gzip",
    distanceBlockSize: 999999,
    gpsBlockSize: 999999,
    gpsSampleRateSeconds: 5,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--file") options.file = argv[++index];
    else if (argument === "--repeats") options.repeats = Number(argv[++index]);
    else if (argument === "--write-output") options.writeOutput = argv[++index];
    else if (argument === "--gzip-level") options.gzipLevel = Number(argv[++index]);
    else if (argument === "--brotli-quality") options.brotliQuality = Number(argv[++index]);
    else if (argument === "--inner-compression") options.innerCompression = argv[++index];
    else if (argument === "--outer-compression") options.outerCompression = argv[++index];
    else if (argument === "--distance-block-size") options.distanceBlockSize = Number(argv[++index]);
    else if (argument === "--gps-block-size") options.gpsBlockSize = Number(argv[++index]);
    else if (argument === "--gps-sample-rate") options.gpsSampleRateSeconds = Number(argv[++index]);
    else if (argument === "--variant") index += 1; // Compatibility: only the current format remains.
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
  if (!Number.isInteger(options.brotliQuality) || options.brotliQuality < 0 || options.brotliQuality > 11) {
    throw new Error("--brotli-quality must be an integer between 0 and 11.");
  }
  for (const [name, value] of [
    ["--distance-block-size", options.distanceBlockSize],
    ["--gps-block-size", options.gpsBlockSize],
    ["--gps-sample-rate", options.gpsSampleRateSeconds],
  ]) {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  }

  options.innerCompression = normalizeCompressionFormat(options.innerCompression, "--inner-compression");
  options.outerCompression = normalizeCompressionFormat(options.outerCompression, "--outer-compression");
  return options;
}

function compressBytes(bytes, format, options) {
  if (format === "gzip") return gzipSync(bytes, { level: options.gzipLevel });
  if (format === "brotli") {
    return new Uint8Array(brotliCompressSync(bytes, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: options.brotliQuality,
      },
    }));
  }
  return bytes;
}

function createCompressionCallback(format, options) {
  if (format === "identity") return null;
  return (bytes, compressionOptions = {}) => {
    if (format === "gzip" && Number.isInteger(compressionOptions.level)) {
      return gzipSync(bytes, { level: compressionOptions.level });
    }
    return compressBytes(bytes, format, options);
  };
}

function writeUint16LE(bytes, offset, value) {
  bytes[offset] = value & 0xFF;
  bytes[offset + 1] = (value >>> 8) & 0xFF;
}

function writeUint32LE(bytes, offset, value) {
  bytes[offset] = value & 0xFF;
  bytes[offset + 1] = (value >>> 8) & 0xFF;
  bytes[offset + 2] = (value >>> 16) & 0xFF;
  bytes[offset + 3] = (value >>> 24) & 0xFF;
}

function bitWidthForUnsigned(maxValue) {
  return maxValue > 0 ? Math.ceil(Math.log2(maxValue + 1)) : 0;
}

function packUnsignedValues(values, bitWidth) {
  if (bitWidth <= 0 || values.length === 0) return new Uint8Array(0);
  const bytes = new Uint8Array(Math.ceil((values.length * bitWidth) / 8));
  let bitOffset = 0;
  for (const value of values) {
    let remaining = bitWidth;
    let numeric = value;
    while (remaining > 0) {
      const byteIndex = bitOffset >> 3;
      const inByteOffset = bitOffset & 7;
      const writableBits = Math.min(8 - inByteOffset, remaining);
      const mask = (1 << writableBits) - 1;
      bytes[byteIndex] |= (numeric & mask) << inByteOffset;
      numeric = Math.floor(numeric / (1 << writableBits));
      bitOffset += writableBits;
      remaining -= writableBits;
    }
  }
  return bytes;
}

function buildRuns(values) {
  if (!values?.length) return { lengths: [], values: [] };
  const lengths = [];
  const runValues = [];
  let previous = values[0];
  let runLength = 1;

  const flush = () => {
    let remaining = runLength;
    while (remaining > 0) {
      const length = Math.min(255, remaining);
      lengths.push(length);
      runValues.push(previous);
      remaining -= length;
    }
  };

  for (let index = 1; index < values.length; index += 1) {
    const current = values[index];
    if (current === previous) {
      runLength += 1;
      continue;
    }
    flush();
    previous = current;
    runLength = 1;
  }
  flush();
  return { lengths, values: runValues };
}

function buildRleDeltaParts(values) {
  const runs = buildRuns(values);
  const tokens = new Uint8Array(Math.max(0, runs.values.length - 1));
  const absoluteTail = [];
  let previous = runs.values[0] ?? UINT8_NAN;

  for (let index = 1; index < runs.values.length; index += 1) {
    const current = runs.values[index];
    const delta = current - previous;
    if (delta < -128 || delta >= 127) {
      tokens[index - 1] = 127;
      absoluteTail.push(current);
    } else {
      tokens[index - 1] = delta & 0xFF;
    }
    previous = current;
  }
  return { runs, tokens, absoluteTail };
}

function buildCurrentRleDeltaPayload(values) {
  if (!values?.length) return new Uint8Array(0);
  const { runs, tokens, absoluteTail } = buildRleDeltaParts(values);
  const bytes = new Uint8Array(4 + runs.lengths.length + 1 + tokens.length + absoluteTail.length);
  writeUint32LE(bytes, 0, runs.lengths.length);
  let offset = 4;
  bytes.set(runs.lengths, offset);
  offset += runs.lengths.length;
  bytes[offset] = runs.values[0];
  offset += 1;
  bytes.set(tokens, offset);
  offset += tokens.length;
  bytes.set(absoluteTail, offset);
  return bytes;
}

function buildRleDeltaDictionaryPayload(values) {
  if (!values?.length) return { bytes: new Uint8Array(0), bitWidth: 0 };
  const { runs, tokens, absoluteTail } = buildRleDeltaParts(values);
  const dictionary = [];
  const dictionaryIndexes = new Map();
  const indexes = new Array(tokens.length);

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    let dictionaryIndex = dictionaryIndexes.get(token);
    if (dictionaryIndex == null) {
      dictionaryIndex = dictionary.length;
      dictionaryIndexes.set(token, dictionaryIndex);
      dictionary.push(token);
    }
    indexes[index] = dictionaryIndex;
  }

  const bitWidth = bitWidthForUnsigned(dictionary.length - 1);
  const packedIndexes = packUnsignedValues(indexes, bitWidth);
  const bytes = new Uint8Array(
    4 + runs.lengths.length + 1 + 2 + 1 + dictionary.length + packedIndexes.length + absoluteTail.length
  );
  writeUint32LE(bytes, 0, runs.lengths.length);
  let offset = 4;
  bytes.set(runs.lengths, offset);
  offset += runs.lengths.length;
  bytes[offset] = runs.values[0];
  offset += 1;
  writeUint16LE(bytes, offset, dictionary.length);
  offset += 2;
  bytes[offset] = bitWidth;
  offset += 1;
  bytes.set(dictionary, offset);
  offset += dictionary.length;
  bytes.set(packedIndexes, offset);
  offset += packedIndexes.length;
  bytes.set(absoluteTail, offset);
  return { bytes, bitWidth };
}

function createDictionaryStats() {
  return {
    workouts: 0,
    samples: 0,
    currentBytes: 0,
    candidateBytes: 0,
    adaptiveBytes: 0,
    currentGzipBytes: 0,
    candidateGzipBytes: 0,
    adaptiveGzipBytes: 0,
    selected: 0,
    gzipSelected: 0,
    bitWidthTotal: 0,
    bitWidthCounts: new Uint32Array(9),
  };
}

function analyzeDictionaryColumn(stats, values, gzipLevel) {
  const current = buildCurrentRleDeltaPayload(values);
  const candidate = buildRleDeltaDictionaryPayload(values);
  const currentGzip = gzipSync(current, { level: gzipLevel });
  const candidateGzip = gzipSync(candidate.bytes, { level: gzipLevel });
  stats.workouts += 1;
  stats.samples += values.length;
  stats.currentBytes += current.length;
  stats.candidateBytes += candidate.bytes.length;
  stats.adaptiveBytes += Math.min(current.length, candidate.bytes.length);
  stats.currentGzipBytes += currentGzip.length;
  stats.candidateGzipBytes += candidateGzip.length;
  stats.adaptiveGzipBytes += Math.min(currentGzip.length, candidateGzip.length);
  stats.selected += candidate.bytes.length < current.length ? 1 : 0;
  stats.gzipSelected += candidateGzip.length < currentGzip.length ? 1 : 0;
  stats.bitWidthTotal += candidate.bitWidth;
  stats.bitWidthCounts[candidate.bitWidth] += 1;
}

function formatMiB(bytes) {
  return `${(bytes / MIB).toFixed(2)} MiB`;
}

function formatMs(value) {
  return `${value.toFixed(2)} ms`;
}

function formatDictionaryStats(name, stats) {
  const saving = stats.currentBytes > 0
    ? ((stats.currentBytes - stats.adaptiveBytes) * 100) / stats.currentBytes
    : 0;
  const widths = [];
  for (let width = 0; width < stats.bitWidthCounts.length; width += 1) {
    if (stats.bitWidthCounts[width] > 0) widths.push(`${width}:${stats.bitWidthCounts[width]}`);
  }
  return (
    `${name}: current=${formatMiB(stats.currentBytes)}, dictionary=${formatMiB(stats.candidateBytes)}, ` +
    `adaptive=${formatMiB(stats.adaptiveBytes)} (${saving.toFixed(1)}% smaller, selected ${stats.selected}/${stats.workouts}), ` +
    `gzip current=${formatMiB(stats.currentGzipBytes)}, dictionary=${formatMiB(stats.candidateGzipBytes)}, ` +
    `adaptive=${formatMiB(stats.adaptiveGzipBytes)} (selected ${stats.gzipSelected}/${stats.workouts}), ` +
    `avgBits=${(stats.bitWidthTotal / Math.max(1, stats.workouts)).toFixed(1)}, widths=${widths.join("|")}`
  );
}

function createDistanceDeltaStats() {
  return {
    workouts: 0,
    samples: 0,
    deltas: 0,
    escapes: 0,
    currentBytes: 0,
    q1Bytes: 0,
    q1GzipBytes: 0,
    q1AbsoluteErrorMeters: 0,
    q1SquaredErrorMeters: 0,
    q1MaxErrorMeters: 0,
    q1ErrorSamples: 0,
    tokenCounts: new Float64Array(256),
    packedBytes: new Float64Array(9),
  };
}

function buildDistancePayloadCandidate(values, divisor) {
  if (values.length === 0) return new Uint8Array(0);
  const tokens = new Uint8Array(Math.max(0, values.length - 1));
  const absolutes = [];
  let previous = Math.round(values[0] / divisor);
  for (let index = 1; index < values.length; index += 1) {
    const current = Math.round(values[index] / divisor);
    const delta = current - previous;
    if (delta >= 0 && delta < 255) {
      tokens[index - 1] = delta;
    } else {
      tokens[index - 1] = 255;
      absolutes.push(current);
    }
    previous = current;
  }
  const bytes = new Uint8Array(7 + tokens.length + absolutes.length * 4);
  const view = new DataView(bytes.buffer);
  bytes[0] = 3;
  view.setUint16(1, values.length, true);
  view.setUint32(3, Math.round(values[0] / divisor), true);
  bytes.set(tokens, 7);
  let offset = 7 + tokens.length;
  for (const absolute of absolutes) {
    view.setUint32(offset, absolute, true);
    offset += 4;
  }
  return bytes;
}

function analyzeDistanceDeltas(stats, values, currentPayload, gzipLevel) {
  stats.workouts += 1;
  stats.samples += values.length;
  stats.currentBytes += currentPayload.byteLength;

  let complete = values.length > 0;
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === UINT32_NAN) {
      complete = false;
      break;
    }
  }
  if (!complete) return;

  const q1Payload = buildDistancePayloadCandidate(values, 2);
  stats.q1Bytes += q1Payload.byteLength;
  stats.q1GzipBytes += gzipSync(q1Payload, { level: gzipLevel }).byteLength;
  for (let index = 0; index < values.length; index += 1) {
    const sourceMeters = values[index] / 2;
    const encodedMeters = Math.round(values[index] / 2);
    const error = Math.abs(encodedMeters - sourceMeters);
    stats.q1AbsoluteErrorMeters += error;
    stats.q1SquaredErrorMeters += error * error;
    stats.q1MaxErrorMeters = Math.max(stats.q1MaxErrorMeters, error);
    stats.q1ErrorSamples += 1;
  }

  let previous = values[0];
  const perWidthEscapes = new Uint32Array(9);
  for (let index = 1; index < values.length; index += 1) {
    const current = values[index];
    const delta = current - previous;
    const token = delta >= 0 && delta < 255 ? delta : 255;
    stats.tokenCounts[token] += 1;
    stats.deltas += 1;
    if (token === 255) stats.escapes += 1;
    for (let width = 4; width <= 8; width += 1) {
      const escape = (2 ** width) - 1;
      if (delta < 0 || delta >= escape) perWidthEscapes[width] += 1;
    }
    previous = current;
  }

  // One mode/count/absolute header per workout, packed tokens, then Uint32 escape absolutes.
  for (let width = 4; width <= 8; width += 1) {
    stats.packedBytes[width] += 7 + Math.ceil(Math.max(0, values.length - 1) * width / 8)
      + perWidthEscapes[width] * 4;
  }
}

function formatDistanceDeltaStats(stats) {
  const total = Math.max(1, stats.deltas);
  let entropyBits = 0;
  const frequencies = [];
  for (let token = 0; token < stats.tokenCounts.length; token += 1) {
    const count = stats.tokenCounts[token];
    if (count === 0) continue;
    const probability = count / total;
    entropyBits -= probability * Math.log2(probability);
    frequencies.push({ token, count });
  }
  frequencies.sort((left, right) => right.count - left.count);
  const top = frequencies.slice(0, 15)
    .map(({ token, count }) => `${token}:${((count * 100) / total).toFixed(2)}%`)
    .join("|");
  const packed = [];
  for (let width = 4; width <= 8; width += 1) {
    const saving = stats.currentBytes > 0
      ? ((stats.currentBytes - stats.packedBytes[width]) * 100) / stats.currentBytes
      : 0;
    packed.push(`${width}bit=${formatMiB(stats.packedBytes[width])} (${saving.toFixed(1)}%)`);
  }
  const idealTokenBytes = (stats.deltas * entropyBits) / 8;
  const q1RawSaving = stats.currentBytes > 0
    ? ((stats.currentBytes - stats.q1Bytes) * 100) / stats.currentBytes
    : 0;
  const meanError = stats.q1AbsoluteErrorMeters / Math.max(1, stats.q1ErrorSamples);
  const rmse = Math.sqrt(stats.q1SquaredErrorMeters / Math.max(1, stats.q1ErrorSamples));
  return (
    `Distance delta distribution (units of 0.5m): samples=${stats.samples}, deltas=${stats.deltas}, ` +
    `current=${formatMiB(stats.currentBytes)}, escapes=${stats.escapes} ` +
    `(${((stats.escapes * 100) / total).toFixed(4)}%), entropy=${entropyBits.toFixed(3)} bit/token, ` +
    `idealTokens=${formatMiB(idealTokenBytes)}, ${packed.join(", ")}, top=${top}\n` +
    `Distance 1.0m candidate: raw=${formatMiB(stats.q1Bytes)} (${q1RawSaving.toFixed(1)}% smaller), ` +
    `gzip=${formatMiB(stats.q1GzipBytes)}, meanError=${meanError.toFixed(3)}m, ` +
    `rmse=${rmse.toFixed(3)}m, maxError=${stats.q1MaxErrorMeters.toFixed(3)}m`
  );
}

const POWER_PFOR_BLOCK_SIZES = [32, 64, 128, 256, 512, 1024];

function preparePowerDeltaCodes(values) {
  const count = Math.max(0, values.length - 1);
  const codes = new Uint32Array(count);
  const requiredWidths = new Uint8Array(count);
  for (let index = 0; index < count; index += 1) {
    const previous = values[index];
    const current = values[index + 1];
    if (previous === 0xFFFF || current === 0xFFFF) {
      requiredWidths[index] = 32;
      continue;
    }
    const delta = (current - previous) / 4;
    if (!Number.isInteger(delta)) {
      requiredWidths[index] = 32;
      continue;
    }
    const code = delta >= 0 ? delta * 2 : (-delta * 2) - 1;
    codes[index] = code;
    requiredWidths[index] = Math.min(31, bitWidthForUnsigned(code));
  }
  return { codes, requiredWidths };
}

function collectPowerDeltaDistribution(stats, values) {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    stats.deltaTotal += 1;
    if (previous === 0xFFFF || current === 0xFFFF) {
      stats.deltaEscapes += 1;
      continue;
    }
    const delta = (current - previous) / 4;
    if (!Number.isInteger(delta) || delta < -128 || delta >= 127) {
      stats.deltaEscapes += 1;
      continue;
    }
    stats.deltaCounts[delta + 128] += 1;
  }
}

function buildPowerNibbleEscapePayload(values) {
  if (!values.length) return { bytes: new Uint8Array(0), escapeCount: 0 };
  const tokenCount = values.length - 1;
  const tokenBytes = Math.ceil(tokenCount / 2);
  let escapeCount = 0;
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    const delta = previous !== 0xFFFF && current !== 0xFFFF ? (current - previous) / 4 : Number.NaN;
    if (!Number.isInteger(delta) || delta < -7 || delta > 7) escapeCount += 1;
  }

  const bytes = new Uint8Array(2 + tokenBytes + (escapeCount * 2));
  const view = new DataView(bytes.buffer);
  view.setUint16(0, values[0], true);
  let absoluteOffset = 2 + tokenBytes;
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    const delta = previous !== 0xFFFF && current !== 0xFFFF ? (current - previous) / 4 : Number.NaN;
    const direct = Number.isInteger(delta) && delta >= -7 && delta <= 7;
    const token = direct ? delta + 7 : 15;
    const tokenIndex = index - 1;
    const byteOffset = 2 + (tokenIndex >> 1);
    if ((tokenIndex & 1) === 0) bytes[byteOffset] = token;
    else bytes[byteOffset] |= token << 4;
    if (!direct) {
      view.setUint16(absoluteOffset, current, true);
      absoluteOffset += 2;
    }
  }
  return { bytes, escapeCount };
}

function verifyPowerNibbleEscapePayload(values, payload) {
  if (!values.length) return;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const tokenCount = values.length - 1;
  let previous = view.getUint16(0, true);
  if (previous !== values[0]) throw new Error("Power nibble first-value mismatch.");
  let absoluteOffset = 2 + Math.ceil(tokenCount / 2);
  for (let tokenIndex = 0; tokenIndex < tokenCount; tokenIndex += 1) {
    const packed = payload[2 + (tokenIndex >> 1)];
    const token = (tokenIndex & 1) === 0 ? packed & 0x0F : packed >>> 4;
    const current = token === 15
      ? view.getUint16(absoluteOffset, true)
      : previous + ((token - 7) * 4);
    if (token === 15) absoluteOffset += 2;
    if (current !== values[tokenIndex + 1]) {
      throw new Error(`Power nibble mismatch at record ${tokenIndex + 1}.`);
    }
    previous = current;
  }
  if (absoluteOffset !== payload.byteLength) throw new Error("Power nibble trailing-byte mismatch.");
}

function buildPowerPforPayload(values, prepared, blockSize) {
  if (!values.length) return { bytes: new Uint8Array(0), exceptionCount: 0, widths: new Uint32Array(9) };
  const { codes, requiredWidths } = prepared;
  const blockCount = Math.ceil(codes.length / blockSize);
  const plans = new Array(blockCount);
  let bitmapBytes = 0;
  let packedBytes = 0;
  let absoluteBytes = 0;
  let exceptionCount = 0;
  const widths = new Uint32Array(9);

  for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
    const start = blockIndex * blockSize;
    const end = Math.min(codes.length, start + blockSize);
    const count = end - start;
    const histogram = new Uint32Array(33);
    for (let index = start; index < end; index += 1) histogram[requiredWidths[index]] += 1;

    let best = null;
    let fitting = 0;
    for (let width = 0; width <= 8; width += 1) {
      fitting += histogram[width];
      const exceptions = count - fitting;
      const bitmapLength = exceptions > 0 ? Math.ceil(count / 8) : 0;
      const packedLength = Math.ceil((count * width) / 8);
      const size = bitmapLength + packedLength + (exceptions * 2);
      if (!best || size < best.size) {
        best = { width, exceptions, bitmapLength, packedLength, size };
      }
    }
    plans[blockIndex] = { start, end, ...best };
    widths[best.width] += 1;
    bitmapBytes += best.bitmapLength;
    packedBytes += best.packedLength;
    absoluteBytes += best.exceptions * 2;
    exceptionCount += best.exceptions;
  }

  // Header: first absolute value + block size. Each block descriptor stores width and exception count.
  const headerBytes = 4 + (blockCount * 3);
  const bytes = new Uint8Array(headerBytes + bitmapBytes + packedBytes + absoluteBytes);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, values[0], true);
  view.setUint16(2, blockSize, true);
  let descriptorOffset = 4;
  let bitmapOffset = headerBytes;
  let packedOffset = headerBytes + bitmapBytes;
  let absoluteOffset = headerBytes + bitmapBytes + packedBytes;

  for (const plan of plans) {
    bytes[descriptorOffset] = plan.width;
    view.setUint16(descriptorOffset + 1, plan.exceptions, true);
    descriptorOffset += 3;
    let bitOffset = 0;
    for (let index = plan.start; index < plan.end; index += 1) {
      const relativeIndex = index - plan.start;
      const exception = requiredWidths[index] > plan.width;
      if (exception) {
        bytes[bitmapOffset + (relativeIndex >> 3)] |= 1 << (relativeIndex & 7);
        view.setUint16(absoluteOffset, values[index + 1], true);
        absoluteOffset += 2;
      }
      if (plan.width > 0) {
        let code = exception ? 0 : codes[index];
        let remaining = plan.width;
        while (remaining > 0) {
          const byteIndex = packedOffset + (bitOffset >> 3);
          const inByteOffset = bitOffset & 7;
          const writableBits = Math.min(8 - inByteOffset, remaining);
          const mask = (1 << writableBits) - 1;
          bytes[byteIndex] |= (code & mask) << inByteOffset;
          code = Math.floor(code / (2 ** writableBits));
          bitOffset += writableBits;
          remaining -= writableBits;
        }
      }
    }
    bitmapOffset += plan.bitmapLength;
    packedOffset += plan.packedLength;
  }

  return { bytes, exceptionCount, widths };
}

function createPowerPforStats() {
  return {
    workouts: 0,
    currentBytes: 0,
    currentGzipBytes: 0,
    encodeMs: 0,
    deltaTotal: 0,
    deltaEscapes: 0,
    deltaCounts: new Uint32Array(255),
    nibbleBytes: 0,
    nibbleGzipBytes: 0,
    nibbleEscapes: 0,
    nibbleExperimentMs: 0,
    variants: new Map(POWER_PFOR_BLOCK_SIZES.map((size) => [size, {
      bytes: 0,
      gzipBytes: 0,
      exceptions: 0,
      selected: 0,
      widths: new Uint32Array(9),
    }])),
  };
}

function analyzePowerPfor(stats, values, currentPayload, gzipLevel) {
  const startedAt = performance.now();
  collectPowerDeltaDistribution(stats, values);
  const nibbleStartedAt = performance.now();
  const nibble = buildPowerNibbleEscapePayload(values);
  verifyPowerNibbleEscapePayload(values, nibble.bytes);
  stats.nibbleBytes += nibble.bytes.byteLength;
  stats.nibbleGzipBytes += gzipSync(nibble.bytes, { level: gzipLevel }).byteLength;
  stats.nibbleEscapes += nibble.escapeCount;
  stats.nibbleExperimentMs += performance.now() - nibbleStartedAt;
  const prepared = preparePowerDeltaCodes(values);
  const candidates = [];
  stats.workouts += 1;
  stats.currentBytes += currentPayload.byteLength;
  stats.currentGzipBytes += gzipSync(currentPayload, { level: gzipLevel }).byteLength;
  for (const blockSize of POWER_PFOR_BLOCK_SIZES) {
    const candidate = buildPowerPforPayload(values, prepared, blockSize);
    const variant = stats.variants.get(blockSize);
    const gzipBytes = gzipSync(candidate.bytes, { level: gzipLevel }).byteLength;
    variant.bytes += candidate.bytes.byteLength;
    variant.gzipBytes += gzipBytes;
    variant.exceptions += candidate.exceptionCount;
    for (let width = 0; width < candidate.widths.length; width += 1) {
      variant.widths[width] += candidate.widths[width];
    }
    candidates.push({ blockSize, bytes: candidate.bytes.byteLength });
  }
  let best = candidates[0];
  for (const candidate of candidates) if (candidate.bytes < best.bytes) best = candidate;
  stats.variants.get(best.blockSize).selected += 1;
  stats.encodeMs += performance.now() - startedAt;
}

function countPowerDeltasInRange(stats, minimum, maximum) {
  let count = 0;
  for (let delta = minimum; delta <= maximum; delta += 1) {
    if (delta >= -128 && delta <= 126) count += stats.deltaCounts[delta + 128];
  }
  return count;
}

function formatPowerDeltaDistribution(stats) {
  const total = Math.max(1, stats.deltaTotal);
  const ranges = [
    ["3bit", -4, 3],
    ["4bit", -8, 7],
    ["4bit+escape", -7, 7],
    ["5bit", -16, 15],
    ["6bit", -32, 31],
    ["7bit", -64, 63],
    ["8bit", -128, 126],
  ].map(([label, minimum, maximum]) => {
    const count = countPowerDeltasInRange(stats, minimum, maximum);
    return `${label}[${minimum}..${maximum}]=${((count * 100) / total).toFixed(2)}%`;
  });
  const frequencies = [];
  for (let delta = -128; delta <= 126; delta += 1) {
    const count = stats.deltaCounts[delta + 128];
    if (count > 0) frequencies.push({ delta, count });
  }
  frequencies.sort((left, right) => right.count - left.count);
  const top = frequencies.slice(0, 15)
    .map(({ delta, count }) => `${delta}:${((count * 100) / total).toFixed(2)}%`)
    .join("|");
  return (
    `Power delta distribution (units of 4W): total=${stats.deltaTotal}, ` +
    `escapes=${stats.deltaEscapes} (${((stats.deltaEscapes * 100) / total).toFixed(3)}%), ` +
    `${ranges.join(", ")}, top=${top}`
  );
}

function formatPowerNibbleStats(stats) {
  const rawSaving = stats.currentBytes > 0
    ? ((stats.currentBytes - stats.nibbleBytes) * 100) / stats.currentBytes
    : 0;
  const gzipSaving = stats.currentGzipBytes > 0
    ? ((stats.currentGzipBytes - stats.nibbleGzipBytes) * 100) / stats.currentGzipBytes
    : 0;
  return (
    `Power nibble [-7..7]+escape: raw=${formatMiB(stats.nibbleBytes)} (${rawSaving.toFixed(1)}% smaller), ` +
    `gzip=${formatMiB(stats.nibbleGzipBytes)} (${gzipSaving.toFixed(1)}% smaller), ` +
    `escapes=${stats.nibbleEscapes} (${((stats.nibbleEscapes * 100) / Math.max(1, stats.deltaTotal)).toFixed(2)}%), ` +
    `experiment=${formatMs(stats.nibbleExperimentMs)} (encode+verify+gzip)`
  );
}

function formatPowerPforStats(stats) {
  const variants = [];
  for (const [blockSize, variant] of stats.variants) {
    const rawSaving = stats.currentBytes > 0
      ? ((stats.currentBytes - variant.bytes) * 100) / stats.currentBytes
      : 0;
    const gzipSaving = stats.currentGzipBytes > 0
      ? ((stats.currentGzipBytes - variant.gzipBytes) * 100) / stats.currentGzipBytes
      : 0;
    const widths = [];
    for (let width = 0; width < variant.widths.length; width += 1) {
      if (variant.widths[width] > 0) widths.push(`${width}:${variant.widths[width]}`);
    }
    variants.push(
      `b${blockSize}=${formatMiB(variant.bytes)} (${rawSaving.toFixed(1)}%), ` +
      `gzip ${formatMiB(variant.gzipBytes)} (${gzipSaving.toFixed(1)}%), ` +
      `esc=${variant.exceptions}, best=${variant.selected}, widths=${widths.join("|")}`
    );
  }
  return (
    `Power PFOR: current=${formatMiB(stats.currentBytes)} -> gzip ${formatMiB(stats.currentGzipBytes)}, ` +
    `experiment=${formatMs(stats.encodeMs)} (all variants including gzip)\n  ${variants.join("\n  ")}`
  );
}

function buildGpsValidityBitmapCandidate(gpsTrack) {
  const slots = Array.isArray(gpsTrack?.slots) ? gpsTrack.slots : [];
  const bitmapBytes = Math.ceil(slots.length / 8);
  const quantized = new Array(slots.length);
  let coordinateBytes = 0;
  let validCount = 0;
  let missingCount = 0;

  for (let index = 0; index < slots.length; index += 1) {
    const slot = slots[index];
    const valid = Number.isFinite(Number(slot?.lat)) && Number.isFinite(Number(slot?.lng));
    if (!valid) {
      quantized[index] = null;
      missingCount += 1;
      continue;
    }
    const current = {
      lat: Math.round(Number(slot.lat) * 100000),
      lng: Math.round(Number(slot.lng) * 100000),
    };
    quantized[index] = current;
    validCount += 1;
    const previous = index > 0 ? quantized[index - 1] : null;
    if (!previous) {
      coordinateBytes += 8;
      continue;
    }
    const deltaLat = current.lat - previous.lat;
    const deltaLng = current.lng - previous.lng;
    if (deltaLat >= -128 && deltaLat <= 125 && deltaLng >= -128 && deltaLng <= 127) {
      coordinateBytes += 2;
    } else if (deltaLat >= -32768 && deltaLat <= 32767 && deltaLng >= -32768 && deltaLng <= 32767) {
      coordinateBytes += 5;
    } else {
      coordinateBytes += 10;
    }
  }

  const bytes = new Uint8Array(20 + bitmapBytes + coordinateBytes);
  const view = new DataView(bytes.buffer);
  bytes.set([71, 80, 83, 50], 0); // GPS2
  view.setUint16(4, 5, true);
  view.setUint16(6, Number(gpsTrack?.sampleRateSeconds || 0), true);
  view.setUint32(8, slots.length, true);
  view.setFloat64(12, Number(gpsTrack?.firstTimestampMs || 0), true);
  let offset = 20 + bitmapBytes;

  for (let index = 0; index < quantized.length; index += 1) {
    const current = quantized[index];
    if (!current) continue;
    bytes[20 + (index >> 3)] |= 1 << (index & 7);
    const previous = index > 0 ? quantized[index - 1] : null;
    if (!previous) {
      view.setInt32(offset, current.lat, true);
      view.setInt32(offset + 4, current.lng, true);
      offset += 8;
      continue;
    }
    const deltaLat = current.lat - previous.lat;
    const deltaLng = current.lng - previous.lng;
    if (deltaLat >= -128 && deltaLat <= 125 && deltaLng >= -128 && deltaLng <= 127) {
      view.setInt8(offset, deltaLat);
      view.setInt8(offset + 1, deltaLng);
      offset += 2;
    } else if (deltaLat >= -32768 && deltaLat <= 32767 && deltaLng >= -32768 && deltaLng <= 32767) {
      view.setUint8(offset, 126);
      view.setInt16(offset + 1, deltaLat, true);
      view.setInt16(offset + 3, deltaLng, true);
      offset += 5;
    } else {
      view.setUint8(offset, 127);
      view.setUint8(offset + 1, 1);
      view.setInt32(offset + 2, current.lat, true);
      view.setInt32(offset + 6, current.lng, true);
      offset += 10;
    }
  }

  return { bytes, bitmapBytes, validCount, missingCount };
}

function buildGpsCoordinateColumn(quantized, key) {
  let payloadBytes = 0;
  for (let index = 0; index < quantized.length; index += 1) {
    const current = quantized[index];
    if (!current) continue;
    const previous = index > 0 ? quantized[index - 1] : null;
    if (!previous) {
      payloadBytes += 4;
      continue;
    }
    const delta = current[key] - previous[key];
    if (delta >= -128 && delta <= 125) payloadBytes += 1;
    else if (delta >= -32768 && delta <= 32767) payloadBytes += 3;
    else payloadBytes += 5;
  }

  const bytes = new Uint8Array(payloadBytes);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  for (let index = 0; index < quantized.length; index += 1) {
    const current = quantized[index];
    if (!current) continue;
    const previous = index > 0 ? quantized[index - 1] : null;
    if (!previous) {
      view.setInt32(offset, current[key], true);
      offset += 4;
      continue;
    }
    const delta = current[key] - previous[key];
    if (delta >= -128 && delta <= 125) {
      view.setInt8(offset, delta);
      offset += 1;
    } else if (delta >= -32768 && delta <= 32767) {
      view.setUint8(offset, 126);
      view.setInt16(offset + 1, delta, true);
      offset += 3;
    } else {
      view.setUint8(offset, 127);
      view.setInt32(offset + 1, current[key], true);
      offset += 5;
    }
  }
  return bytes;
}

function buildGpsCoordinateColumnWithMissing(quantized, key) {
  if (quantized.length === 0) return new Uint8Array(0);
  let payloadBytes = 4;
  for (let index = 1; index < quantized.length; index += 1) {
    const current = quantized[index];
    const previous = quantized[index - 1];
    if (!current) {
      payloadBytes += 2;
      continue;
    }
    if (!previous) {
      payloadBytes += 6;
      continue;
    }
    const delta = current[key] - previous[key];
    if (delta >= -128 && delta <= 125) payloadBytes += 1;
    else if (delta >= -32768 && delta <= 32767) payloadBytes += 3;
    else payloadBytes += 6;
  }

  const bytes = new Uint8Array(payloadBytes);
  const view = new DataView(bytes.buffer);
  view.setInt32(0, quantized[0]?.[key] ?? -0x80000000, true);
  let offset = 4;
  for (let index = 1; index < quantized.length; index += 1) {
    const current = quantized[index];
    const previous = quantized[index - 1];
    if (!current) {
      view.setUint8(offset, 127);
      view.setUint8(offset + 1, 0);
      offset += 2;
      continue;
    }
    if (!previous) {
      view.setUint8(offset, 127);
      view.setUint8(offset + 1, 1);
      view.setInt32(offset + 2, current[key], true);
      offset += 6;
      continue;
    }
    const delta = current[key] - previous[key];
    if (delta >= -128 && delta <= 125) {
      view.setInt8(offset, delta);
      offset += 1;
    } else if (delta >= -32768 && delta <= 32767) {
      view.setUint8(offset, 126);
      view.setInt16(offset + 1, delta, true);
      offset += 3;
    } else {
      view.setUint8(offset, 127);
      view.setUint8(offset + 1, 1);
      view.setInt32(offset + 2, current[key], true);
      offset += 6;
    }
  }
  return bytes;
}

function buildGpsTieredColumnarCandidate(gpsTrack) {
  const slots = Array.isArray(gpsTrack?.slots) ? gpsTrack.slots : [];
  const quantized = slots.map((slot) => (
    Number.isFinite(Number(slot?.lat)) && Number.isFinite(Number(slot?.lng))
      ? {
          lat: Math.round(Number(slot.lat) * 100000),
          lng: Math.round(Number(slot.lng) * 100000),
        }
      : null
  ));
  const latitudes = buildGpsCoordinateColumnWithMissing(quantized, "lat");
  const longitudes = buildGpsCoordinateColumnWithMissing(quantized, "lng");
  const bytes = new Uint8Array(24 + latitudes.length + longitudes.length);
  const view = new DataView(bytes.buffer);
  bytes.set([71, 80, 83, 50], 0); // GPS2
  view.setUint16(4, 7, true);
  view.setUint16(6, Number(gpsTrack?.sampleRateSeconds || 0), true);
  view.setUint32(8, slots.length, true);
  view.setFloat64(12, Number(gpsTrack?.firstTimestampMs || 0), true);
  view.setUint32(20, latitudes.length, true);
  bytes.set(latitudes, 24);
  bytes.set(longitudes, 24 + latitudes.length);
  return { bytes, latitudeBytes: latitudes.length, longitudeBytes: longitudes.length };
}

function buildGpsValidityBitmapColumnarCandidate(gpsTrack) {
  const slots = Array.isArray(gpsTrack?.slots) ? gpsTrack.slots : [];
  const bitmapBytes = Math.ceil(slots.length / 8);
  const quantized = new Array(slots.length);
  let validCount = 0;
  let missingCount = 0;
  for (let index = 0; index < slots.length; index += 1) {
    const slot = slots[index];
    const valid = Number.isFinite(Number(slot?.lat)) && Number.isFinite(Number(slot?.lng));
    if (!valid) {
      quantized[index] = null;
      missingCount += 1;
      continue;
    }
    quantized[index] = {
      lat: Math.round(Number(slot.lat) * 100000),
      lng: Math.round(Number(slot.lng) * 100000),
    };
    validCount += 1;
  }

  const latitudes = buildGpsCoordinateColumn(quantized, "lat");
  const longitudes = buildGpsCoordinateColumn(quantized, "lng");
  const bytes = new Uint8Array(24 + bitmapBytes + latitudes.length + longitudes.length);
  const view = new DataView(bytes.buffer);
  bytes.set([71, 80, 83, 50], 0); // GPS2
  view.setUint16(4, 6, true);
  view.setUint16(6, Number(gpsTrack?.sampleRateSeconds || 0), true);
  view.setUint32(8, slots.length, true);
  view.setFloat64(12, Number(gpsTrack?.firstTimestampMs || 0), true);
  view.setUint32(20, latitudes.length, true);
  for (let index = 0; index < quantized.length; index += 1) {
    if (quantized[index]) bytes[24 + (index >> 3)] |= 1 << (index & 7);
  }
  let offset = 24 + bitmapBytes;
  bytes.set(latitudes, offset);
  offset += latitudes.length;
  bytes.set(longitudes, offset);
  return {
    bytes,
    bitmapBytes,
    latitudeBytes: latitudes.length,
    longitudeBytes: longitudes.length,
    validCount,
    missingCount,
  };
}

function createGpsBitmapStats() {
  return {
    workouts: 0,
    slots: 0,
    valid: 0,
    missing: 0,
    bitmapBytes: 0,
    currentBytes: 0,
    candidateBytes: 0,
    columnarBytes: 0,
    tieredColumnarBytes: 0,
    currentGzipBytes: 0,
    candidateGzipBytes: 0,
    columnarGzipBytes: 0,
    tieredColumnarGzipBytes: 0,
    latitudeBytes: 0,
    longitudeBytes: 0,
  };
}

function analyzeGpsBitmapCandidate(stats, gpsTrack, gpsBlockSize, gzipLevel) {
  const current = buildGpsTrackBlock(gpsTrack, {
    gpsBlockSize,
    coordinateEncoding: "tiered-int8",
  });
  const candidate = buildGpsValidityBitmapCandidate(gpsTrack);
  const columnar = buildGpsValidityBitmapColumnarCandidate(gpsTrack);
  const tieredColumnar = buildGpsTieredColumnarCandidate(gpsTrack);
  stats.workouts += 1;
  stats.slots += Number(gpsTrack?.slotCount || 0);
  stats.valid += candidate.validCount;
  stats.missing += candidate.missingCount;
  stats.bitmapBytes += candidate.bitmapBytes;
  stats.currentBytes += current.length;
  stats.candidateBytes += candidate.bytes.length;
  stats.columnarBytes += columnar.bytes.length;
  stats.tieredColumnarBytes += tieredColumnar.bytes.length;
  stats.latitudeBytes += columnar.latitudeBytes;
  stats.longitudeBytes += columnar.longitudeBytes;
  stats.currentGzipBytes += gzipSync(current, { level: gzipLevel }).length;
  stats.candidateGzipBytes += gzipSync(candidate.bytes, { level: gzipLevel }).length;
  stats.columnarGzipBytes += gzipSync(columnar.bytes, { level: gzipLevel }).length;
  stats.tieredColumnarGzipBytes += gzipSync(tieredColumnar.bytes, { level: gzipLevel }).length;
}

function formatGpsBitmapStats(stats) {
  const rawSaving = stats.currentBytes > 0
    ? ((stats.currentBytes - stats.candidateBytes) * 100) / stats.currentBytes
    : 0;
  const gzipSaving = stats.currentGzipBytes > 0
    ? ((stats.currentGzipBytes - stats.candidateGzipBytes) * 100) / stats.currentGzipBytes
    : 0;
  const columnarRawSaving = stats.currentBytes > 0
    ? ((stats.currentBytes - stats.columnarBytes) * 100) / stats.currentBytes
    : 0;
  const columnarGzipSaving = stats.currentGzipBytes > 0
    ? ((stats.currentGzipBytes - stats.columnarGzipBytes) * 100) / stats.currentGzipBytes
    : 0;
  const tieredColumnarRawChange = stats.currentBytes > 0
    ? ((stats.tieredColumnarBytes - stats.currentBytes) * 100) / stats.currentBytes
    : 0;
  const tieredColumnarGzipChange = stats.currentGzipBytes > 0
    ? ((stats.tieredColumnarGzipBytes - stats.currentGzipBytes) * 100) / stats.currentGzipBytes
    : 0;
  return (
    `GPS validity bitmap: slots=${stats.slots}, valid=${stats.valid}, missing=${stats.missing}, ` +
    `bitmap=${formatMiB(stats.bitmapBytes)}, raw=${formatMiB(stats.currentBytes)} -> ` +
    `${formatMiB(stats.candidateBytes)} (${rawSaving.toFixed(1)}% smaller), ` +
    `gzip=${formatMiB(stats.currentGzipBytes)} -> ${formatMiB(stats.candidateGzipBytes)} ` +
    `(${gzipSaving.toFixed(1)}% smaller)\n` +
    `GPS tiered columnar (no bitmap): raw=${formatMiB(stats.tieredColumnarBytes)} ` +
    `(change=${tieredColumnarRawChange >= 0 ? "+" : ""}${tieredColumnarRawChange.toFixed(1)}%), ` +
    `gzip=${formatMiB(stats.tieredColumnarGzipBytes)} ` +
    `(change=${tieredColumnarGzipChange >= 0 ? "+" : ""}${tieredColumnarGzipChange.toFixed(1)}%)\n` +
    `GPS bitmap columnar: lat=${formatMiB(stats.latitudeBytes)}, lng=${formatMiB(stats.longitudeBytes)}, ` +
    `raw=${formatMiB(stats.columnarBytes)} (${columnarRawSaving.toFixed(1)}% smaller), ` +
    `gzip=${formatMiB(stats.columnarGzipBytes)} (${columnarGzipSaving.toFixed(1)}% smaller)`
  );
}

const options = parseArgs(process.argv.slice(2));
const filePath = path.resolve(options.file);

console.log(`File: ${filePath}`);
console.log(`Repeats: ${options.repeats}`);
console.log("Format: current compact WOA1 + HR/Cadence dictionary + GPS bitmap/columnar experiments");
console.log(
  `Compression: inner=${options.innerCompression}, outer=${options.outerCompression}, ` +
  `gzipLevel=${options.gzipLevel}, brotliQuality=${options.brotliQuality}\n`
);

for (let run = 1; run <= options.repeats; run += 1) {
  const totalStartedAt = performance.now();
  const source = await readFile(filePath);
  const readDoneAt = performance.now();
  const archive = unzipSync(new Uint8Array(source.buffer, source.byteOffset, source.byteLength));
  const unzipDoneAt = performance.now();
  const fitEntries = Object.entries(archive).filter(([name]) => name.toLowerCase().endsWith(".fit"));

  const cadenceStats = createDictionaryStats();
  const heartRateStats = createDictionaryStats();
  const distanceStats = createDistanceDeltaStats();
  const powerPforStats = createPowerPforStats();
  const gpsBitmapStats = createGpsBitmapStats();
  const outputEntries = [];
  let parseMs = 0;
  let woaMs = 0;
  let recordCount = 0;
  let extractedBytes = 0;
  let skippedCount = 0;
  let workoutRawBytes = 0;
  let workoutCompressedBytes = 0;
  let gpsRawBytes = 0;
  let gpsCompressedBytes = 0;
  let experimentMs = 0;
  const workoutColumnBytes = {
    distance: { raw: 0, gzip: 0 },
    power: { raw: 0, gzip: 0 },
    heartRate: { raw: 0, gzip: 0 },
    cadence: { raw: 0, gzip: 0 },
    speed: { raw: 0, gzip: 0 },
    altitude: { raw: 0, gzip: 0 },
  };

  const compressInner = createCompressionCallback(options.innerCompression, options);
  for (const [name, bytes] of fitEntries) {
    extractedBytes += bytes.length;
    const parseStartedAt = performance.now();
    const parsed = applyCompactEncodingOptions(parseFitBufferCompactBrowser(bytes), {
      powerStep: 4,
      cadenceStep: 2,
      hrStep: 2,
    });
    parseMs += performance.now() - parseStartedAt;
    const compact = parsed.compactRecords;
    if (!compact || compact.recordCount < MIN_WORKOUT_RECORD_COUNT) {
      skippedCount += 1;
      continue;
    }

    recordCount += compact.recordCount;
    const experimentStartedAt = performance.now();
    analyzeDictionaryColumn(cadenceStats, compact.cadencesRpm, options.gzipLevel);
    analyzeDictionaryColumn(heartRateStats, compact.heartRatesBpm, options.gzipLevel);
    experimentMs += performance.now() - experimentStartedAt;

    const woaStartedAt = performance.now();
    const woa = createWoa1FileFromCompact(parsed, {
      sourceName: name,
      sampleRateSeconds: options.gpsSampleRateSeconds,
      gpsCoordinateEncoding: "bitmap-columnar",
      powerEncoding: "delta8-q4w",
      distanceEncoding: "uint8-q05m",
      distanceBlockSize: options.distanceBlockSize,
      gpsBlockSize: options.gpsBlockSize,
      altitudeEncoding: "rle-delta-q1m",
      streamCodec: options.innerCompression,
      gpsTrackBlobCodec: options.innerCompression,
      compressWorkoutStream: compressInner,
      compressGpsTrack: compressInner,
    });
    woaMs += performance.now() - woaStartedAt;
    workoutRawBytes += Number(woa.meta?.blockBytes?.workout_stream_raw || 0);
    workoutCompressedBytes += woa.workoutStreamBytes.length;
    gpsRawBytes += Number(woa.meta?.blockBytes?.gps_track_raw || 0);
    gpsCompressedBytes += woa.gpsTrackBytes.length;
    for (const [key, payload] of [
      ["distance", woa.workoutStreamBlock.distancePayloadBytes],
      ["power", woa.workoutStreamBlock.powerPayloadBytes],
      ["heartRate", woa.workoutStreamBlock.heartRatePayloadBytes],
      ["cadence", woa.workoutStreamBlock.cadencePayloadBytes],
      ["speed", woa.workoutStreamBlock.speedPayloadBytes],
      ["altitude", woa.workoutStreamBlock.altitudePayloadBytes],
    ]) {
      workoutColumnBytes[key].raw += payload.byteLength;
      workoutColumnBytes[key].gzip += payload.byteLength > 0
        ? gzipSync(payload, { level: options.gzipLevel }).byteLength
        : 0;
    }
    analyzeDistanceDeltas(
      distanceStats,
      compact.distancesQ,
      woa.workoutStreamBlock.distancePayloadBytes,
      options.gzipLevel
    );
    const powerExperimentStartedAt = performance.now();
    analyzePowerPfor(
      powerPforStats,
      compact.powersW,
      woa.workoutStreamBlock.powerPayloadBytes,
      options.gzipLevel
    );
    experimentMs += performance.now() - powerExperimentStartedAt;
    const gpsExperimentStartedAt = performance.now();
    analyzeGpsBitmapCandidate(gpsBitmapStats, woa.gpsTrack, options.gpsBlockSize, options.gzipLevel);
    experimentMs += performance.now() - gpsExperimentStartedAt;
    outputEntries.push({ name: name.replace(/\.fit$/i, ".woa1"), bytes: woa.bytes });
  }

  const containerStartedAt = performance.now();
  const rawContainer = encodeWoaTransportContainer(outputEntries);
  const outerStartedAt = performance.now();
  const payload = compressBytes(rawContainer, options.outerCompression, options);
  const outerMs = performance.now() - outerStartedAt;
  const containerMs = performance.now() - containerStartedAt;
  const totalMs = performance.now() - totalStartedAt;

  if (run === options.repeats && options.writeOutput) {
    await writeFile(path.resolve(options.writeOutput), payload);
  }

  console.log(
    `Run ${run}: read=${formatMs(readDoneAt - totalStartedAt)}, ` +
    `unzip=${formatMs(unzipDoneAt - readDoneAt)}, parse=${formatMs(parseMs)}, ` +
    `woa=${formatMs(woaMs)}, experiments=${formatMs(experimentMs)}, ` +
    `container=${formatMs(containerMs)}, outer=${formatMs(outerMs)}, ` +
    `total=${formatMs(totalMs)}, entries=${fitEntries.length}, imported=${outputEntries.length}, ` +
    `skipped=${skippedCount}, records=${recordCount}`
  );
  console.log(
    `Sizes: zip=${formatMiB(source.length)}, extracted=${formatMiB(extractedBytes)}, ` +
    `workout=${formatMiB(workoutRawBytes)} -> ${formatMiB(workoutCompressedBytes)}, ` +
    `gps=${formatMiB(gpsRawBytes)} -> ${formatMiB(gpsCompressedBytes)}, ` +
    `container=${formatMiB(rawContainer.length)} -> payload=${formatMiB(payload.length)}`
  );
  console.log(formatDictionaryStats("Cadence delta dictionary", cadenceStats));
  console.log(formatDictionaryStats("Heart-rate delta dictionary", heartRateStats));
  console.log(formatDistanceDeltaStats(distanceStats));
  console.log(formatPowerPforStats(powerPforStats));
  console.log(formatPowerDeltaDistribution(powerPforStats));
  console.log(formatPowerNibbleStats(powerPforStats));
  console.log(
    "Workout columns (encoded raw -> individually gzip): " +
    Object.entries(workoutColumnBytes)
      .map(([name, sizes]) => `${name}=${formatMiB(sizes.raw)} -> ${formatMiB(sizes.gzip)}`)
      .join(", ")
  );
  console.log(formatGpsBitmapStats(gpsBitmapStats));
  console.log();
}
