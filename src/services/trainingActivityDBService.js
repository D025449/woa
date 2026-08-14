import pool from "./database.js";
import { calculateNormalizedPowerFromSamples } from "../shared/WorkoutEnergy.js";
import { manualActivityPayloadFromStored } from "../shared/ManualActivityExchange.js";

const ACTIVITY_TYPES = new Set(["cycling", "strength_training", "mobility", "other"]);
const WORKOUT_TYPES = new Set(["indoor", "road", "mountain", "unknown"]);
const STRENGTH_FOCUS_VALUES = new Set(["upper_body", "lower_body", "full_body"]);
const POWER_MODES = new Set(["watts", "ftp_percent"]);
const MAX_INTERVAL_BLOCKS = 20;
const MAX_COPY_TARGETS = 50;
const MAX_IMPORT_ACTIVITIES = 5000;

function validationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function optionalNumber(value, { min = 0, max = Number.POSITIVE_INFINITY, integer = false } = {}) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max || (integer && !Number.isInteger(parsed))) {
    throw validationError("Invalid numeric activity value");
  }
  return parsed;
}

function normalizePowerMode(value, fallback = "watts") {
  const mode = String(value || fallback).trim().toLowerCase();
  if (!POWER_MODES.has(mode)) throw validationError("Invalid power mode");
  return mode;
}

function normalizeIntervals(value, durationSeconds) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_INTERVAL_BLOCKS) {
    throw validationError("Invalid interval blocks");
  }

  const intervals = value.map((entry, sequenceNo) => {
    const repetitions = optionalNumber(entry?.repetitions, { min: 1, max: 100, integer: true });
    const workDurationSeconds = optionalNumber(entry?.workDurationSeconds, {
      min: 1,
      max: 3600,
      integer: true
    });
    const recoveryDurationSeconds = optionalNumber(entry?.recoveryDurationSeconds, {
      min: 0,
      max: 3600,
      integer: true
    }) ?? 0;
    const powerMode = normalizePowerMode(entry?.powerMode);
    const powerMax = powerMode === "watts" ? 3000 : 300;
    const workPowerValue = optionalNumber(entry?.workPowerValue, { min: 1, max: powerMax });
    const recoveryPowerValue = optionalNumber(entry?.recoveryPowerValue, { min: 0, max: powerMax });
    if (repetitions === null || workDurationSeconds === null || workPowerValue === null) {
      throw validationError("Incomplete interval block");
    }
    return {
      sequenceNo,
      repetitions,
      workDurationSeconds,
      recoveryDurationSeconds,
      powerMode,
      workPowerValue,
      recoveryPowerValue
    };
  });

  const occupiedSeconds = intervals.reduce((sum, interval) => (
    sum
      + interval.repetitions * interval.workDurationSeconds
      + Math.max(0, interval.repetitions - 1) * interval.recoveryDurationSeconds
  ), 0);
  if (occupiedSeconds > durationSeconds) {
    throw validationError("Interval blocks exceed activity duration");
  }
  return intervals;
}

