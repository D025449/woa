import { parseFitBufferTypedBrowser } from "./fit-import-typed-browser.js";
import { applyCompactEncodingOptions, parseFitBufferCompactBrowser } from "./fit-import-compact-browser.js";
import { createWoa1File } from "./woa-format.js";
import { createWoa1FileFromCompactAsync } from "./woa-format-compact.js";
import { gzipSync } from "/vendor/fflate/browser.js";

const MIN_WORKOUT_RECORD_COUNT = 300;
const PER_FILE_GZIP_LEVEL = 4;

function canUseCompressionStream(format) {
  if (typeof CompressionStream === "undefined") {
    return false;
  }
  try {
    new CompressionStream(format);
    return true;
  } catch {
    return false;
  }
}

function resolveUploadCompressionCodec(encodingOptions = {}) {
  const requested = String(encodingOptions.uploadCompression || "auto").trim().toLowerCase();
  if (requested === "gzip") return "gzip";
  if (requested === "brotli" || requested === "br") {
    return canUseCompressionStream("brotli") ? "brotli" : "gzip";
  }
  return canUseCompressionStream("brotli") ? "brotli" : "gzip";
}

function resolveGzipEngine(encodingOptions = {}) {
  const requested = String(encodingOptions.uploadGzipEngine || "compression-stream").trim().toLowerCase();
  if (requested === "fflate") return "fflate";
  return canUseCompressionStream("gzip") ? "compression-stream" : "fflate";
}

async function compressWithCompressionStream(bytes, format) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function compressWithCodec(bytes, codec, options = {}, encodingOptions = {}) {
  if (codec === "brotli") {
    return compressWithCompressionStream(bytes, "brotli");
  }
  if (codec === "gzip" && resolveGzipEngine(encodingOptions) === "compression-stream") {
    return compressWithCompressionStream(bytes, "gzip");
  }
  return gzipSync(bytes, { level: Number(options.level || PER_FILE_GZIP_LEVEL) });
}

function nowMs() {
  return performance.now();
}

function buildParsedStartTimeKey(parsed) {
  const sessions = Array.isArray(parsed?.sessions) ? parsed.sessions : [];
  let minStartTimeMs = Number.POSITIVE_INFINITY;

  for (const session of sessions) {
    const value = Number(session?.start_time);
    if (Number.isFinite(value) && value < minStartTimeMs) {
      minStartTimeMs = value;
    }
  }

  return Number.isFinite(minStartTimeMs)
    ? new Date(minStartTimeMs).toISOString()
    : null;
}

function getParsedRecordCount(parsed) {
  return Number(
    parsed?.recordsTyped?.recordCount
      ?? parsed?.compactRecords?.recordCount
      ?? 0
  );
}

function getParsedSessionCount(parsed) {
  return Array.isArray(parsed?.sessions) ? parsed.sessions.length : 0;
}

async function createWoaFromParsed(parsed, parserVariant, entryName, encodingOptions) {
  if (parserVariant === "compact") {
    const adjustedParsed = applyCompactEncodingOptions(parsed, encodingOptions);
    const streamCodec = resolveUploadCompressionCodec(encodingOptions);
    return {
      adjustedParsed,
      result: await createWoa1FileFromCompactAsync(adjustedParsed, {
        sourceName: entryName,
        sampleRateSeconds: 5,
        powerEncoding: encodingOptions?.compactPowerEncoding === "raw16" ? "raw16" : "delta8-q4w",
        distanceEncoding: encodingOptions?.compactDistanceEncoding === "default" ? "default" : "uint8-q05m",
        streamCodec,
        gpsTrackBlobCodec: streamCodec,
        compressWorkoutStream: (bytes, options = {}) => compressWithCodec(bytes, streamCodec, options, encodingOptions),
        compressGpsTrack: (bytes, options = {}) => compressWithCodec(bytes, streamCodec, options, encodingOptions)
      })
    };
  }

  const adjustedParsed = applyEncodingOptions(parsed, encodingOptions);
  return {
    adjustedParsed,
    result: createWoa1File(adjustedParsed, {
      sourceName: entryName,
      sampleRateSeconds: 5,
      compressWorkoutStream: (bytes, options = {}) => gzipSync(bytes, options),
      compressGpsTrack: (bytes, options = {}) => gzipSync(bytes, options)
    })
  };
}

