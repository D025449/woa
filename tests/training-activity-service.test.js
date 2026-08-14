import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import TrainingActivityDBService, {
  calculateManualCyclingMetrics,
  normalizeTrainingActivityCopyTargets,
  normalizeTrainingActivityPayload
} from "../src/services/trainingActivityDBService.js";

test("normalizes a manual indoor cycling activity", () => {
  const activity = normalizeTrainingActivityPayload({
    startTime: "2026-08-13T08:15:00.000Z",
    durationSeconds: 1800,
    activityType: "cycling",
    workoutType: "indoor",
    perceivedExertion: "7",
    baselinePowerMode: "watts",
    baselinePowerValue: "185",
    estimatedTss: "31.5",
    title: " Gym bike "
  });

  assert.deepEqual(activity, {
    startTime: "2026-08-13T08:15:00.000Z",
    durationSeconds: 1800,
    activityType: "cycling",
    workoutType: "indoor",
    title: "Gym bike",
    notes: null,
    perceivedExertion: 7,
    baselinePowerMode: "watts",
    baselinePowerValue: 185,
    intervals: [],
    manualTss: 31.5,
    strengthFocus: null
  });
});

test("calculates normalized power and TSS from manual cycling intervals", () => {
  const activity = normalizeTrainingActivityPayload({
    startTime: "2026-08-13T08:15:00.000Z",
    durationSeconds: 1800,
    activityType: "cycling",
    workoutType: "indoor",
    baselinePowerMode: "watts",
    baselinePowerValue: 120,
    intervals: [{
      repetitions: 3,
      workDurationSeconds: 120,
      recoveryDurationSeconds: 120,
      powerMode: "watts",
      workPowerValue: 280,
      recoveryPowerValue: 100
    }]
  });
  const metrics = calculateManualCyclingMetrics(activity, 250);
  assert.equal(metrics.averagePower, 149);
  assert.ok(metrics.normalizedPower > metrics.averagePower);
  assert.equal(metrics.tssSource, "power_model");
  assert.equal(metrics.ftpUsed, 250);
  assert.ok(metrics.estimatedTss > 0);
});

test("supports FTP-relative interval power and rejects blocks longer than the activity", () => {
  const activity = normalizeTrainingActivityPayload({
    startTime: "2026-08-13T08:15:00.000Z",
    durationSeconds: 1800,
    activityType: "cycling",
    workoutType: "indoor",
    baselinePowerMode: "ftp_percent",
    baselinePowerValue: 50,
    intervals: [{
      repetitions: 3,
      workDurationSeconds: 120,
      recoveryDurationSeconds: 120,
      powerMode: "ftp_percent",
      workPowerValue: 120,
      recoveryPowerValue: 45
    }]
  });
  const metrics = calculateManualCyclingMetrics(activity, 250);
  assert.equal(metrics.ftpUsed, 250);
  assert.throws(() => normalizeTrainingActivityPayload({
    startTime: "2026-08-13T08:15:00.000Z",
    durationSeconds: 300,
    activityType: "cycling",
    workoutType: "indoor",
    baselinePowerMode: "watts",
    baselinePowerValue: 100,
    intervals: [{
      repetitions: 3,
      workDurationSeconds: 120,
      recoveryDurationSeconds: 60,
      powerMode: "watts",
      workPowerValue: 250
    }]
  }), /exceed activity duration/u);
});

test("keeps strength focus only for strength training", () => {
  const strength = normalizeTrainingActivityPayload({
    startTime: "2026-08-13T08:15:00.000Z",
    durationSeconds: 2700,
    activityType: "strength_training",
    strengthFocus: "lower_body"
  });
  assert.equal(strength.workoutType, null);
  assert.equal(strength.strengthFocus, "lower_body");

  const mobility = normalizeTrainingActivityPayload({
    startTime: "2026-08-13T08:15:00.000Z",
    durationSeconds: 900,
    activityType: "mobility",
    workoutType: "indoor",
    strengthFocus: "lower_body"
  });
  assert.equal(mobility.workoutType, null);
  assert.equal(mobility.strengthFocus, null);
});

