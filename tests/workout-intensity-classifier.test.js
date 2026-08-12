import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAthleteIntensityModel,
  classifyWorkoutIntensity,
  classifyWorkoutIntensityChronologically,
  extractWorkoutIntensityFeatures
} from "../src/shared/WorkoutIntensityClassifier.js";
import {
  INTENSITY_TAG_BITS,
  intensityProfilesFromTags
} from "../src/shared/WorkoutIntensityTags.js";

function featuresFromPower(power, normalizedPower = null) {
  return extractWorkoutIntensityFeatures({
    recordCount: power.length,
    powerAtIndex: (index) => power[index],
    normalizedPower
  });
}

function repeat(value, seconds) {
  return new Array(seconds).fill(value);
}

const establishedModel = {
  ftp: 250,
  confidence: 100,
  powerDurationCurve: {
    30: 500,
    60: 430,
    120: 380,
    240: 330,
    480: 290,
    900: 270,
    1200: 260
  }
};

test("orders the primary training stimulus before additional tags", () => {
  const tags = INTENSITY_TAG_BITS.tempo | INTENSITY_TAG_BITS.vo2max | INTENSITY_TAG_BITS.threshold;
  assert.deepEqual(
    intensityProfilesFromTags(tags, "vo2max"),
    ["vo2max", "tempo", "threshold"]
  );
});

test("uses the primary training stimulus when older data has no tag mask", () => {
  assert.deepEqual(intensityProfilesFromTags(0, "endurance"), ["endurance"]);
  assert.deepEqual(intensityProfilesFromTags(0, "unknown"), []);
});

test("extracts repeated non-overlapping duration efforts", () => {
  const power = [
    ...repeat(120, 300),
    ...repeat(310, 240),
    ...repeat(100, 240),
    ...repeat(300, 240),
    ...repeat(120, 300)
  ];
  const features = featuresFromPower(power);
  const efforts = features.bestEfforts[240];
  assert.equal(efforts.length, 3);
  assert.deepEqual(efforts.slice(0, 2).map((effort) => effort.avgPower), [310, 300]);
  assert.ok(features.normalizedPower > features.averagePower);
});

test("classifies an easy steady ride as recovery", () => {
  const classification = classifyWorkoutIntensity(featuresFromPower(repeat(120, 3600)), establishedModel);
  assert.equal(classification.profile, "recovery");
  assert.equal(classification.structure, "steady");
  assert.equal(classification.dose, "low");
});

test("classifies a steady aerobic ride as endurance", () => {
  const classification = classifyWorkoutIntensity(featuresFromPower(repeat(175, 5400)), establishedModel);
  assert.equal(classification.profile, "endurance");
  assert.equal(classification.structure, "steady");
  assert.equal(classification.dose, "moderate");
});

test("recognizes two four-minute VO2max intervals", () => {
  const power = [
    ...repeat(150, 900),
    ...repeat(310, 240),
    ...repeat(120, 360),
    ...repeat(305, 240),
    ...repeat(150, 900)
  ];
  const classification = classifyWorkoutIntensity(featuresFromPower(power), establishedModel);
  assert.equal(classification.profile, "vo2max");
  assert.equal(classification.structure, "intervals");
  assert.equal(classification.dose, "moderate");
  assert.equal(classification.evidence.vo2BlockCount, 2);
});

test("classifies a repeated 30/30 series as VO2max micro intervals", () => {
  const repetitions = [];
  for (let index = 0; index < 10; index += 1) {
    repetitions.push(...repeat(340, 30), ...repeat(110, 30));
  }
  const classification = classifyWorkoutIntensity(featuresFromPower([
    ...repeat(150, 600),
    ...repetitions,
    ...repeat(150, 600)
  ]), establishedModel);
  assert.equal(classification.profile, "vo2max");
  assert.equal(classification.structure, "intervals");
  assert.equal(classification.evidence.microIntervalSeriesCount, 1);
  assert.equal(classification.evidence.microIntervalRepetitionCount, 10);
  assert.equal(classification.evidence.anaerobicBlockCount, 0);
});

test("tags mixed VO2max and tempo stimuli while retaining one primary profile", () => {
  const repetitions = [];
  for (let index = 0; index < 10; index += 1) {
    repetitions.push(...repeat(340, 30), ...repeat(110, 30));
  }
  const classification = classifyWorkoutIntensity(featuresFromPower([
    ...repeat(150, 300),
    ...repetitions,
    ...repeat(205, 600),
    ...repeat(150, 300)
  ]), establishedModel);

  assert.equal(classification.profile, "vo2max");
  assert.notEqual(classification.tags & INTENSITY_TAG_BITS.vo2max, 0);
  assert.notEqual(classification.tags & INTENSITY_TAG_BITS.tempo, 0);
});

