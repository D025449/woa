import Workout from "../shared/Workout.js";
import {
  classifyWorkoutIntensityChronologically,
  extractWorkoutIntensityFeatures
} from "../shared/WorkoutIntensityClassifier.js";
import { decodeWorkoutIntensityModelFeatures } from "../shared/WorkoutIntensityModelCodec.js";
import pool from "./database.js";

export const INTENSITY_RECLASSIFICATION_WINDOW_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;
const UPDATE_BATCH_SIZE = 250;

function toTimestamp(value) {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function buildAffectedIntensityWindows(startTimes = [], windowDays = INTENSITY_RECLASSIFICATION_WINDOW_DAYS) {
  const durationMs = Math.max(1, Number(windowDays) || INTENSITY_RECLASSIFICATION_WINDOW_DAYS) * DAY_MS;
  const starts = [...new Set((Array.isArray(startTimes) ? startTimes : [])
    .map(toTimestamp)
    .filter((value) => value != null))].sort((left, right) => left - right);
  const windows = [];

  for (const start of starts) {
    const end = start + durationMs;
    const previous = windows.at(-1);
    if (previous && start <= previous.endMs) {
      previous.endMs = Math.max(previous.endMs, end);
      continue;
    }
    windows.push({ startMs: start, endMs: end });
  }

  return windows.map((window) => ({
    startTime: new Date(window.startMs).toISOString(),
    endTime: new Date(window.endMs).toISOString()
  }));
}

function classificationChanged(row, classification) {
  return String(row.intensity_profile || "unknown") !== classification.profile
    || Number(row.intensity_tags || 0) !== Number(classification.tags || 0)
    || String(row.intensity_structure || "unknown") !== classification.structure
    || String(row.intensity_dose || "unknown") !== classification.dose
    || Number(row.intensity_classifier_version || 0) !== Number(classification.classifierVersion || 0);
}

async function extractStoredWorkoutFeatures(row) {
  const workout = await Workout.fromCompressedWithCodec(row.stream, row.stream_codec || "brotli");
  return extractWorkoutIntensityFeatures({
    recordCount: workout.length,
    powerAtIndex: (index) => workout.getPowerAt(index),
    normalizedPower: Number(row.avg_normalized_power || workout.getNormalizedPower() || 0),
    effortLimit: 1,
    includeHistogram: false
  });
}

async function loadWindowRows(client, uid, window) {
  const historyStart = new Date(new Date(window.startTime).getTime() - (INTENSITY_RECLASSIFICATION_WINDOW_DAYS * DAY_MS));
  const result = await client.query(
    `
      SELECT
        id,
        start_time,
        stream,
        stream_codec,
        avg_normalized_power,
        intensity_profile,
        intensity_tags,
        intensity_structure,
        intensity_dose,
        intensity_classifier_version,
        intensity_model_features
      FROM workouts
      WHERE uid = $1
        AND workout_type <> 'motorsport'
        AND start_time >= $2
        AND start_time <= $3
        AND (intensity_model_features IS NOT NULL OR stream IS NOT NULL)
      ORDER BY start_time, id
    `,
    [uid, historyStart.toISOString(), window.endTime]
  );
  return result.rows;
}

export async function classifyIntensityWindowRows(
  rows,
  window,
  { extractFeatures = extractStoredWorkoutFeatures, changedWorkoutIds = [] } = {}
) {
  const startMs = new Date(window.startTime).getTime();
  const changedIdSet = new Set((Array.isArray(changedWorkoutIds) ? changedWorkoutIds : [])
    .filter((id) => id != null)
    .map(String));
  const entries = [];
  let decodedWorkoutCount = 0;
  let importedFeatureOnlyCount = 0;

  for (const row of rows) {
    const timestamp = new Date(row.start_time).getTime();
    if (timestamp < startMs) {
      const features = row.intensity_model_features
        ? decodeWorkoutIntensityModelFeatures(row.intensity_model_features)
        : null;
      if (features) {
        entries.push({ id: Number(row.id), startTime: row.start_time, features, classify: false, row });
      }
      continue;
    }
    if (changedIdSet.has(String(row.id))) {
      let features = row.intensity_model_features
        ? decodeWorkoutIntensityModelFeatures(row.intensity_model_features)
        : null;
      if (!features && row.stream) {
        features = await extractFeatures(row);
        decodedWorkoutCount += 1;
      }
      if (features) {
        entries.push({ id: Number(row.id), startTime: row.start_time, features, classify: false, row });
        importedFeatureOnlyCount += 1;
      }
      continue;
    }
    if (!row.stream) {
      const features = row.intensity_model_features
        ? decodeWorkoutIntensityModelFeatures(row.intensity_model_features)
        : null;
      if (features) {
        entries.push({ id: Number(row.id), startTime: row.start_time, features, classify: false, row });
      }
      continue;
    }
    const features = await extractFeatures(row);
    decodedWorkoutCount += 1;
    entries.push({ id: Number(row.id), startTime: row.start_time, features, row });
  }

  const changes = classifyWorkoutIntensityChronologically(entries, {
    windowDays: INTENSITY_RECLASSIFICATION_WINDOW_DAYS
  }).filter((entry) => entry.classification && classificationChanged(entry.row, entry.classification));

  return { changes, decodedWorkoutCount, importedFeatureOnlyCount };
}

async function updateClassifications(client, uid, changes) {
  let updatedWorkoutCount = 0;
  for (let index = 0; index < changes.length; index += UPDATE_BATCH_SIZE) {
    const batch = changes.slice(index, index + UPDATE_BATCH_SIZE);
    const result = await client.query(
      `
        UPDATE workouts AS workout
        SET
          intensity_profile = incoming.intensity_profile,
          intensity_tags = incoming.intensity_tags,
          intensity_structure = incoming.intensity_structure,
          intensity_dose = incoming.intensity_dose,
          intensity_classifier_version = incoming.intensity_classifier_version
        FROM UNNEST(
          $2::bigint[],
          $3::text[],
          $4::smallint[],
          $5::text[],
          $6::text[],
          $7::smallint[]
        ) AS incoming(
          id,
          intensity_profile,
          intensity_tags,
          intensity_structure,
          intensity_dose,
          intensity_classifier_version
        )
        WHERE workout.uid = $1
          AND workout.id = incoming.id
      `,
      [
        uid,
        batch.map((entry) => entry.id),
        batch.map((entry) => entry.classification.profile),
        batch.map((entry) => entry.classification.tags),
        batch.map((entry) => entry.classification.structure),
        batch.map((entry) => entry.classification.dose),
        batch.map((entry) => entry.classification.classifierVersion)
      ]
    );
    updatedWorkoutCount += Number(result.rowCount || 0);
  }
  return updatedWorkoutCount;
}

export async function reclassifyWorkoutIntensity({
  uid,
  startTimes,
  changedWorkoutIds = [],
  db = pool,
  extractFeatures = extractStoredWorkoutFeatures
}) {
  const windows = buildAffectedIntensityWindows(startTimes);
  if (!uid || windows.length === 0) {
    return {
      windowCount: 0,
      decodedWorkoutCount: 0,
      importedFeatureOnlyCount: 0,
      changedWorkoutCount: 0,
      updatedWorkoutCount: 0
    };
  }

  const client = await db.connect();
  const startedAt = performance.now();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('workout-intensity:' || $1::text, 0))",
      [uid]
    );

    let decodedWorkoutCount = 0;
    let importedFeatureOnlyCount = 0;
    const changesByWorkoutId = new Map();
    for (const window of windows) {
      const rows = await loadWindowRows(client, uid, window);
      const classified = await classifyIntensityWindowRows(rows, window, {
        extractFeatures,
        changedWorkoutIds
      });
      decodedWorkoutCount += classified.decodedWorkoutCount;
      importedFeatureOnlyCount += classified.importedFeatureOnlyCount;
      for (const change of classified.changes) changesByWorkoutId.set(change.id, change);
    }

    const changes = [...changesByWorkoutId.values()];
    const updatedWorkoutCount = await updateClassifications(client, uid, changes);
    await client.query("COMMIT");
    return {
      windowCount: windows.length,
      decodedWorkoutCount,
      importedFeatureOnlyCount,
      changedWorkoutCount: changes.length,
      updatedWorkoutCount,
      elapsedMs: Number((performance.now() - startedAt).toFixed(1)),
      windows
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
