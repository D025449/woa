import assert from "node:assert/strict";
import test from "node:test";

import {
  buildManualActivityArchiveManifest,
  buildManualActivityDocument,
  manualActivityFileName,
  parseManualActivityDocument,
  validateManualActivityArchiveManifest
} from "../src/shared/ManualActivityExchange.js";

const storedActivity = {
  id: 91,
  uid: 7,
  start_time: "2026-08-14T16:30:00.000Z",
  duration_seconds: 2400,
  activity_type: "cycling",
  workout_type: "indoor",
  title: "3 x 2 minutes",
  notes: "Gym bike",
  perceived_exertion: 8,
  average_power: 172,
  avg_normalized_power: 205,
  estimated_tss: 42,
  tss_source: "power_model",
  ftp_used: 250,
  baseline_power_mode: "watts",
  baseline_power_value: 150,
  intervals: [{
    sequence_no: 0,
    repetitions: 3,
    work_duration_seconds: 120,
    recovery_duration_seconds: 120,
    power_mode: "watts",
    work_power_value: 320,
    recovery_power_value: 150
  }]
};

test("manual activity exchange round-trips source fields without database or derived values", () => {
  const document = buildManualActivityDocument(storedActivity, "2026-08-14T17:00:00.000Z");
  assert.equal(document.format, "WOA_MANUAL_ACTIVITY");
  assert.equal(document.version, 1);
  assert.equal(document.activity.estimatedTssOverride, null);
  assert.equal("id" in document.activity, false);
  assert.equal("averagePower" in document.activity, false);
  assert.equal("normalizedPower" in document.activity, false);
  assert.deepEqual(parseManualActivityDocument(document), {
    startTime: "2026-08-14T16:30:00.000Z",
    durationSeconds: 2400,
    activityType: "cycling",
    workoutType: "indoor",
    title: "3 x 2 minutes",
    notes: "Gym bike",
    perceivedExertion: 8,
    baselinePowerMode: "watts",
    baselinePowerValue: 150,
    estimatedTss: null,
    strengthFocus: null,
    intervals: [{
      repetitions: 3,
      workDurationSeconds: 120,
      recoveryDurationSeconds: 120,
      powerMode: "watts",
      workPowerValue: 320,
      recoveryPowerValue: 150
    }]
  });
});

test("manual TSS overrides remain source data in the exchange document", () => {
  const document = buildManualActivityDocument({
    ...storedActivity,
    estimated_tss: 33.5,
    tss_source: "manual"
  });
  assert.equal(document.activity.estimatedTssOverride, 33.5);
});

test("manual activity archive manifest and filenames are deterministic", () => {
  const manifest = buildManualActivityArchiveManifest(2, "2026-08-14T17:00:00.000Z");
  assert.equal(validateManualActivityArchiveManifest(manifest, 2), manifest);
  assert.throws(() => validateManualActivityArchiveManifest(manifest, 1), /count/u);
  assert.equal(
    manualActivityFileName("2026-08-14T16:30:00.000Z", "0001"),
    "2026-08-14-16-30-00-0001-manual-activity.woa.json"
  );
});

test("manual activity exchange rejects unrelated JSON and unsupported versions", () => {
  assert.throws(() => parseManualActivityDocument({ format: "FIT" }), /format/u);
  assert.throws(() => parseManualActivityDocument({
    format: "WOA_MANUAL_ACTIVITY",
    version: 2,
    activity: {}
  }), /version/u);
});