test("combines separate short-work interval sets across one workout", () => {
  const firstSet = [];
  const secondSet = [];
  for (let index = 0; index < 5; index += 1) {
    firstSet.push(...repeat(390, 30), ...repeat(110, 30));
    secondSet.push(...repeat(350, 60), ...repeat(110, 60));
  }
  const classification = classifyWorkoutIntensity(featuresFromPower([
    ...repeat(150, 600),
    ...firstSet,
    ...repeat(130, 480),
    ...secondSet,
    ...repeat(150, 600)
  ]), establishedModel);
  assert.equal(classification.profile, "vo2max");
  assert.equal(classification.structure, "intervals");
  assert.equal(classification.evidence.microIntervalSeriesCount, 2);
  assert.equal(classification.evidence.microIntervalRepetitionCount, 10);
  assert.equal(classification.evidence.microIntervalSeconds, 450);
});

test("does not infer VO2max from only four short repeated efforts", () => {
  const repetitions = [];
  for (let index = 0; index < 4; index += 1) {
    repetitions.push(...repeat(350, 60), ...repeat(110, 60));
  }
  const classification = classifyWorkoutIntensity(featuresFromPower([
    ...repeat(150, 600),
    ...repetitions,
    ...repeat(150, 600)
  ]), establishedModel);
  assert.notEqual(classification.profile, "vo2max");
  assert.equal(classification.evidence.microIntervalSeriesCount, 1);
  assert.equal(classification.evidence.microIntervalRepetitionCount, 4);
});

test("rejects irregular short efforts without a stable recovery rhythm", () => {
  const power = [
    ...repeat(150, 600),
    ...repeat(390, 30), ...repeat(110, 15),
    ...repeat(380, 30), ...repeat(110, 60),
    ...repeat(385, 30), ...repeat(110, 15),
    ...repeat(375, 30), ...repeat(110, 60),
    ...repeat(390, 30), ...repeat(110, 15),
    ...repeat(380, 30), ...repeat(110, 60),
    ...repeat(385, 30), ...repeat(150, 600)
  ];
  const classification = classifyWorkoutIntensity(featuresFromPower(power), establishedModel);
  assert.equal(classification.evidence.microIntervalSeriesCount, 0);
});

test("keeps maximal 30-second sprints with long recoveries anaerobic", () => {
  const power = [
    ...repeat(150, 600),
    ...repeat(480, 30),
    ...repeat(100, 240),
    ...repeat(470, 30),
    ...repeat(100, 240),
    ...repeat(460, 30),
    ...repeat(150, 600)
  ];
  const classification = classifyWorkoutIntensity(featuresFromPower(power), establishedModel);
  assert.equal(classification.profile, "anaerobic");
  assert.equal(classification.structure, "intervals");
  assert.equal(classification.evidence.microIntervalSeriesCount, 0);
  assert.equal(classification.evidence.anaerobicBlockCount, 3);
});

test("does not call ordinary hills VO2max when they are far below personal four-minute power", () => {
  const power = [
    ...repeat(150, 900),
    ...repeat(270, 240),
    ...repeat(130, 360),
    ...repeat(265, 240),
    ...repeat(150, 900)
  ];
  const classification = classifyWorkoutIntensity(featuresFromPower(power), establishedModel);
  assert.notEqual(classification.profile, "vo2max");
  assert.equal(classification.evidence.vo2BlockCount, 0);
});

test("builds a robust athlete model from workout features", () => {
  const entries = Array.from({ length: 20 }, (_, index) => ({
    features: featuresFromPower([
      ...repeat(150, 300),
      ...repeat(280 + index, 900),
      ...repeat(150, 300)
    ])
  }));
  const model = buildAthleteIntensityModel(entries);
  assert.ok(model.ftp > 200);
  assert.equal(model.confidence, 100);
  assert.equal(model.sampleCounts[900], 20);
});

test("chronological classification does not use future workouts", () => {
  const early = featuresFromPower(repeat(200, 1200));
  const middle = featuresFromPower(repeat(220, 1200));
  const future = featuresFromPower(repeat(400, 1200));
  const result = classifyWorkoutIntensityChronologically([
    { id: 3, startTime: "2026-06-01T00:00:00Z", features: future },
    { id: 1, startTime: "2026-05-01T00:00:00Z", features: early },
    { id: 2, startTime: "2026-05-15T00:00:00Z", features: middle }
  ]);
  assert.equal(result[0].id, 1);
  assert.equal(result[0].classification.reason, "missing_model");
  assert.equal(result[1].model.powerDurationCurve[1200], 200);
  assert.equal(result[2].model.powerDurationCurve[1200], 219);
});

test("historical model-only entries contribute without being reclassified", () => {
  const historical = featuresFromPower(repeat(250, 1200));
  const current = featuresFromPower(repeat(270, 1200));
  const result = classifyWorkoutIntensityChronologically([
    { id: 1, startTime: "2026-05-01T00:00:00Z", features: historical, classify: false },
    { id: 2, startTime: "2026-05-02T00:00:00Z", features: current }
  ]);

  assert.equal(result[0].classification, null);
  assert.equal(result[1].model.powerDurationCurve[1200], 250);
  assert.notEqual(result[1].classification.profile, "unknown");
});
