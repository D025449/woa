import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("full rebuild and additive migration define the optional power histogram", async () => {
  const [rebuild, migration] = await Promise.all([
    readFile(new URL("src/migrations/002_workouts.sql", root), "utf8"),
    readFile(new URL("src/migrations/084_workout_power_histogram.sql", root), "utf8")
  ]);

  assert.match(rebuild, /power_histogram\s+BYTEA/u);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS power_histogram BYTEA/u);
});
