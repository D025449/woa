import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

test("manual workout segment deletion is scoped by segment, workout, owner, and type", async () => {
  const source = await fs.readFile(
    new URL("../src/services/fileDBService.js", import.meta.url),
    "utf8"
  );
  const method = source.match(
    /static async deleteManualSegment[\s\S]*?return result\.rows\[0\] \|\| null;/u
  )?.[0] || "";

  assert.match(method, /DELETE FROM workout_segments/u);
  assert.match(method, /WHERE id = \$1/u);
  assert.match(method, /AND wid = \$2/u);
  assert.match(method, /AND uid = \$3/u);
  assert.match(method, /AND segmenttype = 'manual'/u);
});

test("workout segment cards expose deletion only for owned persisted manual segments", async () => {
  const source = await fs.readFile(
    new URL("../src/public/js/dashboard-new-controller.js", import.meta.url),
    "utf8"
  );
  const predicate = source.match(
    /canDeleteWorkoutSegment\(workout, segment\)[\s\S]*?\n  \}/u
  )?.[0] || "";

  assert.match(predicate, /isOwner/u);
  assert.match(predicate, /!segment\?\.isGPSSegment/u);
  assert.match(predicate, /getSegmentVisibilityKey\(segment\) === "manual"/u);
  assert.match(predicate, /Number\.isInteger\(segmentId\)/u);
  assert.match(source, /data-workout-segment-delete/u);
  assert.match(source, /WorkoutService\.deleteManualSegment/u);
});

test("manual workout segment client uses the dedicated DELETE endpoint", async () => {
  const source = await fs.readFile(
    new URL("../src/public/js/workout-service.js", import.meta.url),
    "utf8"
  );

  assert.match(
    source,
    /workouts\/\$\{encodeURIComponent\(workoutId\)\}\/segments\/\$\{encodeURIComponent\(segmentId\)\}/u
  );
  assert.match(source, /\{ method: "DELETE" \}/u);
});

test("manual workout segment resize update is scoped by segment, workout, owner, and type", async () => {
  const source = await fs.readFile(
    new URL("../src/services/fileDBService.js", import.meta.url),
    "utf8"
  );
  const method = source.match(
    /static async updateManualSegment[\s\S]*?return result\.rows\[0\] \|\| null;/u
  )?.[0] || "";

  assert.match(method, /UPDATE workout_segments/u);
  assert.match(method, /WHERE id = \$1/u);
  assert.match(method, /AND wid = \$2/u);
  assert.match(method, /AND uid = \$3/u);
  assert.match(method, /AND segmenttype = 'manual'/u);
  assert.match(method, /avg_power = \$7/u);
  assert.match(method, /altimeters = \$11/u);
});

test("manual segment resize uses a PATCH autosave and recalculates its metrics", async () => {
  const source = await fs.readFile(
    new URL("../src/shared/SegmentService.js", import.meta.url),
    "utf8"
  );

  assert.match(source, /buildResizedManualSegment/u);
  assert.match(source, /workout\?\.workoutObject\?\.createNewSegment/u);
  assert.match(source, /method: 'PATCH'/u);
  assert.match(source, /JSON\.stringify\(\{ segment: updatedSegment \}\)/u);
});
