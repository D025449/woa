import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const rebuildWorkoutSql = fs.readFileSync(
  new URL("../src/migrations/002_workouts.sql", import.meta.url),
  "utf8"
);
const additiveSql = fs.readFileSync(
  new URL("../src/migrations/081_training_activities.sql", import.meta.url),
  "utf8"
);
const normalizedActivitySql = fs.readFileSync(
  new URL("../src/migrations/082_normalize_training_activity_type.sql", import.meta.url),
  "utf8"
);
const intervalSql = fs.readFileSync(
  new URL("../src/migrations/083_training_activity_intervals.sql", import.meta.url),
  "utf8"
);
const fileDbSource = fs.readFileSync(
  new URL("../src/services/fileDBService.js", import.meta.url),
  "utf8"
);
const workoutDbSource = fs.readFileSync(
  new URL("../src/services/workoutDBService.js", import.meta.url),
  "utf8"
);
const workoutServiceSource = fs.readFileSync(
  new URL("../src/public/js/workout-service.js", import.meta.url),
  "utf8"
);

test("full rebuild and additive migration define nullable workout RPE", () => {
  assert.match(rebuildWorkoutSql, /perceived_exertion SMALLINT/u);
  assert.match(rebuildWorkoutSql, /perceived_exertion BETWEEN 1 AND 10/u);
  assert.match(additiveSql, /ADD COLUMN IF NOT EXISTS perceived_exertion SMALLINT/u);
  assert.match(additiveSql, /workouts_perceived_exertion_check/u);
});

test("training activities support manual load without synthetic workout streams", () => {
  assert.match(additiveSql, /CREATE TABLE IF NOT EXISTS training_activities/u);
  assert.match(additiveSql, /activity_type IN \('cycling', 'strength_training', 'mobility', 'other'\)/u);
  assert.match(additiveSql, /activity_type = 'cycling' AND workout_type IS NOT NULL/u);
  assert.match(additiveSql, /estimated_tss IS NULL OR estimated_tss >= 0/u);
  assert.match(additiveSql, /strength_focus IS NULL OR activity_type = 'strength_training'/u);
  assert.match(additiveSql, /ON training_activities \(uid, start_time DESC, id DESC\)/u);
  assert.doesNotMatch(additiveSql, /\bstream\b/u);
  assert.doesNotMatch(additiveSql, /\bDROP\b/u);
});

test("follow-up migration normalizes the already-created empty activity model", () => {
  assert.match(normalizedActivitySql, /ADD COLUMN IF NOT EXISTS workout_type TEXT/u);
  assert.match(normalizedActivitySql, /SET\s+activity_type = 'cycling',\s+workout_type = COALESCE\(workout_type, 'indoor'\)/u);
  assert.doesNotMatch(normalizedActivitySql, /CASCADE/u);
  assert.doesNotMatch(normalizedActivitySql, /DROP TABLE/u);
});

test("manual cycling intervals are additive child rows with reproducible load fields", () => {
  assert.match(additiveSql, /CREATE TABLE IF NOT EXISTS training_activity_intervals/u);
  assert.match(additiveSql, /REFERENCES training_activities\(id\) ON DELETE CASCADE/u);
  assert.match(additiveSql, /avg_normalized_power DOUBLE PRECISION/u);
  assert.match(intervalSql, /ADD COLUMN IF NOT EXISTS avg_normalized_power/u);
  assert.match(intervalSql, /CREATE TABLE IF NOT EXISTS training_activity_intervals/u);
  assert.doesNotMatch(intervalSql, /DROP TABLE/u);
  assert.doesNotMatch(intervalSql, /DROP[^;]*CASCADE/u);
});

test("existing workout list and detail projections expose nullable RPE", () => {
  assert.match(fileDbSource, /workouts\.perceived_exertion/u);
  assert.match(workoutDbSource, /\bperceived_exertion\b/u);
  assert.match(workoutServiceSource, /perceived_exertion: meta\?\.perceivedExertion/u);
});

test("CTL and ATL include only manual cycling activities", () => {
  assert.match(fileDbSource, /FROM training_activities[\s\S]*activity_type = 'cycling'/u);
  assert.match(fileDbSource, /duration_seconds AS total_timer_time/u);
  assert.match(fileDbSource, /avg_normalized_power/u);
  assert.match(fileDbSource, /tss_source === "manual"/u);
});
