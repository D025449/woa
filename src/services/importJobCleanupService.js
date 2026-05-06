import pool from "./database.js";

export default class ImportJobCleanupService {
  static async deleteOldFinishedJobs({ olderThanHours = 168, limit = 500 } = {}) {
    const normalizedHours = Number.isFinite(Number(olderThanHours)) && Number(olderThanHours) > 0
      ? Math.trunc(Number(olderThanHours))
      : 168;
    const normalizedLimit = Number.isFinite(Number(limit)) && Number(limit) > 0
      ? Math.trunc(Number(limit))
      : 500;

    const result = await pool.query(`
      WITH doomed AS (
        SELECT id
        FROM import_jobs
        WHERE status IN ('completed', 'failed')
          AND updated_at < NOW() - ($1::text || ' hours')::interval
        ORDER BY updated_at ASC
        LIMIT $2
      )
      DELETE FROM import_jobs
      WHERE id IN (SELECT id FROM doomed)
      RETURNING id
    `, [String(normalizedHours), normalizedLimit]);

    return {
      deleted: result.rowCount || 0
    };
  }
}
