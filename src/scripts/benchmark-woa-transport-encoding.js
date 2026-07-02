import fs from "node:fs/promises";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import { unzipSync, zipSync } from "fflate";

import "../config/env.js";

import { parseFitBufferTyped } from "../services/fit-import-typed-service.js";
import { createWoa1File } from "../public/js/woa-format.js";

const OUTER_ZIP_LEVEL = 0;
const DEFAULT_COMPARE_OUTER_ZIP_LEVELS = [0, 4];
const DEFAULT_COMPARE_GZIP_LEVELS = [0, 2, 4, 6, 9];
const MIN_WORKOUT_RECORD_COUNT = 300;
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();
const CUSTOM_CONTAINER_MAGIC = "WOAT";
const CUSTOM_CONTAINER_VERSION = 1;

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
    outerZipLevel: OUTER_ZIP_LEVEL,
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

    if (arg === "--outer-zip-level" && next) {
      out.outerZipLevel = Math.max(0, Math.min(9, Number.parseInt(next, 10) || OUTER_ZIP_LEVEL));
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

    if (arg === "--compare-outer-zip-levels" && next) {
      out.compareOuterZipLevels = next
        .split(",")
        .map((value) => Math.max(0, Math.min(9, Number.parseInt(value.trim(), 10))))
        .filter((value) => Number.isFinite(value));
      index += 1;
      continue;
    }

    if (arg === "--compare-gzip-levels" && next) {
      out.compareGzipLevels = next
        .split(",")
        .map((value) => Math.max(0, Math.min(9, Number.parseInt(value.trim(), 10))))
        .filter((value) => Number.isFinite(value));
      index += 1;
      continue;
    }
  }

  if (!out.file) {
    throw new Error("Missing required --file <fit-or-zip-file>");
  }

  if (out.gpsGzipLevel == null) {
    out.gpsGzipLevel = out.gzipLevel;
  }

  if (!Array.isArray(out.compareOuterZipLevels) || out.compareOuterZipLevels.length === 0) {
    out.compareOuterZipLevels = [...DEFAULT_COMPARE_OUTER_ZIP_LEVELS];
  }

  if (!Array.isArray(out.compareGzipLevels) || out.compareGzipLevels.length === 0) {
    out.compareGzipLevels = [...DEFAULT_COMPARE_GZIP_LEVELS];
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
      values: sourceArray
    };
  }

  const quantizedValues = new Float64Array(recordCount);

  for (let index = 0; index < recordCount; index += 1) {
    const value = Number(sourceArray[index]);
    if (!Number.isFinite(value)) {
      quantizedValues[index] = Number.NaN;
      continue;
    }
    quantizedValues[index] = Math.round(value / normalizedStep) * normalizedStep;
  }

  return {
    values: quantizedValues
  };
}

