import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAffectedIntensityWindows,
  classifyIntensityWindowRows,
  reclassifyWorkoutIntensity
} from "../src/services/workoutIntensityReclassificationService.js";
import { extractWorkoutIntensityFeatures } from "../src/shared/WorkoutIntensityClassifier.js";
import { encodeWorkoutIntensityModelFeatures } from "../src/shared/WorkoutIntensityModelCodec.js";

function repeat(value, seconds) {
  return new Array(seconds).fill(value);
}

function featuresFromPower(power) {
  return extractWorkoutIntensityFeatures({
    recordCount: power.length,
    powerAtIndex: (index) => power[index],
    effortLimit: 1,
    includeHistogram: false
  });
}

test("intensity reclassification merges overlapping 365-day windows", () => {
  assert.deepEqual(buildAffectedIntensityWindows([
    "2020-01-01T00:00:00Z",
    "2020-06-01T00:00:00Z",
    "2023-01-01T00:00:00Z"
  ]), [
    {
      startTime: "2020-01-01T00:00:00.000Z",
      endTime: "2021-06-01T00:00:00.000Z"
    },
    {
      startTime: "2023-01-01T00:00:00.000Z",
      endTime: "2024-01-01T00:00:00.000Z"
    }
  ]);
});

test("intensity reclassification uses IFM history and decodes only affected workouts", async () => {
  const historicalFeatures = featuresFromPower(repeat(250, 1200));
  const targetFeatures = featuresFromPower(repeat(175, 3600));
  let decodeCount = 0;
  const result = await classifyIntensityWindowRows([
    {
      id: 1,
      start_time: "2025-12-01T00:00:00Z",
      intensity_model_features: encodeWorkoutIntensityModelFeatures(historicalFeatures)
    },
    {
      id: 2,
      start_time: "2026-01-01T00:00:00Z",
      stream: new Uint8Array([1]),
      intensity_profile: "unknown",
      intensity_tags: 0,
      intensity_structure: "unknown",
      intensity_dose: "unknown",
      intensity_classifier_version: 0
    }
  ], {
    startTime: "2026-01-01T00:00:00.000Z",
    endTime: "2027-01-01T00:00:00.000Z"
  }, {
    extractFeatures: async () => {
      decodeCount += 1;
      return targetFeatures;
    }
  });

  assert.equal(decodeCount, 1);
  assert.equal(result.decodedWorkoutCount, 1);
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0].id, 2);
  assert.notEqual(result.changes[0].classification.profile, "unknown");
});

test("intensity reclassification skips database updates when values remain equal", async () => {
  const historicalFeatures = featuresFromPower(repeat(250, 1200));
  const targetFeatures = featuresFromPower(repeat(175, 3600));
  const first = await classifyIntensityWindowRows([
    {
      id: 1,
      start_time: "2025-12-01T00:00:00Z",
      intensity_model_features: encodeWorkoutIntensityModelFeatures(historicalFeatures)
    },
    {
      id: 2,
      start_time: "2026-01-01T00:00:00Z",
      stream: new Uint8Array([1]),
      intensity_profile: "unknown",
      intensity_tags: 0,
      intensity_structure: "unknown",
      intensity_dose: "unknown",
      intensity_classifier_version: 0
    }
  ], {
    startTime: "2026-01-01T00:00:00.000Z",
    endTime: "2027-01-01T00:00:00.000Z"
  }, { extractFeatures: async () => targetFeatures });
  const classification = first.changes[0].classification;

  const second = await classifyIntensityWindowRows([
    {
      id: 1,
      start_time: "2025-12-01T00:00:00Z",
      intensity_model_features: encodeWorkoutIntensityModelFeatures(historicalFeatures)
    },
    {
      id: 2,
      start_time: "2026-01-01T00:00:00Z",
      stream: new Uint8Array([1]),
      intensity_profile: classification.profile,
      intensity_tags: classification.tags,
      intensity_structure: classification.structure,
      intensity_dose: classification.dose,
      intensity_classifier_version: classification.classifierVersion
    }
  ], {
    startTime: "2026-01-01T00:00:00.000Z",
    endTime: "2027-01-01T00:00:00.000Z"
  }, { extractFeatures: async () => targetFeatures });

  assert.equal(second.changes.length, 0);
});