export function normalizeTrainingActivityPayload(payload = {}) {
  const activityType = String(payload.activityType || "").trim().toLowerCase();
  if (!ACTIVITY_TYPES.has(activityType)) throw validationError("Invalid activity type");

  const startTime = new Date(payload.startTime);
  if (!Number.isFinite(startTime.getTime())) throw validationError("Invalid activity start time");

  const durationSeconds = optionalNumber(payload.durationSeconds, { min: 60, max: 7 * 24 * 3600 });
  if (durationSeconds === null) throw validationError("Activity duration is required");
  const roundedDurationSeconds = Math.round(durationSeconds);

  const suppliedWorkoutType = String(payload.workoutType || "").trim().toLowerCase();
  const workoutType = activityType === "cycling" ? suppliedWorkoutType : null;
  if (activityType === "cycling" && !WORKOUT_TYPES.has(workoutType)) {
    throw validationError("Cycling activities require a valid workout type");
  }

  const suppliedStrengthFocus = String(payload.strengthFocus || "").trim().toLowerCase();
  const strengthFocus = activityType === "strength_training" && suppliedStrengthFocus
    ? suppliedStrengthFocus
    : null;
  if (strengthFocus && !STRENGTH_FOCUS_VALUES.has(strengthFocus)) {
    throw validationError("Invalid strength focus");
  }

  let baselinePowerMode = null;
  let baselinePowerValue = null;
  let intervals = [];
  let manualTss = null;
  if (activityType === "cycling") {
    baselinePowerMode = normalizePowerMode(payload.baselinePowerMode);
    const baselineMax = baselinePowerMode === "watts" ? 3000 : 300;
    baselinePowerValue = optionalNumber(payload.baselinePowerValue, { min: 1, max: baselineMax });
    if (baselinePowerValue === null) throw validationError("Cycling activities require a baseline power");
    intervals = normalizeIntervals(payload.intervals, roundedDurationSeconds);
    manualTss = optionalNumber(payload.estimatedTss, { min: 0, max: 2000 });
  }

  return {
    startTime: startTime.toISOString(),
    durationSeconds: roundedDurationSeconds,
    activityType,
    workoutType,
    title: String(payload.title || "").trim().slice(0, 160) || null,
    notes: String(payload.notes || "").trim().slice(0, 5000) || null,
    perceivedExertion: optionalNumber(payload.perceivedExertion, { min: 1, max: 10, integer: true }),
    baselinePowerMode,
    baselinePowerValue,
    intervals,
    manualTss,
    strengthFocus
  };
}

function resolvePowerWatts(mode, value, ftp) {
  if (mode === "watts") return Number(value);
  if (!Number.isFinite(ftp) || ftp <= 0) {
    throw validationError("FTP is required for percentage-based power values");
  }
  return ftp * Number(value) / 100;
}

export function calculateManualCyclingMetrics(activity, ftp = null) {
  if (activity.activityType !== "cycling") {
    return {
      averagePower: null,
      normalizedPower: null,
      estimatedTss: null,
      tssSource: null,
      ftpUsed: null
    };
  }

  const baselinePower = resolvePowerWatts(
    activity.baselinePowerMode,
    activity.baselinePowerValue,
    ftp
  );
  const occupiedSeconds = activity.intervals.reduce((sum, interval) => (
    sum
      + interval.repetitions * interval.workDurationSeconds
      + Math.max(0, interval.repetitions - 1) * interval.recoveryDurationSeconds
  ), 0);
  const leadingBaselineSeconds = Math.floor((activity.durationSeconds - occupiedSeconds) / 2);
  const power = new Uint16Array(activity.durationSeconds);
  power.fill(Math.round(baselinePower));
  let offset = leadingBaselineSeconds;

  activity.intervals.forEach((interval) => {
    const workPower = Math.round(resolvePowerWatts(interval.powerMode, interval.workPowerValue, ftp));
    const recoveryPower = interval.recoveryPowerValue === null
      ? Math.round(baselinePower)
      : Math.round(resolvePowerWatts(interval.powerMode, interval.recoveryPowerValue, ftp));
    for (let repetition = 0; repetition < interval.repetitions; repetition += 1) {
      power.fill(workPower, offset, offset + interval.workDurationSeconds);
      offset += interval.workDurationSeconds;
      if (repetition < interval.repetitions - 1) {
        power.fill(recoveryPower, offset, offset + interval.recoveryDurationSeconds);
        offset += interval.recoveryDurationSeconds;
      }
    }
  });

  const averagePower = Math.round(power.reduce((sum, value) => sum + value, 0) / power.length);
  const normalizedPower = calculateNormalizedPowerFromSamples(power);
  const calculatedTss = Number.isFinite(ftp) && ftp > 0
    ? Math.round((activity.durationSeconds / 3600) * (normalizedPower / ftp) ** 2 * 1000) / 10
    : null;
  const usesFtpPercent = activity.baselinePowerMode === "ftp_percent"
    || activity.intervals.some((interval) => interval.powerMode === "ftp_percent");

  return {
    averagePower,
    normalizedPower,
    estimatedTss: activity.manualTss ?? calculatedTss,
    tssSource: activity.manualTss !== null
      ? "manual"
      : calculatedTss !== null
        ? "power_model"
        : null,
    ftpUsed: Number.isFinite(ftp) && (usesFtpPercent || calculatedTss !== null) ? ftp : null
  };
}

