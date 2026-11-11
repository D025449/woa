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

/**
 * @param {string} userId Internal DB user id
 * @param {{providers?: string[], limit?: number}} options
 */
export async function syncWorkoutsFromProviders(userId, { providers = ["garmin", "wahoo"], limit = 10 } = {}) {
  const available = await connectedProviders(userId);
  const active = providers.filter(p => available[p]);
  if (!active.length) {
    return { results: [], summary: { imported: 0, skipped: 0, failed: 0, providers_connected: [] } };
  }

  const entryReaders = [];
  const meta = []; // {provider, activity, entryName, preSkip?, preReason?}
  let totalBytes = 0;

  for (const provider of active) {
    let activities;
    try {
      activities = provider === "garmin"
        ? await GarminConnectService.activities(userId, 0)
        : await WahooImportService.activities(userId, 0);
      activities = activities.slice(0, limit);
    } catch {
      // Provider entirely unavailable – record provider-level failure as a synthetic entry
      meta.push({ provider, activity: { id: "?", name: "", startTime: "" },
        preSkip: true, preReason: "provider_unavailable" });
      continue;
    }

    for (const activity of activities) {
      const entryName = `${provider}_${activity.id}.woa1`;
      try {
        let fitBuffer;
        if (provider === "garmin") {
          const zipBuffer = await GarminConnectService.file(userId, activity.id);
          fitBuffer = await extractGarminFit(zipBuffer);
          if (!fitBuffer) {
            meta.push({ provider, activity, preSkip: true, preReason: "no_fit_in_zip" });
            continue;
          }
        } else {
          validateWahooId(activity.id);
          fitBuffer = await WahooImportService.file(userId, activity.id);
        }
        const woa = await convertWahooFit(fitBuffer);
        if (!woa) {
          meta.push({ provider, activity, preSkip: true, preReason: "short_workout" });
          continue;
        }
        totalBytes += fitBuffer.length;
        const captured = woa;
        entryReaders.push({ path: entryName, buffer: async () => captured });
        meta.push({ provider, activity, entryName });
      } catch (error) {
        const reason = /^(garmin|wahoo)_[a-z_]+$/.test(error?.code || "") ? error.code : "fetch_failed";
        meta.push({ provider, activity, preSkip: true, preReason: reason });
      }
    }
  }

  let importResult = { importedCount: 0, skippedCount: 0, inserted: [], skipped: [] };
  if (entryReaders.length > 0) {
    const { importWoaEntryReaders } = await import("../routes/woaUploads.js");
    importResult = await importWoaEntryReaders({
      userId, sourceName: "mcp-provider-sync",
      uploadedSizeBytes: totalBytes, entryReaders, overwriteExisting: false
    });
  }

  const skippedByName = new Map(importResult.skipped.map(s => [s.entryName, s.code || "skipped"]));
  const results = [];

  for (const m of meta) {
    if (!m.activity.id || m.activity.id === "?") {
      results.push({ provider: m.provider, status: "failed", reason: m.preReason });
      continue;
    }
    const base = { provider: m.provider, activity_id: m.activity.id,
      name: m.activity.name, start_time: m.activity.startTime };
    if (m.preSkip) {
      results.push({ ...base, status: "skipped", reason: m.preReason });
      continue;
    }
    const skipReason = skippedByName.get(m.entryName);
    if (skipReason !== undefined) {
      results.push({ ...base, status: "skipped", reason: skipReason });
    } else {
      results.push({ ...base, status: "imported" });
    }
  }

  return {
    results,
    summary: {
      imported: results.filter(r => r.status === "imported").length,
      skipped: results.filter(r => r.status === "skipped").length,
      failed: results.filter(r => r.status === "failed").length,
      providers_connected: active
    }
  };
}