test("rejects invalid activity values before database access", () => {
  assert.throws(() => normalizeTrainingActivityPayload({
    startTime: "invalid",
    durationSeconds: 30,
    activityType: "running"
  }), /Invalid activity type/);
  assert.throws(() => normalizeTrainingActivityPayload({
    startTime: "2026-08-13T08:15:00.000Z",
    durationSeconds: 1800,
    activityType: "cycling"
  }), /valid workout type/);
});

test("create and delete are scoped to the authenticated user", async () => {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      if (String(sql).includes("get_ftp_by_period2")) return { rows: [{ period: 2026, ftp: 250 }] };
      return { rows: [{ id: 17 }] };
    }
  };
  await TrainingActivityDBService.create(5, {
    startTime: "2026-08-13T08:15:00.000Z",
    durationSeconds: 1800,
    activityType: "cycling",
    workoutType: "indoor",
    baselinePowerMode: "watts",
    baselinePowerValue: 150
  }, db);
  await TrainingActivityDBService.delete(5, 17, db);

  assert.equal(calls[0].params[0], 5);
  const deleteCall = calls.find((call) => /DELETE FROM training_activities WHERE/u.test(call.sql));
  assert.match(deleteCall.sql, /WHERE id = \$1 AND uid = \$2/u);
  assert.deepEqual(deleteCall.params, [17, 5]);
});

test("normalizes unique activity copy targets and enforces the batch limit", () => {
  assert.deepEqual(normalizeTrainingActivityCopyTargets([
    "2026-08-15T08:15:00.000Z",
    "2026-08-14T08:15:00.000Z",
    "2026-08-15T08:15:00.000Z"
  ]), [
    "2026-08-14T08:15:00.000Z",
    "2026-08-15T08:15:00.000Z"
  ]);
  assert.throws(() => normalizeTrainingActivityCopyTargets([]), /copy targets/u);
  assert.throws(
    () => normalizeTrainingActivityCopyTargets(Array.from({ length: 51 }, (_, index) => (
      new Date(Date.UTC(2026, 0, index + 1)).toISOString()
    ))),
    /copy targets/u
  );
});

