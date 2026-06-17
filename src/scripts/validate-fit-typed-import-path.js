import fs from "node:fs/promises";
import path from "node:path";

import "../config/env.js";

import { parseFitBufferFast } from "../services/fit-parser-fast-service.js";
import { parseFitBufferTyped } from "../services/fit-import-typed-service.js";
import { processFitRecords } from "../services/fitService.js";

function parseToleranceFlag(args, flag, fallback) {
  const index = args.indexOf(flag);
  if (index === -1 || !args[index + 1]) {
    return fallback;
  }
  const parsed = Number(args[index + 1]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeNumber(value) {
  return Number.isFinite(value) ? Number(value) : Number.NaN;
}

function compareNumber(label, expected, actual, tolerance, mismatches) {
  const expectedValue = normalizeNumber(expected);
  const actualValue = normalizeNumber(actual);
  const bothNaN = Number.isNaN(expectedValue) && Number.isNaN(actualValue);
  if (bothNaN) {
    return;
  }
  if (Number.isNaN(expectedValue) !== Number.isNaN(actualValue)) {
    mismatches.push({ label, expected, actual, reason: "nan-mismatch" });
    return;
  }
  const delta = Math.abs(expectedValue - actualValue);
  if (delta > tolerance) {
    mismatches.push({ label, expected, actual, delta, tolerance });
  }
}

function compareScalar(label, expected, actual, mismatches) {
  if (expected !== actual) {
    mismatches.push({ label, expected, actual });
  }
}

function getParsedRecordCount(parsed) {
  if (Number.isFinite(Number(parsed?.recordsTyped?.recordCount))) {
    return Number(parsed.recordsTyped.recordCount);
  }
  return Array.isArray(parsed?.records) ? parsed.records.length : 0;
}

function toTypedPayloadFromParsed(parsed) {
  if (parsed?.recordsTyped) {
    return parsed;
  }

  const records = Array.isArray(parsed?.records) ? parsed.records : [];
  const length = records.length;

  const timestampsMs = new Float64Array(length);
  const distancesM = new Float64Array(length);
  const powersW = new Float64Array(length);
  const heartRatesBpm = new Float64Array(length);
  const cadencesRpm = new Float64Array(length);
  const speedsMps = new Float64Array(length);
  const altitudesM = new Float64Array(length);
  const positionLatsDeg = new Float64Array(length);
  const positionLongsDeg = new Float64Array(length);

  for (let index = 0; index < length; index += 1) {
    const record = records[index] || {};
    timestampsMs[index] = record.timestamp instanceof Date ? record.timestamp.getTime() : Number.NaN;
    distancesM[index] = Number.isFinite(record.distance) ? Number(record.distance) : Number.NaN;
    powersW[index] = Number.isFinite(record.power) ? Number(record.power) : Number.NaN;
    heartRatesBpm[index] = Number.isFinite(record.heart_rate) ? Number(record.heart_rate) : Number.NaN;
    cadencesRpm[index] = Number.isFinite(record.cadence) ? Number(record.cadence) : Number.NaN;
    speedsMps[index] = Number.isFinite(record.enhanced_speed)
      ? Number(record.enhanced_speed)
      : (Number.isFinite(record.speed) ? Number(record.speed) : Number.NaN);
    altitudesM[index] = Number.isFinite(record.enhanced_altitude)
      ? Number(record.enhanced_altitude)
      : (Number.isFinite(record.altitude) ? Number(record.altitude) : Number.NaN);
    positionLatsDeg[index] = Number.isFinite(record.position_lat) ? Number(record.position_lat) : Number.NaN;
    positionLongsDeg[index] = Number.isFinite(record.position_long) ? Number(record.position_long) : Number.NaN;
  }

  return {
    ...parsed,
    recordsTyped: {
      recordCount: length,
      timestampsMs,
      distancesM,
      powersW,
      heartRatesBpm,
      cadencesRpm,
      speedsMps,
      altitudesM,
      positionLatsDeg,
      positionLongsDeg
    },
    recordsAreSorted: true
  };
}

function summarizeWorkout(workoutObject) {
  return {
    length: workoutObject.length,
    startTime: workoutObject.getStartTime(),
    validGps: workoutObject.isValidGps(),
    normalizedPower: workoutObject.getNormalizedPower(),
    elevationGainTotal: workoutObject.getElevationGainTotal(),
    firstDistance: workoutObject.length > 0 ? workoutObject.getDistanceAt(0) : null,
    lastDistance: workoutObject.length > 0 ? workoutObject.getDistanceAt(workoutObject.length - 1) : null,
    firstAltitude: workoutObject.length > 0 ? workoutObject.getAltitudeAt(0) : null,
    lastAltitude: workoutObject.length > 0 ? workoutObject.getAltitudeAt(workoutObject.length - 1) : null
  };
}

function compareAggregated(expected, actual, tolerance, mismatches) {
  const numericFields = [
    "total_elapsed_time",
    "total_timer_time",
    "total_distance",
    "total_cycles",
    "total_work",
    "total_calories",
    "total_ascent",
    "total_descent",
    "avg_speed",
    "avg_power",
    "avg_heart_rate",
    "avg_cadence",
    "avg_normalized_power",
    "max_speed",
    "max_power",
    "max_heart_rate",
    "max_cadence",
    "nec_lat",
    "nec_long",
    "swc_lat",
    "swc_long"
  ];

  compareScalar("aggregated.start_time", expected.start_time, actual.start_time, mismatches);
  compareScalar("aggregated.end_time", expected.end_time, actual.end_time, mismatches);

  for (const field of numericFields) {
    compareNumber(`aggregated.${field}`, expected[field], actual[field], tolerance, mismatches);
  }
}

function compareGpsTrack(expected, actual, tolerance, mismatches) {
  compareScalar("gps.validGps", expected.validGps, actual.validGps, mismatches);
  compareScalar("gps.sampleRate", expected.sampleRate, actual.sampleRate, mismatches);
  compareScalar("gps.track.length", Array.isArray(expected.track) ? expected.track.length : -1, Array.isArray(actual.track) ? actual.track.length : -1, mismatches);
  compareScalar("gps.trackHash", expected.trackHash, actual.trackHash, mismatches);

  if (expected.bbox || actual.bbox) {
    compareNumber("gps.bbox.minLat", expected.bbox?.minLat, actual.bbox?.minLat, tolerance, mismatches);
    compareNumber("gps.bbox.maxLat", expected.bbox?.maxLat, actual.bbox?.maxLat, tolerance, mismatches);
    compareNumber("gps.bbox.minLng", expected.bbox?.minLng, actual.bbox?.minLng, tolerance, mismatches);
    compareNumber("gps.bbox.maxLng", expected.bbox?.maxLng, actual.bbox?.maxLng, tolerance, mismatches);
  }

  const expectedTrack = Array.isArray(expected.track) ? expected.track : [];
  const actualTrack = Array.isArray(actual.track) ? actual.track : [];
  const sampleIndexes = [0, Math.floor(expectedTrack.length / 2), Math.max(0, expectedTrack.length - 1)]
    .filter((value, index, values) => expectedTrack.length > 0 && values.indexOf(value) === index);

  for (const sampleIndex of sampleIndexes) {
    compareNumber(`gps.track[${sampleIndex}].lat`, expectedTrack[sampleIndex]?.[0], actualTrack[sampleIndex]?.[0], tolerance, mismatches);
    compareNumber(`gps.track[${sampleIndex}].lng`, expectedTrack[sampleIndex]?.[1], actualTrack[sampleIndex]?.[1], tolerance, mismatches);
  }
}

function compareWorkoutSummary(expected, actual, tolerance, mismatches) {
  compareScalar("workout.length", expected.length, actual.length, mismatches);
  compareScalar("workout.startTime", expected.startTime, actual.startTime, mismatches);
  compareScalar("workout.validGps", expected.validGps, actual.validGps, mismatches);
  compareNumber("workout.normalizedPower", expected.normalizedPower, actual.normalizedPower, tolerance, mismatches);
  compareNumber("workout.elevationGainTotal", expected.elevationGainTotal, actual.elevationGainTotal, tolerance, mismatches);
  compareNumber("workout.firstDistance", expected.firstDistance, actual.firstDistance, tolerance, mismatches);
  compareNumber("workout.lastDistance", expected.lastDistance, actual.lastDistance, tolerance, mismatches);
  compareNumber("workout.firstAltitude", expected.firstAltitude, actual.firstAltitude, tolerance, mismatches);
  compareNumber("workout.lastAltitude", expected.lastAltitude, actual.lastAltitude, tolerance, mismatches);
}

async function run() {
  const args = process.argv.slice(2);
  const inputPath = args[0];

  if (!inputPath) {
    console.error("Usage: node src/scripts/validate-fit-typed-import-path.js <fit-file> [--float-tolerance 0.0001]");
    process.exit(1);
  }

  const floatTolerance = parseToleranceFlag(args, "--float-tolerance", 0.0001);
  const resolvedPath = path.resolve(inputPath);
  const buffer = await fs.readFile(resolvedPath);

  const fastParsed = await parseFitBufferFast(buffer);
  const typedParsed = parseFitBufferTyped(buffer);
  const fastTypedPayload = toTypedPayloadFromParsed(fastParsed);

  const fastResult = processFitRecords(fastTypedPayload, { computeSegments: false, sourceName: resolvedPath });
  const typedResult = processFitRecords(typedParsed, { computeSegments: false, sourceName: resolvedPath });

  const mismatches = [];

  compareScalar("sessions.length", Array.isArray(fastParsed.sessions) ? fastParsed.sessions.length : 0, Array.isArray(typedParsed.sessions) ? typedParsed.sessions.length : 0, mismatches);
  compareScalar("records.length", getParsedRecordCount(fastParsed), getParsedRecordCount(typedParsed), mismatches);
  compareScalar("importGpsSource", fastResult.importGpsSource, typedResult.importGpsSource, mismatches);

  compareAggregated(fastResult.aggregated, typedResult.aggregated, floatTolerance, mismatches);
  compareGpsTrack(fastResult.gps_track, typedResult.gps_track, floatTolerance, mismatches);
  compareWorkoutSummary(
    summarizeWorkout(fastResult.workoutObject),
    summarizeWorkout(typedResult.workoutObject),
    floatTolerance,
    mismatches
  );

  console.table([
    {
      label: "sessions.length",
      fast: Array.isArray(fastParsed.sessions) ? fastParsed.sessions.length : 0,
      typed: Array.isArray(typedParsed.sessions) ? typedParsed.sessions.length : 0
    },
    {
      label: "records.length",
      fast: getParsedRecordCount(fastParsed),
      typed: getParsedRecordCount(typedParsed)
    },
    {
      label: "gps.validGps",
      fast: fastResult.gps_track.validGps,
      typed: typedResult.gps_track.validGps
    },
    {
      label: "gps.track.length",
      fast: Array.isArray(fastResult.gps_track.track) ? fastResult.gps_track.track.length : 0,
      typed: Array.isArray(typedResult.gps_track.track) ? typedResult.gps_track.track.length : 0
    },
    {
      label: "workout.length",
      fast: fastResult.workoutObject.length,
      typed: typedResult.workoutObject.length
    },
    {
      label: "workout.normalizedPower",
      fast: fastResult.workoutObject.getNormalizedPower(),
      typed: typedResult.workoutObject.getNormalizedPower()
    }
  ]);

  if (mismatches.length > 0) {
    console.log("Mismatch samples:");
    console.table(mismatches.slice(0, 20));
    process.exit(1);
  }

  console.log("[fit-typed-import-validate] import path matches fast parser within tolerance", {
    file: resolvedPath,
    floatTolerance
  });
}

run().catch((error) => {
  console.error("[fit-typed-import-validate] failed", error);
  process.exit(1);
});