function isTooShortWorkout(parsed) {
  const recordCount = getParsedRecordCount(parsed);
  return recordCount < MIN_WORKOUT_RECORD_COUNT;
}

function quantizeSeries(sourceArray, recordCount, step) {
  const normalizedStep = Math.max(1, Number.parseInt(String(step ?? 1), 10) || 1);
  if (normalizedStep <= 1 || !sourceArray || recordCount <= 0) {
    return sourceArray;
  }

  const quantizedValues = new Float64Array(recordCount);
  for (let index = 0; index < recordCount; index += 1) {
    const value = Number(sourceArray[index]);
    quantizedValues[index] = Number.isFinite(value)
      ? Math.round(value / normalizedStep) * normalizedStep
      : Number.NaN;
  }

  return quantizedValues;
}

function applyEncodingOptions(parsed, encodingOptions = {}) {
  const source = parsed?.recordsTyped;
  if (!source || !Number.isFinite(Number(source.recordCount))) {
    return parsed;
  }

  const recordCount = Number(source.recordCount);
  const powerStep = Math.max(1, Number.parseInt(String(encodingOptions.powerStep ?? 4), 10) || 4);
  const cadenceStep = Math.max(1, Number.parseInt(String(encodingOptions.cadenceStep ?? 2), 10) || 2);
  const hrStep = Math.max(1, Number.parseInt(String(encodingOptions.hrStep ?? 2), 10) || 2);
  return {
    ...parsed,
    recordsTyped: {
      ...source,
      powersW: quantizeSeries(source.powersW, recordCount, powerStep),
      cadencesRpm: quantizeSeries(source.cadencesRpm, recordCount, cadenceStep),
      heartRatesBpm: quantizeSeries(source.heartRatesBpm, recordCount, hrStep)
    }
  };
}

function getFitParserVariant(encodingOptions = {}) {
  return encodingOptions?.fitParserVariant === "compact" ? "compact" : "typed";
}

self.addEventListener("message", async (event) => {
  const {
    taskId,
    entryName,
    arrayBuffer,
    existingStartTimes = [],
    encodingOptions = {}
  } = event.data || {};

  try {
    const parseStartedAt = nowMs();
    const parserVariant = getFitParserVariant(encodingOptions);
    const parsed = parserVariant === "compact"
      ? parseFitBufferCompactBrowser(arrayBuffer, { excludeStartTimes: existingStartTimes })
      : parseFitBufferTypedBrowser(arrayBuffer, { excludeStartTimes: existingStartTimes });
    const parseMs = nowMs() - parseStartedAt;
    const startTimeKey = parsed?.skippedStartTime || buildParsedStartTimeKey(parsed);

    if (parsed?.skippedExisting) {
      self.postMessage({
        type: "fit-entry-result",
        taskId,
        entryName,
        status: "skipped-existing",
        startTime: startTimeKey,
        parseMs
      });
      return;
    }

    if (isTooShortWorkout(parsed)) {
      self.postMessage({
        type: "fit-entry-result",
        taskId,
        entryName,
        status: "skipped-too-short",
        startTime: startTimeKey,
        parseMs,
        recordCount: getParsedRecordCount(parsed)
      });
      return;
    }

    const buildStartedAt = nowMs();
    const { adjustedParsed, result } = await createWoaFromParsed(parsed, parserVariant, entryName, encodingOptions);
    const buildWoaMs = nowMs() - buildStartedAt;

    self.postMessage({
      type: "fit-entry-result",
      taskId,
      entryName,
      status: "completed",
      startTime: startTimeKey,
      recordCount: getParsedRecordCount(parsed),
      gpsPointCount: Number(result.gpsTrack?.pointCount || 0),
      woaBytes: result.bytes.buffer,
      timings: {
        parseMs,
        buildWoaMs,
        buildWoaStepsMs: result.timings || {},
        parserVariant
      },
      workoutStreamStats: result.stats?.workoutStream || {},
      sessionsCount: getParsedSessionCount(adjustedParsed)
    }, [result.bytes.buffer]);
  } catch (error) {
    self.postMessage({
      type: "fit-entry-result",
      taskId,
      entryName,
      status: "failed",
      error: error instanceof Error ? error.message : String(error)
    });
  }
});