async function loadHistoricalFtpCandidates(uid, db) {
  const result = await db.query("SELECT * FROM get_ftp_by_period2($1, 'year')", [uid]);
  return (result.rows || [])
    .map((row) => ({ period: Number(row.period), ftp: Number(row.ftp) }))
    .filter((row) => Number.isFinite(row.period) && Number.isFinite(row.ftp) && row.ftp > 0)
    .sort((left, right) => left.period - right.period);
}

function resolveHistoricalFtpFromCandidates(candidates, startTime) {
  const targetYear = new Date(startTime).getUTCFullYear();
  return candidates.filter((row) => row.period <= targetYear).at(-1)?.ftp ?? null;
}

async function resolveHistoricalFtp(uid, startTime, db) {
  return resolveHistoricalFtpFromCandidates(
    await loadHistoricalFtpCandidates(uid, db),
    startTime
  );
}

export function normalizeTrainingActivityCopyTargets(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_COPY_TARGETS) {
    throw validationError("Invalid activity copy targets");
  }
  const targets = [...new Set(value.map((entry) => {
    const timestamp = new Date(entry);
    if (!Number.isFinite(timestamp.getTime())) {
      throw validationError("Invalid activity copy target");
    }
    return timestamp.toISOString();
  }))].sort();
  if (targets.length === 0 || targets.length > MAX_COPY_TARGETS) {
    throw validationError("Invalid activity copy targets");
  }
  return targets;
}

function copyPayloadFromStoredActivity(source, startTime) {
  return {
    startTime,
    durationSeconds: source.duration_seconds,
    activityType: source.activity_type,
    workoutType: source.workout_type,
    title: source.title,
    notes: source.notes,
    perceivedExertion: source.perceived_exertion,
    baselinePowerMode: source.baseline_power_mode,
    baselinePowerValue: source.baseline_power_value,
    estimatedTss: source.tss_source === "manual" ? source.estimated_tss : null,
    strengthFocus: source.strength_focus,
    intervals: (source.intervals || []).map((interval) => ({
      repetitions: interval.repetitions,
      workDurationSeconds: interval.work_duration_seconds,
      recoveryDurationSeconds: interval.recovery_duration_seconds,
      powerMode: interval.power_mode,
      workPowerValue: interval.work_power_value,
      recoveryPowerValue: interval.recovery_power_value
    }))
  };
}

