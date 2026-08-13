import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { FileDBService } from "../src/services/fileDBService.js";
import { buildManualPowerThumbnailSvg } from "../src/public/js/workout-library-view.js";
import TrainingFeedDBService from "../src/services/trainingFeedDBService.js";

const source = fs.readFileSync(
  new URL("../src/services/trainingFeedDBService.js", import.meta.url),
  "utf8"
);

test("training feed filters both branches before union and pages the combined result", () => {
  assert.match(source, /SELECT \* FROM \(.*workoutProjection\(\).*\) workout_entry \$\{feedWhere\}/su);
  assert.match(source, /SELECT \* FROM \(.*manualProjection\(\).*\) manual_entry \$\{feedWhere\}/su);
  assert.match(source, /WITH training_feed AS \(\$\{filteredWorkout\} UNION ALL \$\{filteredManual\}\)/u);
  assert.match(source, /SELECT \* FROM training_feed\s+\$\{feedOrderSQL\}/u);
  assert.match(source, /LIMIT \$\$\{sqlParams\.length \+ 1\} OFFSET \$\$\{sqlParams\.length \+ 2\}/u);
  assert.match(source, /avg_normalized_power\)\\s\+\(ASC\|DESC\).*NULLS LAST/su);
});

test("manual-only training feed keeps activity semantics and total count", async () => {
  const statements = [];
  const db = {
    async query(sql, params) {
      statements.push({ sql: String(sql), params });
      if (String(sql).includes("SELECT * FROM training_feed")) {
        return { rows: [{ entity_type: "manual_activity", id: 9, entity_id: 9, estimated_tss: 31 }] };
      }
      if (String(sql).includes("COUNT(*) AS total FROM training_feed")) return { rows: [{ total: "1" }] };
      if (String(sql).includes("manual_activity_count")) {
        return { rows: [{ workout_count: 3, manual_activity_count: 1, total_timer_time: 9000, total_distance: 42000 }] };
      }
      if (String(sql).includes("FROM workout_favorites")) return { rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };

  const result = await TrainingFeedDBService.getEntriesByUser(
    7,
    1,
    20,
    [{ field: "start_time", dir: "desc" }],
    [{ field: "activity_type", type: "=", value: "strength_training" }],
    "mine",
    false,
    db
  );

  assert.equal(result.total_records, 1);
  assert.equal(result.data[0].TSS, 31);
  assert.equal(result.own_summary.manual_activity_count, 1);
  assert.ok(statements[0].sql.indexOf("workout_entry WHERE activity_type") < statements[0].sql.indexOf("UNION ALL"));
  assert.ok(statements[0].sql.indexOf("manual_entry WHERE activity_type") < statements[0].sql.indexOf("SELECT * FROM training_feed"));
});

test("manual cycling feed rows are enriched through the FTP load path", async () => {
  const originalPostCalculations = FileDBService.post_calculations;
  FileDBService.post_calculations = async (_uid, rows) => rows.map((row) => ({ ...row, TSS: 42 }));
  const db = {
    async query(sql) {
      const statement = String(sql);
      if (statement.includes("SELECT * FROM training_feed")) {
        return { rows: [{ entity_type: "manual_activity", id: 12, activity_type: "cycling" }] };
      }
      if (statement.includes("COUNT(*) AS total FROM training_feed")) return { rows: [{ total: "1" }] };
      if (statement.includes("manual_activity_count")) {
        return { rows: [{ workout_count: 0, manual_activity_count: 1, total_timer_time: 1800, total_distance: 0 }] };
      }
      if (statement.includes("FROM workout_favorites")) return { rows: [] };
      if (statement.includes("LEFT JOIN training_activity_intervals")) {
        return {
          rows: [{
            activity_id: 12,
            duration_seconds: 1800,
            baseline_power_mode: "watts",
            baseline_power_value: 120,
            ftp_used: 250,
            sequence_no: 0,
            repetitions: 3,
            work_duration_seconds: 120,
            recovery_duration_seconds: 120,
            power_mode: "ftp_percent",
            work_power_value: 120,
            recovery_power_value: 40
          }]
        };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
  try {
    const result = await TrainingFeedDBService.getEntriesByUser(7, 1, 20, [], [], "mine", false, db);
    assert.equal(result.data[0].TSS, 42);
    assert.equal(result.data[0].power_profile.baseline_power, 120);
    assert.equal(result.data[0].power_profile.intervals[0].work_power, 300);
    assert.equal(result.data[0].power_profile.intervals[0].recovery_power, 100);
  } finally {
    FileDBService.post_calculations = originalPostCalculations;
  }
});

test("manual cycling feed does not invent a zero-watt profile from a missing baseline", async () => {
  const originalPostCalculations = FileDBService.post_calculations;
  FileDBService.post_calculations = async (_uid, rows) => rows;
  const db = {
    async query(sql) {
      const statement = String(sql);
      if (statement.includes("SELECT * FROM training_feed")) {
        return { rows: [{ entity_type: "manual_activity", id: 13, activity_type: "cycling" }] };
      }
      if (statement.includes("COUNT(*) AS total FROM training_feed")) return { rows: [{ total: "1" }] };
      if (statement.includes("LEFT JOIN training_activity_intervals")) {
        return {
          rows: [{
            activity_id: 13,
            duration_seconds: 1800,
            baseline_power_mode: null,
            baseline_power_value: null,
            ftp_used: null,
            sequence_no: null
          }]
        };
      }
      if (statement.includes("manual_activity_count")) {
        return { rows: [{ workout_count: 0, manual_activity_count: 1, total_timer_time: 1800, total_distance: 0 }] };
      }
      if (statement.includes("FROM workout_favorites")) return { rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
  try {
    const result = await TrainingFeedDBService.getEntriesByUser(7, 1, 20, [], [], "mine", false, db);
    assert.equal(result.data[0].power_profile, undefined);
  } finally {
    FileDBService.post_calculations = originalPostCalculations;
  }
});

test("CTL/ATL calculates regular workout TSS instead of treating SQL null as zero", () => {
  const result = FileDBService.computeWorkoutMetrics(
    {
      entity_type: "workout",
      start_time: "2026-08-01T08:00:00.000Z",
      total_timer_time: 3600,
      avg_normalized_power: 200,
      workout_type: "road",
      estimated_tss: null,
      tss_source: null
    },
    [{ period: 2026, ftp: 250 }],
    "year"
  );

  assert.equal(result.tss, 64);
});

test("CTL/ATL uses an explicitly entered TSS for manual activities", () => {
  const result = FileDBService.computeWorkoutMetrics(
    {
      entity_type: "manual_activity",
      start_time: "2026-08-01T08:00:00.000Z",
      total_timer_time: 1800,
      avg_normalized_power: null,
      workout_type: "indoor",
      estimated_tss: 42,
      tss_source: "manual"
    },
    [{ period: 2026, ftp: 250 }],
    "year"
  );

  assert.equal(result.tss, 42);
});

test("CTL/ATL day filling retains the final workout across daylight-saving time", () => {
  const result = FileDBService.fillMissingDays([
    { day: "2026-01-01", tss: 10 },
    { day: "2026-08-12", tss: 91 }
  ]);

  assert.deepEqual(result.at(-1), { day: "2026-08-12", tss: 91 });
  assert.equal(result.length, 224);
});

test("manual cycling cards render a compact interval power profile", () => {
  const svg = buildManualPowerThumbnailSvg({
    total_timer_time: 1800,
    power_profile: {
      duration_seconds: 1800,
      baseline_power: 120,
      intervals: [{
        sequence_no: 0,
        repetitions: 3,
        work_duration_seconds: 120,
        recovery_duration_seconds: 120,
        work_power: 300,
        recovery_power: 100
      }]
    }
  });

  assert.match(svg, /manual-power-thumbnail/u);
  assert.match(svg, /fill="#dcfce7"/u);
  assert.match(svg, /stroke="#2563eb"/u);
  assert.doesNotMatch(svg, /NaN|Infinity/u);
});

test("manual cycling cards render a flat profile without intervals", () => {
  const svg = buildManualPowerThumbnailSvg({
    total_timer_time: 1800,
    power_profile: {
      duration_seconds: 1800,
      baseline_power: 150,
      intervals: []
    }
  });

  assert.match(svg, /M 18 28\.89 L 238\.00 28\.89/u);
  assert.doesNotMatch(svg, /NaN|Infinity/u);
});
