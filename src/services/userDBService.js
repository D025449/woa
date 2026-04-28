
import pool from "./database.js"; // dein Postgres-Pool



export default class UserDBService {

  static async ensureUserExists(userInfo) {

    const sub = userInfo.sub;
    const email = userInfo.email || userInfo.username;
    const email_verified = userInfo.email_verified ?? false;
    const name = userInfo.name || userInfo.email || userInfo.username;

    const result = await pool.query(`
    INSERT INTO users (auth_sub, email, email_verified, display_name)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (auth_sub)
    DO UPDATE SET
      email = EXCLUDED.email,
      email_verified = EXCLUDED.email_verified,
      display_name = COALESCE(NULLIF(users.display_name, ''), EXCLUDED.display_name)
    RETURNING *
  `, [sub, email, email_verified, name]);

    return result.rows[0];
  }

  static async getUserLanguage(userId) {
    const result = await pool.query(
      `SELECT language FROM user_profiles WHERE user_id = $1 LIMIT 1`,
      [userId]
    );
    if (result.rowCount === 0) {
      return "en";
    }
    return result.rows[0]?.language || "en";
  }




}
