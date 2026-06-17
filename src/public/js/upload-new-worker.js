import { parseFitBufferTypedBrowser } from "./fit-import-typed-browser.js";
import { createWoa1File } from "./woa-format.js";
import { gzipSync, unzipSync, zipSync } from "/vendor/fflate/browser.js";

const PER_FILE_GZIP_LEVEL = 4;
const OUTER_ZIP_LEVEL = 4;
const DEFAULT_WOA_ZIP_CHUNK_SIZE = 50;

async function compressGzip(bytes, level = PER_FILE_GZIP_LEVEL) {
  return gzipSync(bytes, { level });
}

function nowMs() {
  return performance.now();
}

const DEFAULT_BENCH_REPEAT_COUNT = 10;

function isRealFitZipEntry(entryName) {
  const normalized = String(entryName || "").replace(/\\/g, "/");
  const baseName = normalized.split("/").pop() || "";

  if (!normalized.toLowerCase().endsWith(".fit")) {
    return false;
  }

  // macOS ZIP archives often contain AppleDouble metadata files like
  // "__MACOSX/.../._foo.fit", which are not real FIT payloads.
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

self.addEventListener("message", async (event) => {
  const { type, fileName, arrayBuffer, repeatCount = DEFAULT_BENCH_REPEAT_COUNT } = event.data || {};

  if (!arrayBuffer) {
    return;
  }

  try {
    if (type === "convert-zip-to-woa-zip") {
      await handleZipConversion({
        fileName,
        arrayBuffer,
        chunkMode: !!event.data?.chunkMode,
        chunkSize: Number(event.data?.chunkSize) || DEFAULT_WOA_ZIP_CHUNK_SIZE
      });
      return;
    }

    if (type !== "convert-fit-to-woa") {
      return;
    }

    const startedAt = nowMs();
    const parseSamplesMs = [];
    const buildSamplesMs = [];
    const gzipSamplesMs = [];
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
      const parsed = parseFitBufferTypedBrowser(arrayBuffer);
      parseSamplesMs.push(nowMs() - parseStartedAt);
      finalParsed = parsed;

      self.postMessage({
        type: "phase",
        phase: "building-woa",
        iteration: iteration + 1,
        totalIterations: normalizedRepeatCount
      });

      const woaStartedAt = nowMs();
      const result = createWoa1File(parsed, {
        sourceName: fileName,
        sampleRateSeconds: 5
      });
      buildSamplesMs.push(nowMs() - woaStartedAt);
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

function chunkArray(values = [], chunkSize = DEFAULT_WOA_ZIP_CHUNK_SIZE) {
  const size = Math.max(1, Number(chunkSize) || DEFAULT_WOA_ZIP_CHUNK_SIZE);
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

async function handleZipConversion({ fileName, arrayBuffer, chunkMode = false, chunkSize = DEFAULT_WOA_ZIP_CHUNK_SIZE }) {
  const startedAt = nowMs();
  self.postMessage({
    type: "phase",
    phase: "reading-zip"
  });

  const zipBytes = new Uint8Array(arrayBuffer);
  const archive = unzipSync(zipBytes);
  const entryNames = Object.keys(archive);
  const fitEntryNames = entryNames
    .filter(isRealFitZipEntry)
    .sort((left, right) => left.localeCompare(right));

  if (fitEntryNames.length === 0) {
    throw new Error("The selected ZIP file does not contain any .fit entries");
  }

  const woaEntries = [];
  const parseSamplesMs = [];
  const buildSamplesMs = [];
  const gzipSamplesMs = [];
  const skippedEntries = [];
  let totalRecordCount = 0;
  let totalGpsPointCount = 0;
  let convertedEntries = 0;

  for (let index = 0; index < fitEntryNames.length; index += 1) {
    const entryName = fitEntryNames[index];
    const fitBytes = archive[entryName];

    self.postMessage({
      type: "phase",
      phase: "zip-entry",
      entryName,
      processedEntries: index,
      totalEntries: fitEntryNames.length
    });

    try {
      const parseStartedAt = nowMs();
      const parsed = parseFitBufferTypedBrowser(fitBytes.buffer.slice(
        fitBytes.byteOffset,
        fitBytes.byteOffset + fitBytes.byteLength
      ));
      parseSamplesMs.push(nowMs() - parseStartedAt);

      const buildStartedAt = nowMs();
      const result = createWoa1File(parsed, {
        sourceName: entryName,
        sampleRateSeconds: 5
      });
      buildSamplesMs.push(nowMs() - buildStartedAt);
      const outputEntryName = entryName.replace(/\.fit$/i, ".woa1");
      woaEntries.push({
        name: outputEntryName,
        bytes: result.bytes
      });
      totalRecordCount += Number(parsed.recordsTyped?.recordCount || 0);
      totalGpsPointCount += Number(result.gpsTrack?.pointCount || 0);
      convertedEntries += 1;
    } catch (error) {
      skippedEntries.push({
        entryName,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  if (convertedEntries === 0) {
    throw new Error("No FIT entries in the ZIP could be converted to WOA1");
  }

  self.postMessage({
    type: "phase",
    phase: "building-zip",
    totalEntries: fitEntryNames.length,
    totalChunks: chunkMode ? chunkArray(woaEntries, chunkSize).length : 1
  });

  const zipBuildStartedAt = nowMs();
  if (chunkMode) {
    const entryChunks = chunkArray(woaEntries, chunkSize);
    const chunkArtifacts = [];

    for (let chunkIndex = 0; chunkIndex < entryChunks.length; chunkIndex += 1) {
      const chunkEntries = {};
      for (const entry of entryChunks[chunkIndex]) {
        chunkEntries[entry.name] = [entry.bytes, { level: OUTER_ZIP_LEVEL }];
      }
      const chunkZipBytes = zipSync(chunkEntries, { level: OUTER_ZIP_LEVEL });
      chunkArtifacts.push({
        chunkIndex,
        entryCount: entryChunks[chunkIndex].length,
        outputFileName: fileName.replace(/\.zip$/i, `.${String(chunkIndex + 1).padStart(3, "0")}.woa1.zip`),
        bytes: chunkZipBytes
      });
    }

    const zipBuildMs = nowMs() - zipBuildStartedAt;
    const totalElapsedMs = nowMs() - startedAt;
    const transferList = chunkArtifacts.map((artifact) => artifact.bytes.buffer);

    self.postMessage({
      type: "completed-zip-chunks",
      fileName,
      chunks: chunkArtifacts.map((artifact) => ({
        chunkIndex: artifact.chunkIndex,
        entryCount: artifact.entryCount,
        outputFileName: artifact.outputFileName,
        bytes: artifact.bytes.buffer
      })),
      stats: {
        fitEntries: fitEntryNames.length,
        convertedEntries,
        skippedEntries: skippedEntries.length,
        totalRecordCount,
        totalGpsPointCount,
        sourceZipBytes: zipBytes.byteLength,
        outputZipBytes: chunkArtifacts.reduce((sum, artifact) => sum + artifact.bytes.byteLength, 0),
        chunkCount: chunkArtifacts.length,
        chunkSize: Math.max(1, Number(chunkSize) || DEFAULT_WOA_ZIP_CHUNK_SIZE)
      },
      skipped: skippedEntries,
      timings: {
        parseMs: average(parseSamplesMs),
        buildWoaMs: average(buildSamplesMs),
        gzipMs: average(gzipSamplesMs),
        zipBuildMs,
        totalMs: totalElapsedMs
      }
    }, transferList);
    return;
  }

  const zipEntries = {};
  for (const entry of woaEntries) {
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
      fitEntries: fitEntryNames.length,
      convertedEntries,
      skippedEntries: skippedEntries.length,
      totalRecordCount,
      totalGpsPointCount,
      sourceZipBytes: zipBytes.byteLength,
      outputZipBytes: outputZipBytes.byteLength
    },
    skipped: skippedEntries,
    timings: {
      parseMs: average(parseSamplesMs),
      buildWoaMs: average(buildSamplesMs),
      gzipMs: average(gzipSamplesMs),
      zipBuildMs,
      totalMs: totalElapsedMs
    }
  }, [outputZipBytes.buffer]);
}
