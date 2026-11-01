import { extractWorkoutIntensityFeatures } from "../shared/WorkoutIntensityClassifier.js";
import { encodeWorkoutIntensityModelFeatures } from "../shared/WorkoutIntensityModelCodec.js";
import { parentPort, workerData } from "node:worker_threads";
import { gzipSync } from "node:zlib";
import { applyCompactEncodingOptions, parseFitBufferCompactBrowser } from "../public/js/fit-import-compact-browser.js";
import { createWoa1FileFromCompactAsync } from "../public/js/woa-format-compact.js";

try {
  const parsed = applyCompactEncodingOptions(parseFitBufferCompactBrowser(workerData), {});
  if (parsed.compactRecords.recordCount < 300) {
    parentPort.postMessage({ skipped: true });
  } else {
  const records = parsed.compactRecords;
  const features = extractWorkoutIntensityFeatures({
    recordCount: records.recordCount, powerAtIndex: index => records.powersW?.[index],
    normalizedPower: parsed.sessions?.[0]?.normalized_power, missingValue: 0xffff,
    effortLimit: 1, includeHistogram: false, includeSparsePowerHistogram: true
  });
  const result = await createWoa1FileFromCompactAsync(parsed, {
    sourceName: "wahoo.fit", sampleRateSeconds: 5,
    intensityModelFeatureBytes: encodeWorkoutIntensityModelFeatures(features),
    powerHistogramBytes: features.powerHistogramBytes,
    gpsCoordinateEncoding: "bitmap-columnar", powerEncoding: "delta8-q4w",
    distanceEncoding: "uint8-q05m", altitudeEncoding: "rle-delta-q1m",
    streamCodec: "gzip", gpsTrackBlobCodec: "identity",
    compressWorkoutStream: async bytes => gzipSync(bytes, { level: 4 }), compressGpsTrack: null
  });
  parentPort.postMessage({ bytes: result.bytes });
  }
} catch { parentPort.postMessage({ error: true }); }