test("intensity reclassification reuses freshly imported model features without decoding", async () => {
  const importedFeatures = featuresFromPower(repeat(250, 1200));
  let decodeCount = 0;
  const result = await classifyIntensityWindowRows([
    {
      id: 11,
      start_time: "2026-01-01T00:00:00Z",
      stream: new Uint8Array([1]),
      intensity_model_features: encodeWorkoutIntensityModelFeatures(importedFeatures),
      intensity_profile: "vo2max",
      intensity_tags: 8,
      intensity_structure: "intervals",
      intensity_dose: "high",
      intensity_classifier_version: 1
    }
  ], {
    startTime: "2026-01-01T00:00:00.000Z",
    endTime: "2027-01-01T00:00:00.000Z"
  }, {
    changedWorkoutIds: [11],
    extractFeatures: async () => {
      decodeCount += 1;
      return importedFeatures;
    }
  });

  assert.equal(decodeCount, 0);
  assert.equal(result.decodedWorkoutCount, 0);
  assert.equal(result.importedFeatureOnlyCount, 1);
  assert.equal(result.changes.length, 0);
});

test("intensity reclassification decodes only pre-existing workouts after an import", async () => {
  const importedFeatures = featuresFromPower(repeat(250, 1200));
  const existingFeatures = featuresFromPower(repeat(175, 3600));
  const decodedIds = [];
  const result = await classifyIntensityWindowRows([
    {
      id: 21,
      start_time: "2026-01-01T00:00:00Z",
      stream: new Uint8Array([1]),
      intensity_model_features: encodeWorkoutIntensityModelFeatures(importedFeatures)
    },
    {
      id: 22,
      start_time: "2026-02-01T00:00:00Z",
      stream: new Uint8Array([2]),
      intensity_profile: "unknown",
      intensity_tags: 0,
      intensity_structure: "unknown",
      intensity_dose: "unknown",
      intensity_classifier_version: 0
    }
  ], {
    startTime: "2026-01-01T00:00:00.000Z",
    endTime: "2027-01-01T00:00:00.000Z"
  }, {
    changedWorkoutIds: [21],
    extractFeatures: async (row) => {
      decodedIds.push(row.id);
      return existingFeatures;
    }
  });

  assert.deepEqual(decodedIds, [22]);
  assert.equal(result.decodedWorkoutCount, 1);
  assert.equal(result.importedFeatureOnlyCount, 1);
  assert.deepEqual(result.changes.map((entry) => entry.id), [22]);
});

test("intensity reclassification locks per user and batch-updates changed rows", async () => {
  const historicalFeatures = featuresFromPower(repeat(250, 1200));
  const targetFeatures = featuresFromPower(repeat(175, 3600));
  const statements = [];
  const client = {
    async query(sql, params = []) {
      statements.push({ sql: String(sql), params });
      if (String(sql).includes("FROM workouts") && String(sql).includes("ORDER BY start_time")) {
        return {
          rows: [
            {
              id: 1,
              start_time: "2025-12-01T00:00:00Z",
              intensity_model_features: encodeWorkoutIntensityModelFeatures(historicalFeatures)
            },
            {
              id: 2,
              start_time: "2026-01-01T00:00:00Z",
              stream: new Uint8Array([1]),
              intensity_profile: "unknown",
              intensity_tags: 0,
              intensity_structure: "unknown",
              intensity_dose: "unknown",
              intensity_classifier_version: 0
            }
          ]
        };
      }
      if (String(sql).includes("UPDATE workouts AS workout")) return { rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release() {
      statements.push({ sql: "RELEASE", params: [] });
    }
  };
  const result = await reclassifyWorkoutIntensity({
    uid: 7,
    startTimes: ["2026-01-01T00:00:00Z"],
    db: { connect: async () => client },
    extractFeatures: async () => targetFeatures
  });

  assert.equal(result.updatedWorkoutCount, 1);
  assert.ok(statements.some((statement) => statement.sql.includes("pg_advisory_xact_lock")));
  const update = statements.find((statement) => statement.sql.includes("UPDATE workouts AS workout"));
  assert.deepEqual(update.params[1], [2]);
  assert.equal(statements.at(-2).sql, "COMMIT");
  assert.equal(statements.at(-1).sql, "RELEASE");
});
