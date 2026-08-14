import fs from "node:fs";
import { performance } from "node:perf_hooks";

import dotenv from "dotenv";

import Workout from "../shared/Workout.js";
import {
  classifyWorkoutIntensityChronologically,
  extractWorkoutIntensityFeatures
} from "../shared/WorkoutIntensityClassifier.js";

function loadEnv() {
  const nodeEnv = process.env.NODE_ENV || "development";
  for (const path of [`.env.${nodeEnv}`, ".env"]) {
    if (!fs.existsSync(path)) continue;
    dotenv.config({ path, override: false });
    return path;
  }
  return null;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const options = { userId: null, outputPath: null, windowDays: 365 };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--user" && args[index + 1]) {
      options.userId = Number.parseInt(args[index + 1], 10);
      index += 1;
    } else if (argument === "--output" && args[index + 1]) {
      options.outputPath = args[index + 1];
      index += 1;
    } else if (argument === "--window-days" && args[index + 1]) {
      options.windowDays = Math.max(30, Number.parseInt(args[index + 1], 10) || options.windowDays);
      index += 1;
    }
  }
  if (!Number.isInteger(options.userId) || options.userId <= 0) {
    throw new Error("Usage: node src/scripts/analyze-workout-intensity.js --user <uid> [--output report.json]");
  }
  return options;
}

function increment(target, key) {
  target[key] = Number(target[key] || 0) + 1;
}

function compactResult(entry) {
  const classification = entry.classification;
  return {
    id: Number(entry.id),
    startTime: new Date(entry.startTime).toISOString(),
    workoutType: entry.workoutType,
    terrainProfile: entry.terrainProfile,
    durationSeconds: entry.features.recordCount,
    averagePower: entry.features.averagePower,
    normalizedPower: entry.features.normalizedPower,
    profile: classification.profile,
    structure: classification.structure,
    dose: classification.dose,
    confidence: classification.confidence,
    ftp: classification.ftp ?? null,
    intensityFactor: classification.intensityFactor ?? null,
    loadScore: classification.loadScore ?? null,
    evidence: classification.evidence ?? null,
    modelPower: Object.fromEntries(Object.entries(entry.model?.powerDurationCurve || {}).map(([duration, power]) => [
      duration,
      power == null ? null : Math.round(Number(power))
    ])),
    bestPower: Object.fromEntries(Object.entries(entry.features.bestEfforts).map(([duration, efforts]) => [
      duration,
      efforts[0]?.avgPower ?? null
    ]))
  };
}

function buildReport(entries, elapsedMs, userId, windowDays) {
  const counts = { profile: {}, structure: {}, dose: {} };
  for (const entry of entries) {
    increment(counts.profile, entry.classification.profile);
    increment(counts.structure, entry.classification.structure);
    increment(counts.dose, entry.classification.dose);
  }

  const examples = {};
  for (const profile of Object.keys(counts.profile)) {
    examples[profile] = entries
      .filter((entry) => entry.classification.profile === profile)
      .sort((left, right) => {
        const confidenceDifference = right.classification.confidence - left.classification.confidence;
        if (confidenceDifference !== 0) return confidenceDifference;
        return new Date(right.startTime).getTime() - new Date(left.startTime).getTime();
      })
      .slice(0, 12)
      .map(compactResult);
  }

  return {
    generatedAt: new Date().toISOString(),
    userId,
    workoutCount: entries.length,
    windowDays,
    elapsedMs: Number(elapsedMs.toFixed(1)),
    counts,
    examples,
    recent: entries.slice(-30).reverse().map(compactResult),
    workouts: entries.map(compactResult)
  };
}

async function run() {
  loadEnv();
  const options = parseArgs();
  const { default: pool } = await import("../services/database.js");
  const startedAt = performance.now();
  try {
    const result = await pool.query(`
      SELECT
        id,
        start_time,
        stream,
        stream_codec,
        avg_normalized_power,
        workout_type,
        terrain_profile
      FROM workouts
      WHERE uid = $1
        AND stream IS NOT NULL
        AND workout_type <> 'motorsport'
      ORDER BY start_time, id
    `, [options.userId]);

    const featureEntries = [];
    for (let index = 0; index < result.rows.length; index += 1) {
      const row = result.rows[index];
      const workout = await Workout.fromCompressedWithCodec(row.stream, row.stream_codec || "brotli");
      const features = extractWorkoutIntensityFeatures({
        recordCount: workout.length,
        powerAtIndex: (sampleIndex) => workout.getPowerAt(sampleIndex),
        normalizedPower: Number(row.avg_normalized_power || workout.getNormalizedPower() || 0)
      });
      featureEntries.push({
        id: Number(row.id),
        startTime: row.start_time,
        workoutType: row.workout_type,
        terrainProfile: row.terrain_profile,
        features
      });
      if ((index + 1) % 250 === 0) {
        process.stderr.write(`Analyzed ${index + 1}/${result.rows.length} workouts\n`);
      }
    }

    const classified = classifyWorkoutIntensityChronologically(featureEntries, {
      windowDays: options.windowDays
    });
    const report = buildReport(classified, performance.now() - startedAt, options.userId, options.windowDays);
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (options.outputPath) {
      fs.writeFileSync(options.outputPath, serialized);
      console.log(JSON.stringify({
        outputPath: options.outputPath,
        workoutCount: report.workoutCount,
        elapsedMs: report.elapsedMs,
        counts: report.counts
      }, null, 2));
    } else {
      process.stdout.write(serialized);
    }
  } finally {
    await pool.end();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
