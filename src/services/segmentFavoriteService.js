import pool from "./database.js";

export default class SegmentFavoriteService {
  static async add(uid, segmentId, db = pool) {
    const result = await db.query(`
      INSERT INTO segment_favorites (uid, segment_id)
      VALUES ($1, $2)
      ON CONFLICT (uid, segment_id) DO NOTHING
      RETURNING segment_id, created_at
    `, [uid, segmentId]);

    return result.rows[0] || null;
  }

  static async remove(uid, segmentId, db = pool) {
    const result = await db.query(`
      DELETE FROM segment_favorites
      WHERE uid = $1
        AND segment_id = $2
      RETURNING segment_id
    `, [uid, segmentId]);

    return result.rows[0] || null;
  }

  static async listAccessibleIds(uid, db = pool) {
    const result = await db.query(`
      SELECT sf.segment_id
      FROM segment_favorites sf
      INNER JOIN gps_segments s
        ON s.id = sf.segment_id
      WHERE sf.uid = $1
        AND (
          s.uid = $1
          OR EXISTS (
            SELECT 1
            FROM gps_segment_group_shares sgs
            INNER JOIN group_members gm
              ON gm.group_id = sgs.group_id
            WHERE sgs.segment_id = s.id
              AND gm.user_id = $1
          )
        )
      ORDER BY sf.created_at DESC
    `, [uid]);

    return result.rows.map((row) => String(row.segment_id));
  }
}
