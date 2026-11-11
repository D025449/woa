import { gunzipSync, brotliDecompressSync } from "node:zlib";
import Workout from "../shared/Workout.js";
import FitExportService from "./fitExportService.js";
import { hasFitDeviceMetadata } from "../shared/FitDeviceMetadataCodec.js";
import { formatFitExportFileName } from "../shared/FitFileName.js";
import { decodePublicGpsTrack } from "./publicApiGpsService.js";
import { spawnPublicApiWorker } from "./publicApiLimits.js";

export const PUBLIC_FIT_LIMITS = Object.freeze({ streamBytes: 16 * 1024 * 1024,
  rawBytes: 32 * 1024 * 1024, records: 172800, gpsBlobBytes: 4 * 1024 * 1024,
  gpsRawBytes: 8 * 1024 * 1024, gpsSlots: 172800, metadataBytes: 64 * 1024,
  segments: 1000, phases: 50000, responseBytes: 32 * 1024 * 1024,
  timeoutMs: 15000, workers: 2, heapMb: 512 });

export function fitBudgetExceeded() {
  throw Object.assign(new Error("FIT export exceeds the configured budget."),
    { statusCode: 422, code: "fit_response_too_large" });
}

function decodeWorkout(blob, codec, limits) {
  if (!blob?.byteLength) throw new Error("Missing workout stream");
  if (blob.byteLength > limits.streamBytes) fitBudgetExceeded();
  let raw;
  try {
    const bytes = Buffer.from(blob);
    if (codec === "identity") raw = bytes;
    else if (codec === "gzip") raw = gunzipSync(bytes, { maxOutputLength: limits.rawBytes });
    else if (!codec || codec === "brotli") raw = brotliDecompressSync(bytes, { maxOutputLength: limits.rawBytes });
    else throw new Error("Unsupported workout stream codec");
  } catch (error) {
    if (error.code === "ERR_BUFFER_TOO_LARGE") fitBudgetExceeded();
    throw error;
  }
  if (raw.byteLength > limits.rawBytes) fitBudgetExceeded();
  if (raw.byteLength < 16) throw new Error("Invalid workout stream header");
  const magic = raw.subarray(0, 4).toString("ascii");
  const compact = ["WST9", "WS10", "WS11"].includes(magic);
  const count = compact ? raw.readUInt32LE(4) : raw.readUInt32BE(0);
  if (count > limits.records) fitBudgetExceeded();
  if (!count) throw new Error("Empty workout stream");
  if (compact) {
    const blocks = magic === "WS11" ? 9 : magic === "WS10" ? 8 : 6;
    const headerBytes = 20 + blocks * 4;
    if (raw.byteLength < headerBytes) throw new Error("Invalid workout stream header");
    let expectedBytes = headerBytes;
    for (let index = 0; index < blocks; index += 1) expectedBytes += raw.readUInt32LE(20 + index * 4);
    if (magic === "WS11" && raw.readUInt32LE(52) > limits.metadataBytes) fitBudgetExceeded();
    if (expectedBytes !== raw.byteLength) throw new Error("Invalid workout stream payload");
  } else {
    const version = raw[13];
    if (![2, 3, 4, 5].includes(version)) throw new Error("Unsupported workout stream version");
    const sampleBytes = version === 5 ? 8 : 20;
    if (raw.byteLength !== 16 + count * (sampleBytes + ((raw[14] & 1) ? 2 : 0))) {
      throw new Error("Invalid workout stream payload");
    }
  }
  const buffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  return Workout.fromBuffer(buffer);
}

// Uses the same generator, stored device fallback and lap inputs
// as the browser-session download, without browser authorization or logging.
export function buildPublicFit(row, segments, limits = PUBLIC_FIT_LIMITS) {
  if (!Array.isArray(segments) || segments.length > limits.segments
    || segments.reduce((sum, segment) => sum + (segment.phases?.length || 0), 0) > limits.phases) fitBudgetExceeded();
  if (Buffer.byteLength(JSON.stringify(row.fit_device_metadata ?? null)) > limits.metadataBytes) fitBudgetExceeded();
  const workout = decodeWorkout(row.stream, row.stream_codec, limits);
  let coordinates = [];
  if (row.validgps === true && row.gps_track_blob?.byteLength) {
    try {
      const track = decodePublicGpsTrack(row.gps_track_blob, row.gps_track_blob_codec, {
        blobBytes: limits.gpsBlobBytes, rawBytes: limits.gpsRawBytes, slots: limits.gpsSlots
      });
      // Keep sample positions: dropping a gap shifts all subsequent GPS times.
      coordinates = track.slots.map(point => point.valid && Number.isFinite(point.lat) && Number.isFinite(point.lng)
        && Math.abs(point.lat) <= 90 && Math.abs(point.lng) <= 180 ? [point.lat, point.lng] : [NaN, NaN]);
    } catch (error) {
      if (error.statusCode === 422) fitBudgetExceeded();
      throw error;
    }
  }
  const bytes = FitExportService.buildFitFromWorkout(workout, {
    serialNumber: Number(row.id), sampleRateGps: row.samplerategps,
    gpsCoordinates: coordinates, includeGps: row.validgps === true,
    gpsSource: row.gps_source ?? null,
    fitDeviceMetadata: workout.fitDeviceMetadata || (hasFitDeviceMetadata(row.fit_device_metadata) ? row.fit_device_metadata : null),
    normalizedPower: row.avg_normalized_power == null ? null : Number(row.avg_normalized_power),
    totalCalories: row.total_calories == null ? null : Number(row.total_calories),
    workoutType: row.workout_type || null, segments
  });
  if (bytes.byteLength > limits.responseBytes) fitBudgetExceeded();
  return { bytes, fileName: formatFitExportFileName(workout.getStartTime(), {
    timeZone: "UTC", fallbackName: "workout-" + row.id + ".fit"
  }) };
}

let activeWorkers = 0;

export async function runPublicFitWorker(row, segments, timeoutMs = PUBLIC_FIT_LIMITS.timeoutMs) {
  if (activeWorkers >= PUBLIC_FIT_LIMITS.workers) {
    throw Object.assign(new Error("FIT processing capacity exceeded."), { statusCode: 429, code: "rate_limited" });
  }
  activeWorkers += 1;
  try {
    return await spawnPublicApiWorker({
      workerUrl: new URL("../workers/public-api-fit-worker.js", import.meta.url),
      workerData: { row, segments },
      resourceLimits: { maxOldGenerationSizeMb: PUBLIC_FIT_LIMITS.heapMb },
      timeoutMs,
      validateMessage: message =>
        message.bytes instanceof Uint8Array && message.bytes.byteLength > 0
        && message.bytes.byteLength <= PUBLIC_FIT_LIMITS.responseBytes
        && typeof message.fileName === "string" && /^[a-zA-Z0-9.-]+[.]fit$/.test(message.fileName)
          ? { bytes: Buffer.from(message.bytes), fileName: message.fileName }
          : null,
      errorMessage: "FIT processing unavailable.",
      tooLargeCode: "fit_response_too_large",
    });
  } finally {
    activeWorkers -= 1;
  }
}
