import pool from "../services/database.js";

function mapRow(row) {
  if (!row) return null;
  return {
    uid: String(row.uid),
    uploadId: row.upload_id,
    status: row.status,
    phase: row.phase,
    workoutsPath: row.workouts_path,
    workoutPostprocessPath: row.workout_postprocess_path,
    gpsBestEffortsPath: row.gps_best_efforts_path,
    workoutsOriginalName: row.workouts_original_name,
    workoutsCodec: row.workouts_codec,
    overwriteExisting: !!row.overwrite_existing,
    workoutsBytes: Number(row.workouts_bytes || 0),
    workoutPostprocessBytes: Number(row.workout_postprocess_bytes || 0),
    gpsBestEffortsBytes: Number(row.gps_best_efforts_bytes || 0),
    importResult: row.import_result,
    workoutPostprocessResult: row.workout_postprocess_result,
    gpsBestEffortsResult: row.gps_best_efforts_result,
    attemptCount: Number(row.attempt_count || 0),
    lastError: row.last_error,
    updatedAt: row.updated_at
  };
}

export async function createWoaBundleUpload(bundle) {
  const result = await pool.query(`
    INSERT INTO woa_bundle_uploads (
      uid, upload_id, workouts_path, workout_postprocess_path, gps_best_efforts_path,
      workouts_original_name, workouts_codec, overwrite_existing,
      workouts_bytes, workout_postprocess_bytes, gps_best_efforts_bytes
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    ON CONFLICT (uid, upload_id) DO NOTHING
    RETURNING *
  `, [
    bundle.uid,
    bundle.uploadId,
    bundle.workoutsPath,
    bundle.workoutPostprocessPath,
    bundle.gpsBestEffortsPath,
    bundle.workoutsOriginalName,
    bundle.workoutsCodec,
    !!bundle.overwriteExisting,
    bundle.workoutsBytes,
    bundle.workoutPostprocessBytes,
    bundle.gpsBestEffortsBytes
  ]);
  return mapRow(result.rows[0]);
}

export async function getWoaBundleUpload(uid, uploadId) {
  const result = await pool.query(`
    SELECT *
    FROM woa_bundle_uploads
    WHERE uid = $1 AND upload_id = $2
  `, [uid, uploadId]);
  return mapRow(result.rows[0]);
}

export async function claimWoaBundleUpload(uid, uploadId, { allowActive = false } = {}) {
  const result = await pool.query(`
    UPDATE woa_bundle_uploads
    SET status = 'processing', attempt_count = attempt_count + 1,
        last_error = NULL, updated_at = NOW()
    WHERE uid = $1 AND upload_id = $2
      AND status <> 'completed'
      AND ($3::boolean OR status <> 'processing' OR updated_at < NOW() - INTERVAL '5 minutes')
    RETURNING *
  `, [uid, uploadId, allowActive]);
  return mapRow(result.rows[0]);
}

export async function checkpointWoaBundleUpload(uid, uploadId, phase, resultField, value) {
  const allowedFields = new Map([
    ["importResult", "import_result"],
    ["workoutPostprocessResult", "workout_postprocess_result"],
    ["gpsBestEffortsResult", "gps_best_efforts_result"]
  ]);
  const column = allowedFields.get(resultField);
  if (!column) throw new Error(`Unsupported WOA bundle checkpoint field: ${resultField}`);
  await pool.query(`
    UPDATE woa_bundle_uploads
    SET phase = $3, ${column} = $4::jsonb, updated_at = NOW()
    WHERE uid = $1 AND upload_id = $2
  `, [uid, uploadId, phase, JSON.stringify(value ?? null)]);
}

export async function completeWoaBundleUpload(uid, uploadId) {
  await pool.query(`
    UPDATE woa_bundle_uploads
    SET status = 'completed', phase = 'completed', last_error = NULL,
        completed_at = NOW(), updated_at = NOW()
    WHERE uid = $1 AND upload_id = $2
  `, [uid, uploadId]);
}

export async function failWoaBundleUpload(uid, uploadId, error, status = "failed") {
  await pool.query(`
    UPDATE woa_bundle_uploads
    SET status = $3, last_error = $4, updated_at = NOW()
    WHERE uid = $1 AND upload_id = $2
  `, [uid, uploadId, status, String(error?.message || error || "Unknown bundle error").slice(0, 4000)]);
}

export async function listRecoverableWoaBundleUploads(limit = 100) {
  const result = await pool.query(`
    SELECT *
    FROM woa_bundle_uploads
    WHERE status IN ('received', 'retry_queued', 'failed')
       OR (status = 'processing' AND updated_at < NOW() - INTERVAL '5 minutes')
    ORDER BY updated_at ASC
    LIMIT $1
  `, [Math.max(1, Number(limit) || 100)]);
  return result.rows.map(mapRow);
}

export async function listExpiredWoaBundleUploads(retentionHours = 24, limit = 100) {
  const result = await pool.query(`
    SELECT *
    FROM woa_bundle_uploads
    WHERE status IN ('completed', 'failed')
      AND updated_at < NOW() - make_interval(hours => $1::int)
    ORDER BY updated_at ASC
    LIMIT $2
  `, [Math.max(1, Number(retentionHours) || 24), Math.max(1, Number(limit) || 100)]);
  return result.rows.map(mapRow);
}

export async function deleteWoaBundleUpload(uid, uploadId) {
  await pool.query(`
    DELETE FROM woa_bundle_uploads
    WHERE uid = $1 AND upload_id = $2
  `, [uid, uploadId]);
}