function applySeriesQuantization(parsed, quantizationOptions = {}) {
  const source = parsed?.recordsTyped;
  if (!source || !Number.isFinite(Number(source.recordCount))) {
    return parsed;
  }

  const recordCount = Number(source.recordCount);
  const power = quantizeSeries(source.powersW, recordCount, quantizationOptions.powerStep);
  const cadence = quantizeSeries(source.cadencesRpm, recordCount, quantizationOptions.cadenceStep);
  const heartRate = quantizeSeries(source.heartRatesBpm, recordCount, quantizationOptions.hrStep);
  const altitude = quantizeSeries(source.altitudesM, recordCount, quantizationOptions.altitudeStep, {
    activeThreshold: 0.25
  });

  return {
    ...parsed,
    recordsTyped: {
      ...source,
      powersW: power.values,
      cadencesRpm: cadence.values,
      heartRatesBpm: heartRate.values,
      altitudesM: altitude.values
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

function buildWoaFromParsed(parsed, sourceName, options) {
  return createWoa1File(parsed, {
    sourceName,
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
}

function buildZipVariants(outputEntries, levels) {
  const uniqueLevels = [...new Set(levels)];
  return uniqueLevels.map((level) => {
    const startedAt = nowMs();
    const bytes = zipSync(outputEntries, { level });
    return {
      outerZipLevel: level,
      bytes,
      zipBuildMs: nowMs() - startedAt
    };
  });
}

function writeUint32LE(target, offset, value) {
  const view = new DataView(target.buffer, target.byteOffset, target.byteLength);
  view.setUint32(offset, value >>> 0, true);
}

function buildCustomContainer(entries) {
  const preparedEntries = entries.map((entry) => {
    const nameBytes = TEXT_ENCODER.encode(entry.name);
    const payloadBytes = entry.bytes instanceof Uint8Array ? entry.bytes : new Uint8Array(entry.bytes);
    return {
      name: entry.name,
      nameBytes,
      payloadBytes
    };
  });

  let totalBytes = 4 + 1 + 4;
  for (const entry of preparedEntries) {
    totalBytes += 4 + entry.nameBytes.byteLength + 4 + entry.payloadBytes.byteLength;
  }

  const buffer = new Uint8Array(totalBytes);
  let offset = 0;

  buffer.set(TEXT_ENCODER.encode(CUSTOM_CONTAINER_MAGIC), offset);
  offset += 4;
  buffer[offset] = CUSTOM_CONTAINER_VERSION;
  offset += 1;
  writeUint32LE(buffer, offset, preparedEntries.length);
  offset += 4;

  for (const entry of preparedEntries) {
    writeUint32LE(buffer, offset, entry.nameBytes.byteLength);
    offset += 4;
    buffer.set(entry.nameBytes, offset);
    offset += entry.nameBytes.byteLength;
    writeUint32LE(buffer, offset, entry.payloadBytes.byteLength);
    offset += 4;
    buffer.set(entry.payloadBytes, offset);
    offset += entry.payloadBytes.byteLength;
  }

  return buffer;
}

function decodeCustomContainer(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.byteLength < 9) {
    throw new Error("Custom container too small");
  }

  const magic = TEXT_DECODER.decode(bytes.subarray(0, 4));
  if (magic !== CUSTOM_CONTAINER_MAGIC) {
    throw new Error(`Unexpected custom container magic: ${magic}`);
  }

  let offset = 4;
  const version = bytes[offset];
  offset += 1;
  if (version !== CUSTOM_CONTAINER_VERSION) {
    throw new Error(`Unsupported custom container version: ${version}`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entryCount = view.getUint32(offset, true);
  offset += 4;

  const entries = new Array(entryCount);
  for (let index = 0; index < entryCount; index += 1) {
    const nameLength = view.getUint32(offset, true);
    offset += 4;
    const name = TEXT_DECODER.decode(bytes.subarray(offset, offset + nameLength));
    offset += nameLength;
    const payloadLength = view.getUint32(offset, true);
    offset += 4;
    const payload = bytes.subarray(offset, offset + payloadLength);
    offset += payloadLength;
    entries[index] = {
      name,
      payloadLength: payload.byteLength,
      payload
    };
  }

  return entries;
}

function buildCustomContainerGzipVariants(rawBytes, levels) {
  const uniqueLevels = [...new Set(levels)];
  return uniqueLevels.map((level) => {
    const encodeStartedAt = nowMs();
    const gzipBytes = gzipSync(rawBytes, { level });
    const encodeMs = nowMs() - encodeStartedAt;

    const decodeStartedAt = nowMs();
    const inflated = gunzipSync(gzipBytes);
    const decodeContainerStartedAt = nowMs();
    const decodedEntries = decodeCustomContainer(inflated);
    const decodeContainerMs = nowMs() - decodeContainerStartedAt;
    const decodeMs = nowMs() - decodeStartedAt;

    return {
      gzipLevel: level,
      bytes: gzipBytes,
      encodeMs,
      decodeMs,
      gunzipOnlyMs: decodeMs - decodeContainerMs,
      decodeContainerMs,
      decodedEntries: decodedEntries.length
    };
  });
}

async function buildArtifact(inputBytes, resolvedPath, options) {
  const lower = resolvedPath.toLowerCase();

  if (lower.endsWith(".fit")) {
    const parseStartedAt = nowMs();
    const parsed = parseFitBufferTyped(inputBytes);
    const parseMs = nowMs() - parseStartedAt;
    const recordCount = Number(parsed?.recordsTyped?.recordCount || 0);
    if (recordCount < MIN_WORKOUT_RECORD_COUNT) {
      throw new Error(`Workout too short for benchmark: ${recordCount} records`);
    }

    const quantized = applySeriesQuantization(parsed, options);
    const buildStartedAt = nowMs();
    const woa = buildWoaFromParsed(quantized, path.basename(resolvedPath), options);
    const buildMs = nowMs() - buildStartedAt;

    return {
      artifactKind: "woa1-file",
      sourceKind: "fit",
      artifactBytes: woa.bytes,
      sourceBytes: inputBytes,
      sourceEntries: 1,
      convertedEntries: 1,
      parseMs,
      buildMs
    };
  }

  if (lower.endsWith(".zip")) {
    const unzipStartedAt = nowMs();
    const archive = unzipSync(new Uint8Array(inputBytes));
    const unzipMs = nowMs() - unzipStartedAt;
    const entryNames = Object.keys(archive);
    const fitEntries = entryNames
      .filter(isRealFitZipEntry)
      .sort((left, right) => left.localeCompare(right))
      .map((entryName) => ({
        name: entryName,
        bytes: archive[entryName]
      }));

    const outputEntries = {};
    const orderedEntries = [];
    const usedNames = new Set();
    let totalParseMs = 0;
    let totalBuildMs = 0;
    let convertedEntries = 0;

    for (const fitEntry of fitEntries) {
      const parseStartedAt = nowMs();
      const parsed = parseFitBufferTyped(fitEntry.bytes);
      totalParseMs += nowMs() - parseStartedAt;

      const recordCount = Number(parsed?.recordsTyped?.recordCount || 0);
      if (recordCount < MIN_WORKOUT_RECORD_COUNT) {
        continue;
      }

      const quantized = applySeriesQuantization(parsed, options);
      const buildStartedAt = nowMs();
      const woa = buildWoaFromParsed(quantized, fitEntry.name, options);
      totalBuildMs += nowMs() - buildStartedAt;

      const outputName = createUniqueEntryName(fitEntry.name.replace(/\.fit$/i, ".woa1"), usedNames);
      outputEntries[outputName] = woa.bytes;
      orderedEntries.push({
        name: outputName,
        bytes: woa.bytes
      });
      convertedEntries += 1;
    }
    const zipVariants = buildZipVariants(outputEntries, options.compareOuterZipLevels);
    const selectedVariant = zipVariants.find((variant) => variant.outerZipLevel === options.outerZipLevel)
      || zipVariants[0];
    const customContainerStartedAt = nowMs();
    const customContainerBytes = buildCustomContainer(orderedEntries);
    const customContainerBuildMs = nowMs() - customContainerStartedAt;
    const customContainerGzipVariants = buildCustomContainerGzipVariants(customContainerBytes, options.compareGzipLevels);
    const selectedCustomGzipVariant = customContainerGzipVariants.find((variant) => variant.gzipLevel === options.gzipLevel)
      || customContainerGzipVariants[0];

    return {
      artifactKind: "woa1-zip",
      sourceKind: "zip",
      artifactBytes: selectedVariant.bytes,
      sourceBytes: inputBytes,
      sourceEntries: fitEntries.length,
      convertedEntries,
      unzipMs,
      parseMs: totalParseMs,
      buildMs: totalBuildMs + zipVariants.reduce((sum, variant) => sum + variant.zipBuildMs, 0),
      zipBuildMs: selectedVariant.zipBuildMs,
      zipVariants,
      customContainer: {
        rawBytes: customContainerBytes,
        gzipBytes: selectedCustomGzipVariant.bytes,
        buildMs: customContainerBuildMs,
        gzipMs: selectedCustomGzipVariant.encodeMs,
        decodeMs: selectedCustomGzipVariant.decodeMs,
        gzipVariants: customContainerGzipVariants
      }
    };
  }

  throw new Error("Unsupported input file type. Use .fit or .zip");
}

function buildTransportVariants(artifactBytes, gzipLevel) {
  const artifactUint8 = artifactBytes instanceof Uint8Array
    ? artifactBytes
    : new Uint8Array(artifactBytes);
  const raw = Buffer.from(artifactUint8);

  const rawGzipStartedAt = nowMs();
  const rawGzip = gzipSync(raw, { level: gzipLevel });
  const rawGzipMs = nowMs() - rawGzipStartedAt;

  const base64StartedAt = nowMs();
  const base64Text = raw.toString("base64");
  const base64Bytes = TEXT_ENCODER.encode(base64Text);
  const base64Ms = nowMs() - base64StartedAt;

  const base64GzipStartedAt = nowMs();
  const base64Gzip = gzipSync(base64Bytes, { level: gzipLevel });
  const base64GzipMs = nowMs() - base64GzipStartedAt;

  const rawGzipBase64StartedAt = nowMs();
  const rawGzipBase64Text = Buffer.from(rawGzip).toString("base64");
  const rawGzipBase64Bytes = TEXT_ENCODER.encode(rawGzipBase64Text);
  const rawGzipBase64Ms = nowMs() - rawGzipBase64StartedAt;

  const rawGzipBase64GzipStartedAt = nowMs();
  const rawGzipBase64Gzip = gzipSync(rawGzipBase64Bytes, { level: gzipLevel });
  const rawGzipBase64GzipMs = nowMs() - rawGzipBase64GzipStartedAt;

  return [
    {
      variant: "raw-binary",
      bytes: raw.byteLength,
      ratioVsRawPct: 100,
      encodeMs: 0
    },
    {
      variant: "gzip(raw-binary)",
      bytes: rawGzip.byteLength,
      ratioVsRawPct: raw.byteLength > 0 ? (rawGzip.byteLength / raw.byteLength) * 100 : 0,
      encodeMs: rawGzipMs
    },
    {
      variant: "base64(raw-binary)",
      bytes: base64Bytes.byteLength,
      ratioVsRawPct: raw.byteLength > 0 ? (base64Bytes.byteLength / raw.byteLength) * 100 : 0,
      encodeMs: base64Ms
    },
    {
      variant: "gzip(base64(raw-binary))",
      bytes: base64Gzip.byteLength,
      ratioVsRawPct: raw.byteLength > 0 ? (base64Gzip.byteLength / raw.byteLength) * 100 : 0,
      encodeMs: base64Ms + base64GzipMs
    },
    {
      variant: "base64(gzip(raw-binary))",
      bytes: rawGzipBase64Bytes.byteLength,
      ratioVsRawPct: raw.byteLength > 0 ? (rawGzipBase64Bytes.byteLength / raw.byteLength) * 100 : 0,
      encodeMs: rawGzipMs + rawGzipBase64Ms
    },
    {
      variant: "gzip(base64(gzip(raw-binary)))",
      bytes: rawGzipBase64Gzip.byteLength,
      ratioVsRawPct: raw.byteLength > 0 ? (rawGzipBase64Gzip.byteLength / raw.byteLength) * 100 : 0,
      encodeMs: rawGzipMs + rawGzipBase64Ms + rawGzipBase64GzipMs
    }
  ];
}

async function run() {
  const options = parseArgs();
  const resolvedPath = path.resolve(options.file);
  const sourceBytes = await fs.readFile(resolvedPath);

  console.log("[woa-transport-bench] start", {
    file: resolvedPath,
    gzipLevel: options.gzipLevel,
    gpsGzipLevel: options.gpsGzipLevel,
    outerZipLevel: options.outerZipLevel,
    compareOuterZipLevels: options.compareOuterZipLevels,
    compareGzipLevels: options.compareGzipLevels,
    powerStep: options.powerStep,
    cadenceStep: options.cadenceStep,
    hrStep: options.hrStep,
    altitudeStep: options.altitudeStep,
    sampleRateSeconds: options.sampleRateSeconds
  });

  const artifact = await buildArtifact(sourceBytes, resolvedPath, options);
  const variants = buildTransportVariants(artifact.artifactBytes, options.gzipLevel);

  console.table(variants.map((variant) => ({
    variant: variant.variant,
    bytes: variant.bytes,
    ratioVsRawPct: Number(variant.ratioVsRawPct.toFixed(1)),
    encodeMs: Number(variant.encodeMs.toFixed(3))
  })));

  if (Array.isArray(artifact.zipVariants) && artifact.zipVariants.length > 0) {
    const baselineBytes = artifact.zipVariants[0].bytes.byteLength;
    console.table(artifact.zipVariants.map((variant) => ({
      outerZipLevel: variant.outerZipLevel,
      bytes: variant.bytes.byteLength,
      ratioVsLevel0Pct: baselineBytes > 0 ? Number(((variant.bytes.byteLength / baselineBytes) * 100).toFixed(1)) : 0,
      zipBuildMs: Number(variant.zipBuildMs.toFixed(3))
    })));
  }

  if (artifact.customContainer) {
    const level0Variant = artifact.zipVariants?.find((variant) => variant.outerZipLevel === 0) || artifact.zipVariants?.[0];
    const level0Bytes = level0Variant?.bytes?.byteLength || 0;
    console.table([{
      variant: "custom-container(raw)",
      bytes: artifact.customContainer.rawBytes.byteLength,
      ratioVsZipLevel0Pct: level0Bytes > 0 ? Number(((artifact.customContainer.rawBytes.byteLength / level0Bytes) * 100).toFixed(1)) : 0,
      buildMs: Number(artifact.customContainer.buildMs.toFixed(3))
    }]);
    console.table(artifact.customContainer.gzipVariants.map((variant) => ({
      gzipLevel: variant.gzipLevel,
      bytes: variant.bytes.byteLength,
      ratioVsZipLevel0Pct: level0Bytes > 0 ? Number(((variant.bytes.byteLength / level0Bytes) * 100).toFixed(1)) : 0,
      encodeMs: Number(variant.encodeMs.toFixed(3)),
      decodeMs: Number(variant.decodeMs.toFixed(3)),
      gunzipOnlyMs: Number(variant.gunzipOnlyMs.toFixed(3)),
      decodeContainerMs: Number(variant.decodeContainerMs.toFixed(3)),
      decodedEntries: variant.decodedEntries
    })));
  }

  console.log("Notes:");
  console.log(`- Source kind: ${artifact.sourceKind}`);
  console.log(`- Artifact kind: ${artifact.artifactKind}`);
  console.log(`- Source bytes: ${formatBytes(artifact.sourceBytes.byteLength)}`);
  console.log(`- Artifact bytes: ${formatBytes(artifact.artifactBytes.byteLength)}`);
  console.log(`- Source FIT entries: ${artifact.sourceEntries}`);
  console.log(`- Converted entries: ${artifact.convertedEntries}`);
  if (Number.isFinite(artifact.unzipMs)) {
    console.log(`- Unzip source: ${formatMs(artifact.unzipMs)}`);
  }
  console.log(`- Parse source FIT: ${formatMs(artifact.parseMs)}`);
  console.log(`- Build WOA artifact: ${formatMs(artifact.buildMs)}`);
  if (Array.isArray(artifact.zipVariants) && artifact.zipVariants.length > 0) {
    for (const variant of artifact.zipVariants) {
      console.log(`- Outer ZIP level ${variant.outerZipLevel}: ${formatBytes(variant.bytes.byteLength)} (build ${formatMs(variant.zipBuildMs)})`);
    }
  }
  if (artifact.customContainer) {
    console.log(`- Custom container raw: ${formatBytes(artifact.customContainer.rawBytes.byteLength)} (build ${formatMs(artifact.customContainer.buildMs)})`);
    for (const variant of artifact.customContainer.gzipVariants) {
      console.log(`- Custom container + gzip level ${variant.gzipLevel}: ${formatBytes(variant.bytes.byteLength)} (encode ${formatMs(variant.encodeMs)}, decode ${formatMs(variant.decodeMs)})`);
    }
  }
  for (const variant of variants) {
    console.log(`- ${variant.variant}: ${formatBytes(variant.bytes)} (${variant.ratioVsRawPct.toFixed(1)}% of raw, encode ${formatMs(variant.encodeMs)})`);
  }
}

run().catch((error) => {
  console.error("[woa-transport-bench] failed", error);
  process.exit(1);
});
