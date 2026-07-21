import pool from "./database.js";

export default class WorkoutFavoriteService {
  static async add(uid, workoutId, db = pool) {
    const result = await db.query(`
      INSERT INTO workout_favorites (uid, workout_id)
      VALUES ($1, $2)
      ON CONFLICT (uid, workout_id) DO NOTHING
      RETURNING workout_id, created_at
    `, [uid, workoutId]);

    return result.rows[0] || null;
  }

  static async remove(uid, workoutId, db = pool) {
    const result = await db.query(`
      DELETE FROM workout_favorites
      WHERE uid = $1
        AND workout_id = $2
      RETURNING workout_id
    `, [uid, workoutId]);

    return result.rows[0] || null;
  }
}
