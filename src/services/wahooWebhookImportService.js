import { Worker } from "node:worker_threads";
import pool from "./database.js";
import ImportService from "./wahooImportService.js";

export function convertWahooFit(bytes) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("../workers/wahoo-fit-converter.js", import.meta.url), {
      workerData: bytes, resourceLimits: { maxOldGenerationSizeMb: 512 }
    });
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (error) reject(new Error("Wahoo conversion failed")); else resolve(value == null ? null : Buffer.from(value));
    };
    const timer = setTimeout(() => finish(true), 60000);
    worker.once("message", result => finish(result.error || (!result.bytes && !result.skipped), result.bytes));
    worker.once("error", () => finish(true));
    worker.once("exit", code => { if (code !== 0) finish(true); });
  });
}

async function allowed(client, event, lock = false) {
  const result = await client.query(`SELECT c.user_id
    FROM user_wahoo_connections c JOIN users u ON u.id = c.user_id
    WHERE c.user_id = $1 AND c.wahoo_user_id = $2
      AND c.auto_import_enabled = TRUE AND c.offline_data_granted = TRUE
      AND u.account_status = 'active' ${lock ? "FOR SHARE OF c, u" : ""}`,
  [event.user_id, event.wahoo_user_id]);
  return result.rows.length > 0;
}

export async function importWahooEvent(client, event, { convert = convertWahooFit, persist = persistWahooWorkout } = {}) {
  if (!await allowed(client, event)) return "skipped";
  const bytes = await ImportService.file(event.user_id, event.workout_id, event.workout_summary_id);
  const woa = await convert(bytes);
  if (!woa) return "skipped";
  // Recheck and lock account/connection immediately before saving. Disabling,
  // disconnecting and account deletion wait until this save has finished.
  await client.query("BEGIN");
  try {
    if (!await allowed(client, event, true)) {
      await client.query("COMMIT");
      return "skipped";
    }
    if (event.attempts === 1) {
      const { decodeWoa1BufferLight } = await import("./woa1Service.js");
      const start = decodeWoa1BufferLight(woa).meta.persistedRow.start_time;
      const existing = await client.query("SELECT id FROM workouts WHERE uid = $1 AND start_time = $2", [event.user_id, start]);
      if (existing.rows.length) {
        await client.query("COMMIT");
        return "skipped";
      }
    }
    const status = await persist(event, woa, bytes.length);
    await client.query("COMMIT");
    return status === "skipped" ? "skipped" : "completed";
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function persistWahooWorkout(event, woa, size) {
  const { importWoaEntryReaders } = await import("../routes/woaUploads.js");
  const result = await importWoaEntryReaders({
    userId: event.user_id, sourceName: "wahoo.fit", uploadedSizeBytes: size,
    overwriteExisting: false,
    entryReaders: [{ path: "wahoo.woa1", buffer: async () => woa }]
  });
  if (result.postprocessErrorCount) throw new Error("Wahoo import failed");
  if (result.importedCount === 0 && result.skippedCount === 1
    && result.skipped[0]?.code === "workout_time_conflict") return "skipped";
  if (result.importedCount !== 1) throw new Error("Wahoo import failed");
  return "completed";
}

export async function processNextWahooImport(processEvent = importWahooEvent) {
  const client = await pool.connect();
  let lockedId;
  try {
    const candidates = await client.query(`SELECT id FROM wahoo_webhook_imports
      WHERE (status = 'pending' AND attempts < 5 AND available_at <= NOW()) OR status = 'processing'
      ORDER BY available_at, id LIMIT 20`);
    for (const candidate of candidates.rows) {
      // A session lock survives transactions and is released on process death.
      // This permits immediate crash recovery without racing a still-running import.
      const lock = await client.query("SELECT pg_try_advisory_lock(hashtextextended('wahoo-import:' || $1::text, 0)) AS locked", [candidate.id]);
      if (!lock.rows[0]?.locked) continue;
      lockedId = candidate.id;
      await client.query(`UPDATE wahoo_webhook_imports SET status = 'failed', locked_at = NULL,
        error_code = 'wahoo_import_failed', updated_at = NOW()
        WHERE id = $1 AND status = 'processing' AND attempts >= 5`, [lockedId]);
      const claim = await client.query(`UPDATE wahoo_webhook_imports
        SET status = 'processing', attempts = attempts + 1, locked_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND attempts < 5
          AND ((status = 'pending' AND available_at <= NOW()) OR status = 'processing') RETURNING *`, [lockedId]);
      const event = claim.rows[0];
      if (!event) {
        await client.query("SELECT pg_advisory_unlock(hashtextextended('wahoo-import:' || $1::text, 0))", [lockedId]);
        lockedId = undefined;
        continue;
      }
      try {
        const status = await processEvent(client, event);
        if (!["completed", "skipped"].includes(status)) throw new Error("Invalid import result");
        await client.query(`UPDATE wahoo_webhook_imports
          SET status = $2, locked_at = NULL, error_code = NULL, updated_at = NOW() WHERE id = $1`, [event.id, status]);
      } catch {
        await client.query(`UPDATE wahoo_webhook_imports
          SET status = CASE WHEN attempts >= 5 THEN 'failed' ELSE 'pending' END,
            available_at = NOW() + ($2 * INTERVAL '1 second'), locked_at = NULL,
            error_code = 'wahoo_import_failed', updated_at = NOW() WHERE id = $1`,
        [event.id, Math.min(3600, 30 * 4 ** (event.attempts - 1))]);
      }
      return true;
    }
    return false;
  } finally {
    try {
      if (lockedId !== undefined) await client.query("SELECT pg_advisory_unlock(hashtextextended('wahoo-import:' || $1::text, 0))", [lockedId]);
    } finally { client.release(); }
  }
}

export function startWahooWebhookImports() {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      for (let i = 0; i < 20; i++) {
        if (!await processNextWahooImport()) break;
      }
    } catch { console.error("[wahoo] webhook import processing unavailable"); }
    finally { busy = false; }
  };
  const timer = setInterval(tick, 5000);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