test("copies a manual activity with intervals and skips an occupied start time", async () => {
  const insertedActivities = [];
  const insertedIntervals = [];
  let ftpQueryCount = 0;
  const source = {
    id: 17,
    uid: 5,
    start_time: "2026-08-13T08:15:00.000Z",
    duration_seconds: 1800,
    activity_type: "cycling",
    workout_type: "indoor",
    title: "3 x 2",
    notes: "Gym",
    perceived_exertion: 8,
    baseline_power_mode: "watts",
    baseline_power_value: 120,
    estimated_tss: 44,
    tss_source: "power_model",
    strength_focus: null
  };
  const db = {
    async query(sql, params) {
      const statement = String(sql);
      if (/SELECT \* FROM training_activities/u.test(statement)) return { rows: [source] };
      if (/FROM training_activity_intervals/u.test(statement)) {
        return { rows: [{
          sequence_no: 0,
          repetitions: 3,
          work_duration_seconds: 120,
          recovery_duration_seconds: 120,
          power_mode: "watts",
          work_power_value: 280,
          recovery_power_value: 100
        }] };
      }
      if (/start_time = ANY/u.test(statement)) {
        return { rows: [{ start_time: "2026-08-14T08:15:00.000Z" }] };
      }
      if (/get_ftp_by_period2/u.test(statement)) {
        ftpQueryCount += 1;
        return { rows: [{ period: 2026, ftp: 250 }] };
      }
      if (/INSERT INTO training_activities \(/u.test(statement)) {
        insertedActivities.push(params);
        return { rows: [{ id: 18, start_time: params[1] }] };
      }
      if (/INSERT INTO training_activity_intervals/u.test(statement)) {
        insertedIntervals.push(params);
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL: ${statement}`);
    }
  };

  const result = await TrainingActivityDBService.copyToStartTimes(5, 17, [
    "2026-08-14T08:15:00.000Z",
    "2026-08-15T08:15:00.000Z"
  ], db);

  assert.equal(result.created.length, 1);
  assert.deepEqual(result.skippedStartTimes, ["2026-08-14T08:15:00.000Z"]);
  assert.equal(insertedActivities[0][0], 5);
  assert.equal(insertedActivities[0][1], "2026-08-15T08:15:00.000Z");
  assert.equal(insertedActivities[0][11], "power_model");
  assert.equal(insertedActivities[0][12], 250);
  assert.deepEqual(insertedIntervals[0].slice(0, 4), [18, 0, 3, 120]);
  assert.equal(ftpQueryCount, 1);
});

test("preserves a manual TSS override when copying an activity", async () => {
  let insertedActivity = null;
  const db = {
    async query(sql, params) {
      const statement = String(sql);
      if (/SELECT \* FROM training_activities/u.test(statement)) {
        return { rows: [{
          id: 20,
          uid: 5,
          duration_seconds: 1800,
          activity_type: "cycling",
          workout_type: "indoor",
          baseline_power_mode: "watts",
          baseline_power_value: 140,
          estimated_tss: 33.5,
          tss_source: "manual"
        }] };
      }
      if (/FROM training_activity_intervals/u.test(statement)) return { rows: [] };
      if (/start_time = ANY/u.test(statement)) return { rows: [] };
      if (/get_ftp_by_period2/u.test(statement)) return { rows: [{ period: 2026, ftp: 250 }] };
      if (/INSERT INTO training_activities \(/u.test(statement)) {
        insertedActivity = params;
        return { rows: [{ id: 21 }] };
      }
      throw new Error(`Unexpected SQL: ${statement}`);
    }
  };

  await TrainingActivityDBService.copyToStartTimes(
    5,
    20,
    ["2026-08-20T08:15:00.000Z"],
    db
  );

  assert.equal(insertedActivity[10], 33.5);
  assert.equal(insertedActivity[11], "manual");
});

test("manual activity import preview distinguishes duplicates and conflicts", async () => {
  const existing = {
    id: 20,
    uid: 5,
    start_time: "2026-08-20T08:15:00.000Z",
    duration_seconds: 1800,
    activity_type: "cycling",
    workout_type: "indoor",
    title: "Existing",
    notes: null,
    perceived_exertion: 7,
    baseline_power_mode: "watts",
    baseline_power_value: 140,
    estimated_tss: 33.5,
    tss_source: "manual",
    strength_focus: null
  };
  const db = {
    async query(sql) {
      const statement = String(sql);
      if (/FROM training_activities/u.test(statement)) return { rows: [existing] };
      if (/FROM training_activity_intervals/u.test(statement)) return { rows: [] };
      throw new Error(`Unexpected SQL: ${statement}`);
    }
  };
  const duplicate = {
    startTime: existing.start_time,
    durationSeconds: 1800,
    activityType: "cycling",
    workoutType: "indoor",
    title: "Existing",
    perceivedExertion: 7,
    baselinePowerMode: "watts",
    baselinePowerValue: 140,
    estimatedTss: 33.5,
    intervals: []
  };
  assert.deepEqual(await TrainingActivityDBService.previewImport(5, [duplicate], db), {
    totalCount: 1,
    newCount: 0,
    duplicateCount: 1,
    conflictCount: 0
  });
  assert.deepEqual(await TrainingActivityDBService.previewImport(5, [{
    ...duplicate,
    baselinePowerValue: 160
  }], db), {
    totalCount: 1,
    newCount: 0,
    duplicateCount: 0,
    conflictCount: 1
  });
});

test("manual activity batch import creates source data and recalculates metrics", async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      const statement = String(sql);
      calls.push({ statement, params });
      if (/^BEGIN|^COMMIT|^ROLLBACK/u.test(statement)) return { rows: [] };
      if (/FROM training_activities/u.test(statement)) return { rows: [] };
      if (/get_ftp_by_period2/u.test(statement)) return { rows: [{ period: 2026, ftp: 250 }] };
      if (/INSERT INTO training_activities/u.test(statement)) return { rows: [{ id: 72 }] };
      if (/INSERT INTO training_activity_intervals/u.test(statement)) return { rows: [] };
      throw new Error(`Unexpected SQL: ${statement}`);
    },
    release() {}
  };
  const db = { async connect() { return client; } };
  const result = await TrainingActivityDBService.importMany(5, [{
    startTime: "2026-08-21T08:15:00.000Z",
    durationSeconds: 1800,
    activityType: "cycling",
    workoutType: "indoor",
    baselinePowerMode: "watts",
    baselinePowerValue: 140,
    intervals: [{
      repetitions: 3,
      workDurationSeconds: 120,
      recoveryDurationSeconds: 120,
      powerMode: "watts",
      workPowerValue: 300,
      recoveryPowerValue: 120
    }]
  }], false, db);

  assert.equal(result.createdCount, 1);
  assert.equal(result.updatedCount, 0);
  assert.ok(calls.some(({ statement }) => /INSERT INTO training_activity_intervals/u.test(statement)));
  assert.equal(calls.at(-1).statement, "COMMIT");
});

test("workout hero exposes manual activity import and export", () => {
  const view = fs.readFileSync(new URL("../src/views/dashboard-new.ejs", import.meta.url), "utf8");
  const controller = fs.readFileSync(
    new URL("../src/public/js/dashboard-new-controller.js", import.meta.url),
    "utf8"
  );
  assert.match(view, /id="dashboard-add-training"/u);
  assert.match(view, /href="\/files\/uploadUI"/u);
  assert.match(view, /id="dashboard-manual-training-form"/u);
  assert.match(view, /id="dashboard-import-manual-training"/u);
  assert.match(view, /id="dashboard-manual-import-file"/u);
  assert.match(view, /id="dashboard-export-all-manual"/u);
  assert.match(controller, /\? "\/files\/training-activities"/u);
  assert.match(controller, /method: activityId === null \? "POST" : "PUT"/u);
  assert.match(controller, /method: "DELETE"/u);
  assert.match(controller, /targetStartTimes/u);
  assert.match(controller, /await this\.libraryView\.reload\(\)/u);
  assert.match(controller, /getNavigableWorkouts\(\)/u);
  const library = fs.readFileSync(
    new URL("../src/public/js/workout-library-view.js", import.meta.url),
    "utf8"
  );
  assert.match(library, /data-manual-activity-edit/u);
  assert.match(library, /data-manual-activity-delete/u);
  assert.match(library, /data-manual-activity-copy/u);
  assert.match(library, /data-manual-activity-export/u);
});

test("every locale contains the manual activity copy dialog", () => {
  for (const locale of ["de", "en", "es", "fr", "it", "pt"]) {
    const messages = JSON.parse(fs.readFileSync(
      new URL(`../src/public/i18n/${locale}.json`, import.meta.url),
      "utf8"
    ));
    const page = messages.dashboardNewPage;
    for (const key of [
      "manualTrainingCopyAction",
      "manualTrainingCopyTitle",
      "manualTrainingCopySource",
      "manualTrainingCopySubmit",
      "manualTrainingCopyComplete",
      "manualTrainingCopyFailed"
    ]) {
      assert.equal(typeof page[key], "string", `${locale}.${key}`);
      assert.ok(page[key].length > 0, `${locale}.${key}`);
    }
  }
});

test("every locale contains the manual activity exchange copy", () => {
  for (const locale of ["de", "en", "es", "fr", "it", "pt"]) {
    const messages = JSON.parse(fs.readFileSync(
      new URL(`../src/public/i18n/${locale}.json`, import.meta.url),
      "utf8"
    ));
    for (const key of [
      "exportMenu",
      "exportAllManual",
      "manualTrainingExportAction",
      "manualActivityImportOptionTitle",
      "manualActivityImportTitle",
      "manualActivityImportPreview",
      "manualActivityImportComplete"
    ]) {
      assert.equal(typeof messages.dashboardNewPage[key], "string", `${locale}.${key}`);
      assert.ok(messages.dashboardNewPage[key].length > 0, `${locale}.${key}`);
    }
  }
});
