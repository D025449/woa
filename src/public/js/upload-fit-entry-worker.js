import { parseFitBufferTypedBrowser } from "./fit-import-typed-browser.js";
import { createWoa1File } from "./woa-format.js";
import { gzipSync } from "/vendor/fflate/browser.js";

const MIN_WORKOUT_RECORD_COUNT = 300;

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

function isTooShortWorkout(parsed) {
  const recordCount = Number(parsed?.recordsTyped?.recordCount || 0);
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
  const powerStep = Math.max(1, Number.parseInt(String(encodingOptions.powerStep ?? 2), 10) || 2);
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
    const parsed = parseFitBufferTypedBrowser(arrayBuffer, {
      excludeStartTimes: existingStartTimes
    });
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
        recordCount: Number(parsed?.recordsTyped?.recordCount || 0)
      });
      return;
    }

    const adjustedParsed = applyEncodingOptions(parsed, encodingOptions);
    const buildStartedAt = nowMs();
    const result = createWoa1File(adjustedParsed, {
      sourceName: entryName,
      sampleRateSeconds: 5,
      compressWorkoutStream: (bytes, options = {}) => gzipSync(bytes, options),
      compressGpsTrack: (bytes, options = {}) => gzipSync(bytes, options)
    });
    const buildWoaMs = nowMs() - buildStartedAt;

    self.postMessage({
      type: "fit-entry-result",
      taskId,
      entryName,
      status: "completed",
      startTime: startTimeKey,
      recordCount: Number(parsed?.recordsTyped?.recordCount || 0),
      gpsPointCount: Number(result.gpsTrack?.pointCount || 0),
      woaBytes: result.bytes.buffer,
      timings: {
        parseMs,
        buildWoaMs,
        buildWoaStepsMs: result.timings || {}
      },
      workoutStreamStats: result.stats?.workoutStream || {}
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
