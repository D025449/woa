
import pool from "./database.js"; // dein Postgres-Pool



export default class UserDBService {

  static async ensureUserExists(userInfo) {

    const sub = userInfo.sub;
    const email = userInfo.username;
    const email_verified = true;
    const name = userInfo.username;

    const result = await pool.query(`
    INSERT INTO users (auth_sub, email, email_verified, display_name)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (auth_sub)
    DO UPDATE SET
      email = EXCLUDED.email,
      email_verified = EXCLUDED.email_verified,
      display_name = EXCLUDED.display_name RETURNING *
  `, [sub, email, email_verified, name]);

    return result.rows[0];
  }





}

