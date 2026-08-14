export const MANUAL_ACTIVITY_FORMAT = "WOA_MANUAL_ACTIVITY";
export const MANUAL_ACTIVITY_VERSION = 1;
export const MANUAL_ACTIVITY_ARCHIVE_FORMAT = "WOA_MANUAL_ACTIVITY_ARCHIVE";
export const MANUAL_ACTIVITY_ARCHIVE_VERSION = 1;

function value(entry, camelName, snakeName) {
  return entry?.[camelName] ?? entry?.[snakeName] ?? null;
}

function buildPower(mode, amount) {
  return mode == null || amount == null ? null : { mode, value: Number(amount) };
}

export function manualActivityPayloadFromStored(activity) {
  const intervals = Array.isArray(activity?.intervals) ? activity.intervals : [];
  return {
    startTime: new Date(value(activity, "startTime", "start_time")).toISOString(),
    durationSeconds: Number(value(activity, "durationSeconds", "duration_seconds")),
    activityType: value(activity, "activityType", "activity_type"),
    workoutType: value(activity, "workoutType", "workout_type"),
    title: activity?.title ?? null,
    notes: activity?.notes ?? null,
    perceivedExertion: value(activity, "perceivedExertion", "perceived_exertion"),
    baselinePowerMode: value(activity, "baselinePowerMode", "baseline_power_mode"),
    baselinePowerValue: value(activity, "baselinePowerValue", "baseline_power_value"),
    estimatedTss: value(activity, "tssSource", "tss_source") === "manual"
      ? Number(value(activity, "estimatedTss", "estimated_tss"))
      : null,
    strengthFocus: value(activity, "strengthFocus", "strength_focus"),
    intervals: intervals.map((interval) => ({
      repetitions: Number(interval.repetitions),
      workDurationSeconds: Number(value(interval, "workDurationSeconds", "work_duration_seconds")),
      recoveryDurationSeconds: Number(value(interval, "recoveryDurationSeconds", "recovery_duration_seconds")),
      powerMode: value(interval, "powerMode", "power_mode"),
      workPowerValue: Number(value(interval, "workPowerValue", "work_power_value")),
      recoveryPowerValue: value(interval, "recoveryPowerValue", "recovery_power_value") == null
        ? null
        : Number(value(interval, "recoveryPowerValue", "recovery_power_value"))
    }))
  };
}

export function buildManualActivityDocument(activity, exportedAt = new Date()) {
  const payload = manualActivityPayloadFromStored(activity);
  return {
    format: MANUAL_ACTIVITY_FORMAT,
    version: MANUAL_ACTIVITY_VERSION,
    exportedAt: new Date(exportedAt).toISOString(),
    activity: {
      startTime: payload.startTime,
      durationSeconds: payload.durationSeconds,
      activityType: payload.activityType,
      workoutType: payload.workoutType,
      title: payload.title,
      notes: payload.notes,
      perceivedExertion: payload.perceivedExertion,
      baselinePower: buildPower(payload.baselinePowerMode, payload.baselinePowerValue),
      estimatedTssOverride: payload.estimatedTss,
      strengthFocus: payload.strengthFocus,
      intervals: payload.intervals.map((interval) => ({
        repetitions: interval.repetitions,
        workDurationSeconds: interval.workDurationSeconds,
        recoveryDurationSeconds: interval.recoveryDurationSeconds,
        power: {
          mode: interval.powerMode,
          workValue: interval.workPowerValue,
          recoveryValue: interval.recoveryPowerValue
        }
      }))
    }
  };
}

export function parseManualActivityDocument(document) {
  if (!document || document.format !== MANUAL_ACTIVITY_FORMAT) {
    throw new Error("Unsupported manual activity format");
  }
  if (document.version !== MANUAL_ACTIVITY_VERSION) {
    throw new Error(`Unsupported manual activity version: ${document.version}`);
  }
  const activity = document.activity;
  if (!activity || typeof activity !== "object" || Array.isArray(activity)) {
    throw new Error("Manual activity payload is missing");
  }
  if (!Array.isArray(activity.intervals)) {
    throw new Error("Manual activity intervals are invalid");
  }

  return {
    startTime: activity.startTime,
    durationSeconds: activity.durationSeconds,
    activityType: activity.activityType,
    workoutType: activity.workoutType,
    title: activity.title,
    notes: activity.notes,
    perceivedExertion: activity.perceivedExertion,
    baselinePowerMode: activity.baselinePower?.mode ?? null,
    baselinePowerValue: activity.baselinePower?.value ?? null,
    estimatedTss: activity.estimatedTssOverride ?? null,
    strengthFocus: activity.strengthFocus,
    intervals: activity.intervals.map((interval) => ({
      repetitions: interval?.repetitions,
      workDurationSeconds: interval?.workDurationSeconds,
      recoveryDurationSeconds: interval?.recoveryDurationSeconds,
      powerMode: interval?.power?.mode,
      workPowerValue: interval?.power?.workValue,
      recoveryPowerValue: interval?.power?.recoveryValue ?? null
    }))
  };
}

export function buildManualActivityArchiveManifest(count, exportedAt = new Date()) {
  return {
    format: MANUAL_ACTIVITY_ARCHIVE_FORMAT,
    version: MANUAL_ACTIVITY_ARCHIVE_VERSION,
    exportedAt: new Date(exportedAt).toISOString(),
    activityCount: Number(count)
  };
}

export function validateManualActivityArchiveManifest(manifest, actualCount) {
  if (!manifest || manifest.format !== MANUAL_ACTIVITY_ARCHIVE_FORMAT) {
    throw new Error("Unsupported manual activity archive");
  }
  if (manifest.version !== MANUAL_ACTIVITY_ARCHIVE_VERSION) {
    throw new Error(`Unsupported manual activity archive version: ${manifest.version}`);
  }
  if (!Number.isInteger(manifest.activityCount) || manifest.activityCount !== actualCount) {
    throw new Error("Manual activity archive count does not match its contents");
  }
  return manifest;
}

export function manualActivityFileName(startTime, suffix = "") {
  const date = new Date(startTime);
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid manual activity start time");
  const timestamp = date.toISOString().slice(0, 19).replace(/[T:]/gu, "-");
  const normalizedSuffix = suffix === "" ? "" : `-${String(suffix).replace(/[^a-zA-Z0-9_-]/gu, "-")}`;
  return `${timestamp}${normalizedSuffix}-manual-activity.woa.json`;
}
