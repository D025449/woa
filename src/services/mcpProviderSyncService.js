import pool from "./database.js";
import GarminConnectService from "./garminConnectService.js";
import WahooImportService, { validateWahooId } from "./wahooImportService.js";
import { convertWahooFit } from "./wahooWebhookImportService.js";

async function extractGarminFit(zipBuffer) {
  const { Open } = await import("unzipper");
  const directory = await Open.buffer(zipBuffer);
  const entry = directory.files.find(f => f.path.toLowerCase().endsWith(".fit"));
  if (!entry) return null;
  return entry.buffer();
}

async function connectedProviders(userId) {
  const [garmin, wahoo] = await Promise.all([
    pool.query("SELECT 1 FROM user_garmin_connections WHERE user_id = $1", [userId]),
    pool.query("SELECT 1 FROM user_wahoo_connections WHERE user_id = $1", [userId])
  ]);
  return { garmin: garmin.rows.length > 0, wahoo: wahoo.rows.length > 0 };
}

// Quick pre-check: does a workout with this exact start_time already exist for the user?
// Returns a Map from ISO start_time → existing WOA workout id.
async function existingWorkoutsByStartTime(userId, startTimeStrings) {
  const valid = startTimeStrings.filter(s => s && s.length >= 10);
  if (!valid.length) return new Map();
  const { rows } = await pool.query(
    `SELECT id::text, start_time::text FROM workouts WHERE uid = $1 AND start_time = ANY($2::timestamptz[])`,
    [userId, valid]
  );
  return new Map(rows.map(r => [new Date(r.start_time).toISOString(), r.id]));
}

// For workouts that passed start_time pre-check but produced a workout_time_conflict during
// import, find the overlapping existing workout by the new workout's start_time.
async function findOverlappingWorkoutIds(userId, startTimeStrings) {
  const valid = startTimeStrings.filter(s => s && s.length >= 10);
  if (!valid.length) return new Map();
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (ts) ts, w.id::text
     FROM UNNEST($2::timestamptz[]) AS ts
     JOIN workouts w ON w.uid = $1
       AND w.start_time <= ts AND (w.end_time IS NULL OR w.end_time > ts)
     ORDER BY ts, w.start_time DESC`,
    [userId, valid]
  );
  return new Map(rows.map(r => [new Date(r.ts).toISOString(), r.id]));
}

/**
 * @param {string} userId Internal DB user id
 * @param {{providers?: string[], limit?: number, overwriteExisting?: boolean}} options
 */
export async function syncWorkoutsFromProviders(userId, { providers = ["garmin", "wahoo"], limit = 10, overwriteExisting = false } = {}) {
  const available = await connectedProviders(userId);
  const active = providers.filter(p => available[p]);
  if (!active.length) {
    return { results: [], summary: { imported: 0, already_in_woa: 0, skipped: 0, failed: 0, providers_connected: [] } };
  }

  const entryReaders = [];
  const meta = []; // {provider, activity, entryName?, preStatus?, preReason?}
  let totalBytes = 0;

  for (const provider of active) {
    let activities;
    try {
      activities = provider === "garmin"
        ? await GarminConnectService.activities(userId, 0)
        : await WahooImportService.activities(userId, 0);
      activities = activities.slice(0, limit);
    } catch {
      meta.push({ provider, activity: { id: "?", name: "", startTime: "" },
        preStatus: "failed", preReason: "provider_unavailable" });
      continue;
    }

    // Pre-check: find activities whose start_time already exists in WOA.
    // Works reliably for Wahoo (UTC ISO 8601). Garmin uses local time so this
    // catches matches opportunistically; FIT-level conflict detection handles the rest.
    const preCheckMap = await existingWorkoutsByStartTime(userId, activities.map(a => a.startTime));

    for (const activity of activities) {
      const existingId = preCheckMap.get(new Date(activity.startTime).toISOString());
      if (existingId) {
        meta.push({ provider, activity, preStatus: "already_in_woa", existingWorkoutId: existingId });
        continue;
      }

      const entryName = `${provider}_${activity.id}.woa1`;
      try {
        let fitBuffer;
        if (provider === "garmin") {
          const zipBuffer = await GarminConnectService.file(userId, activity.id);
          fitBuffer = await extractGarminFit(zipBuffer);
          if (!fitBuffer) {
            meta.push({ provider, activity, preStatus: "skipped", preReason: "no_fit_in_zip" });
            continue;
          }
        } else {
          validateWahooId(activity.id);
          fitBuffer = await WahooImportService.file(userId, activity.id);
        }
        const woa = await convertWahooFit(fitBuffer);
        if (!woa) {
          meta.push({ provider, activity, preStatus: "skipped", preReason: "short_workout" });
          continue;
        }
        totalBytes += fitBuffer.length;
        const captured = woa;
        entryReaders.push({ path: entryName, buffer: async () => captured });
        meta.push({ provider, activity, entryName });
      } catch (error) {
        const reason = /^(garmin|wahoo)_[a-z_]+$/.test(error?.code || "") ? error.code : "fetch_failed";
        meta.push({ provider, activity, preStatus: "failed", preReason: reason });
      }
    }
  }

  let importResult = { importedCount: 0, skippedCount: 0, inserted: [], skipped: [] };
  if (entryReaders.length > 0) {
    const { importWoaEntryReaders } = await import("../routes/woaUploads.js");
    importResult = await importWoaEntryReaders({
      userId, sourceName: "mcp-provider-sync",
      uploadedSizeBytes: totalBytes, entryReaders, overwriteExisting
    });
  }

  // For workout_time_conflict entries from import, look up the overlapping existing workout.
  const importConflicts = importResult.skipped.filter(s => s.code === "workout_time_conflict" && s.startTime);
  const overlapMap = await findOverlappingWorkoutIds(userId, importConflicts.map(s => s.startTime));
  const conflictByEntryName = new Map(importConflicts.map(s => [s.entryName, s.startTime]));

  const skippedByName = new Map(importResult.skipped.map(s => [s.entryName, s.code || "skipped"]));
  const results = [];

  for (const m of meta) {
    if (!m.activity.id || m.activity.id === "?") {
      results.push({ provider: m.provider, status: "failed", reason: m.preReason });
      continue;
    }
    const base = { provider: m.provider, activity_id: m.activity.id,
      name: m.activity.name, start_time: m.activity.startTime };
    if (m.preStatus) {
      const extra = m.existingWorkoutId ? { existing_workout_id: m.existingWorkoutId } : {};
      results.push({ ...base, status: m.preStatus, ...(m.preReason ? { reason: m.preReason } : {}), ...extra });
      continue;
    }
    const importCode = skippedByName.get(m.entryName);
    if (importCode === "workout_time_conflict") {
      const conflictStart = conflictByEntryName.get(m.entryName);
      const existingId = conflictStart ? overlapMap.get(new Date(conflictStart).toISOString()) : undefined;
      results.push({ ...base, status: "already_in_woa", ...(existingId ? { existing_workout_id: existingId } : {}) });
    } else if (importCode !== undefined) {
      results.push({ ...base, status: "skipped", reason: importCode });
    } else {
      results.push({ ...base, status: "imported" });
    }
  }

  return {
    results,
    summary: {
      imported: results.filter(r => r.status === "imported").length,
      already_in_woa: results.filter(r => r.status === "already_in_woa").length,
      skipped: results.filter(r => r.status === "skipped").length,
      failed: results.filter(r => r.status === "failed").length,
      providers_connected: active
    }
  };
}