async function withTransaction(db, callback) {
  if (typeof db.connect !== "function") return callback(db);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function insertIntervals(activityId, intervals, db) {
  for (const interval of intervals) {
    await db.query(`
      INSERT INTO training_activity_intervals (
        training_activity_id, sequence_no, repetitions, work_duration_seconds,
        recovery_duration_seconds, power_mode, work_power_value, recovery_power_value
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [
      activityId,
      interval.sequenceNo,
      interval.repetitions,
      interval.workDurationSeconds,
      interval.recoveryDurationSeconds,
      interval.powerMode,
      interval.workPowerValue,
      interval.recoveryPowerValue
    ]);
  }
}

function canonicalActivity(activity) {
  return JSON.stringify({
    ...activity,
    intervals: activity.intervals.map((interval) => ({
      repetitions: interval.repetitions,
      workDurationSeconds: interval.workDurationSeconds,
      recoveryDurationSeconds: interval.recoveryDurationSeconds,
      powerMode: interval.powerMode,
      workPowerValue: interval.workPowerValue,
      recoveryPowerValue: interval.recoveryPowerValue
    }))
  });
}

function normalizeImportActivities(payloads) {
  if (!Array.isArray(payloads) || payloads.length === 0 || payloads.length > MAX_IMPORT_ACTIVITIES) {
    throw validationError("Invalid manual activity import");
  }
  const activities = payloads.map((payload) => normalizeTrainingActivityPayload(payload));
  const startTimes = new Set();
  for (const activity of activities) {
    if (startTimes.has(activity.startTime)) {
      throw validationError("Manual activity import contains duplicate start times");
    }
    startTimes.add(activity.startTime);
  }
  return activities;
}

async function loadActivitiesAtStartTimes(uid, startTimes, db, lock = false) {
  const result = await db.query(`
    SELECT *
    FROM training_activities
    WHERE uid = $1
      AND start_time = ANY($2::timestamptz[])
    ORDER BY start_time, id
    ${lock ? "FOR UPDATE" : ""}
  `, [uid, startTimes]);
  const rows = result.rows || [];
  if (rows.length === 0) return [];

  const intervalResult = await db.query(`
    SELECT training_activity_id, sequence_no, repetitions, work_duration_seconds,
           recovery_duration_seconds, power_mode, work_power_value, recovery_power_value
    FROM training_activity_intervals
    WHERE training_activity_id = ANY($1::bigint[])
    ORDER BY training_activity_id, sequence_no
  `, [rows.map((row) => row.id)]);
  const intervalsByActivity = new Map();
  for (const interval of intervalResult.rows || []) {
    const key = String(interval.training_activity_id);
    if (!intervalsByActivity.has(key)) intervalsByActivity.set(key, []);
    intervalsByActivity.get(key).push(interval);
  }
  return rows.map((row) => ({
    ...row,
    intervals: intervalsByActivity.get(String(row.id)) || []
  }));
}

function buildImportPlan(activities, existingActivities) {
  const existingByStartTime = new Map();
  for (const activity of existingActivities) {
    const startTime = new Date(activity.start_time).toISOString();
    if (existingByStartTime.has(startTime)) {
      throw validationError("Multiple existing manual activities share an import start time");
    }
    existingByStartTime.set(startTime, activity);
  }
  const entries = activities.map((activity) => {
    const existing = existingByStartTime.get(activity.startTime) || null;
    if (!existing) return { status: "new", activity, existing: null };
    const existingPayload = normalizeTrainingActivityPayload(
      manualActivityPayloadFromStored(existing)
    );
    return {
      status: canonicalActivity(existingPayload) === canonicalActivity(activity)
        ? "duplicate"
        : "conflict",
      activity,
      existing
    };
  });
  const count = (status) => entries.filter((entry) => entry.status === status).length;
  return {
    entries,
    totalCount: entries.length,
    newCount: count("new"),
    duplicateCount: count("duplicate"),
    conflictCount: count("conflict")
  };
}

async function prepareActivity(uid, payload, db) {
  const activity = normalizeTrainingActivityPayload(payload);
  const ftp = activity.activityType === "cycling"
    ? await resolveHistoricalFtp(uid, activity.startTime, db)
    : null;
  return {
    activity,
    metrics: calculateManualCyclingMetrics(activity, ftp)
  };
}

export default class TrainingActivityDBService {
  static async getById(uid, activityId, db = pool) {
    const activityResult = await db.query(
      "SELECT * FROM training_activities WHERE id = $1 AND uid = $2",
      [activityId, uid]
    );
    const activity = activityResult.rows[0] || null;
    if (!activity) return null;
    const intervalResult = await db.query(`
      SELECT sequence_no, repetitions, work_duration_seconds, recovery_duration_seconds,
             power_mode, work_power_value, recovery_power_value
      FROM training_activity_intervals
      WHERE training_activity_id = $1
      ORDER BY sequence_no
    `, [activityId]);
    return { ...activity, intervals: intervalResult.rows };
  }

  static async getAll(uid, db = pool) {
    const result = await db.query(`
      SELECT *
      FROM training_activities
      WHERE uid = $1
      ORDER BY start_time, id
    `, [uid]);
    const rows = result.rows || [];
    if (rows.length === 0) return [];
    const intervalResult = await db.query(`
      SELECT training_activity_id, sequence_no, repetitions, work_duration_seconds,
             recovery_duration_seconds, power_mode, work_power_value, recovery_power_value
      FROM training_activity_intervals
      WHERE training_activity_id = ANY($1::bigint[])
      ORDER BY training_activity_id, sequence_no
    `, [rows.map((row) => row.id)]);
    const intervalsByActivity = new Map();
    for (const interval of intervalResult.rows || []) {
      const key = String(interval.training_activity_id);
      if (!intervalsByActivity.has(key)) intervalsByActivity.set(key, []);
      intervalsByActivity.get(key).push(interval);
    }
    return rows.map((row) => ({
      ...row,
      intervals: intervalsByActivity.get(String(row.id)) || []
    }));
  }

  static async previewImport(uid, payloads, db = pool) {
    const activities = normalizeImportActivities(payloads);
    const existing = await loadActivitiesAtStartTimes(
      uid,
      activities.map((activity) => activity.startTime),
      db
    );
    const plan = buildImportPlan(activities, existing);
    return {
      totalCount: plan.totalCount,
      newCount: plan.newCount,
      duplicateCount: plan.duplicateCount,
      conflictCount: plan.conflictCount
    };
  }

  static async importMany(uid, payloads, overwriteExisting = false, db = pool) {
    const activities = normalizeImportActivities(payloads);
    return withTransaction(db, async (client) => {
      const existing = await loadActivitiesAtStartTimes(
        uid,
        activities.map((activity) => activity.startTime),
        client,
        true
      );
      const plan = buildImportPlan(activities, existing);
      const ftpCandidates = activities.some((activity) => activity.activityType === "cycling")
        ? await loadHistoricalFtpCandidates(uid, client)
        : [];
      let createdCount = 0;
      let updatedCount = 0;

      for (const entry of plan.entries) {
        if (entry.status === "duplicate" || (entry.status === "conflict" && !overwriteExisting)) {
          continue;
        }
        const activity = entry.activity;
        const ftp = activity.activityType === "cycling"
          ? resolveHistoricalFtpFromCandidates(ftpCandidates, activity.startTime)
          : null;
        const metrics = calculateManualCyclingMetrics(activity, ftp);
        if (entry.status === "new") {
          const result = await client.query(`
            INSERT INTO training_activities (
              uid, start_time, duration_seconds, activity_type, workout_type,
              title, notes, perceived_exertion, average_power, avg_normalized_power,
              estimated_tss, tss_source, ftp_used, baseline_power_mode,
              baseline_power_value, strength_focus
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
            RETURNING id
          `, [
            uid, activity.startTime, activity.durationSeconds, activity.activityType,
            activity.workoutType, activity.title, activity.notes, activity.perceivedExertion,
            metrics.averagePower, metrics.normalizedPower, metrics.estimatedTss, metrics.tssSource,
            metrics.ftpUsed, activity.baselinePowerMode, activity.baselinePowerValue,
            activity.strengthFocus
          ]);
          await insertIntervals(result.rows[0].id, activity.intervals, client);
          createdCount += 1;
          continue;
        }

        await client.query(`
          UPDATE training_activities
          SET duration_seconds = $3, activity_type = $4, workout_type = $5,
              title = $6, notes = $7, perceived_exertion = $8, average_power = $9,
              avg_normalized_power = $10, estimated_tss = $11, tss_source = $12,
              ftp_used = $13, baseline_power_mode = $14, baseline_power_value = $15,
              strength_focus = $16
          WHERE id = $1 AND uid = $2
        `, [
          entry.existing.id, uid, activity.durationSeconds, activity.activityType,
          activity.workoutType, activity.title, activity.notes, activity.perceivedExertion,
          metrics.averagePower, metrics.normalizedPower, metrics.estimatedTss, metrics.tssSource,
          metrics.ftpUsed, activity.baselinePowerMode, activity.baselinePowerValue,
          activity.strengthFocus
        ]);
        await client.query(
          "DELETE FROM training_activity_intervals WHERE training_activity_id = $1",
          [entry.existing.id]
        );
        await insertIntervals(entry.existing.id, activity.intervals, client);
        updatedCount += 1;
      }

      return {
        totalCount: plan.totalCount,
        createdCount,
        updatedCount,
        duplicateCount: plan.duplicateCount,
        conflictCount: overwriteExisting ? 0 : plan.conflictCount,
        skippedCount: plan.duplicateCount + (overwriteExisting ? 0 : plan.conflictCount)
      };
    });
  }

  static async create(uid, payload, db = pool) {
    return withTransaction(db, async (client) => {
      const { activity, metrics } = await prepareActivity(uid, payload, client);
      const result = await client.query(`
        INSERT INTO training_activities (
          uid, start_time, duration_seconds, activity_type, workout_type,
          title, notes, perceived_exertion, average_power, avg_normalized_power,
          estimated_tss, tss_source, ftp_used, baseline_power_mode,
          baseline_power_value, strength_focus
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        RETURNING *
      `, [
        uid, activity.startTime, activity.durationSeconds, activity.activityType,
        activity.workoutType, activity.title, activity.notes, activity.perceivedExertion,
        metrics.averagePower, metrics.normalizedPower, metrics.estimatedTss, metrics.tssSource,
        metrics.ftpUsed, activity.baselinePowerMode, activity.baselinePowerValue,
        activity.strengthFocus
      ]);
      await insertIntervals(result.rows[0].id, activity.intervals, client);
      return { ...result.rows[0], intervals: activity.intervals };
    });
  }

  static async update(uid, activityId, payload, db = pool) {
    return withTransaction(db, async (client) => {
      const { activity, metrics } = await prepareActivity(uid, payload, client);
      const result = await client.query(`
        UPDATE training_activities
        SET start_time = $3,
            duration_seconds = $4,
            activity_type = $5,
            workout_type = $6,
            title = $7,
            notes = $8,
            perceived_exertion = $9,
            average_power = $10,
            avg_normalized_power = $11,
            estimated_tss = $12,
            tss_source = $13,
            ftp_used = $14,
            baseline_power_mode = $15,
            baseline_power_value = $16,
            strength_focus = $17
        WHERE id = $1 AND uid = $2
        RETURNING *
      `, [
        activityId, uid, activity.startTime, activity.durationSeconds, activity.activityType,
        activity.workoutType, activity.title, activity.notes, activity.perceivedExertion,
        metrics.averagePower, metrics.normalizedPower, metrics.estimatedTss, metrics.tssSource,
        metrics.ftpUsed, activity.baselinePowerMode, activity.baselinePowerValue,
        activity.strengthFocus
      ]);
      if (!result.rows[0]) return null;
      await client.query("DELETE FROM training_activity_intervals WHERE training_activity_id = $1", [activityId]);
      await insertIntervals(activityId, activity.intervals, client);
      return { ...result.rows[0], intervals: activity.intervals };
    });
  }

  static async copyToStartTimes(uid, activityId, targetStartTimes, db = pool) {
    const normalizedTargets = normalizeTrainingActivityCopyTargets(targetStartTimes);
    return withTransaction(db, async (client) => {
      const source = await TrainingActivityDBService.getById(uid, activityId, client);
      if (!source) return null;

      const existingResult = await client.query(`
        SELECT start_time
        FROM training_activities
        WHERE uid = $1
          AND start_time = ANY($2::timestamptz[])
      `, [uid, normalizedTargets]);
      const existing = new Set((existingResult.rows || []).map((row) => new Date(row.start_time).toISOString()));
      const created = [];
      const skippedStartTimes = normalizedTargets.filter((startTime) => existing.has(startTime));
      const hasPendingTargets = normalizedTargets.some((startTime) => !existing.has(startTime));
      const ftpCandidates = source.activity_type === "cycling" && hasPendingTargets
        ? await loadHistoricalFtpCandidates(uid, client)
        : [];

      for (const startTime of normalizedTargets) {
        if (existing.has(startTime)) continue;
        const activity = normalizeTrainingActivityPayload(
          copyPayloadFromStoredActivity(source, startTime)
        );
        const metrics = calculateManualCyclingMetrics(
          activity,
          activity.activityType === "cycling"
            ? resolveHistoricalFtpFromCandidates(ftpCandidates, activity.startTime)
            : null
        );
        const result = await client.query(`
          INSERT INTO training_activities (
            uid, start_time, duration_seconds, activity_type, workout_type,
            title, notes, perceived_exertion, average_power, avg_normalized_power,
            estimated_tss, tss_source, ftp_used, baseline_power_mode,
            baseline_power_value, strength_focus
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
          RETURNING *
        `, [
          uid, activity.startTime, activity.durationSeconds, activity.activityType,
          activity.workoutType, activity.title, activity.notes, activity.perceivedExertion,
          metrics.averagePower, metrics.normalizedPower, metrics.estimatedTss, metrics.tssSource,
          metrics.ftpUsed, activity.baselinePowerMode, activity.baselinePowerValue,
          activity.strengthFocus
        ]);
        await insertIntervals(result.rows[0].id, activity.intervals, client);
        created.push(result.rows[0]);
      }

      return {
        created,
        skippedStartTimes,
        requestedCount: normalizedTargets.length
      };
    });
  }

  static async delete(uid, activityId, db = pool) {
    const result = await db.query(
      "DELETE FROM training_activities WHERE id = $1 AND uid = $2 RETURNING id",
      [activityId, uid]
    );
    return result.rows[0] || null;
  }
}
