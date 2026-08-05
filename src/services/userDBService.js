
import pool from "./database.js"; // dein Postgres-Pool



export default class UserDBService {

  static async ensureUserExists(userInfo, database = pool) {

    const sub = userInfo.sub;
    const email = userInfo.email || userInfo.username;
    const email_verified = userInfo.email_verified ?? false;
    const name = userInfo.name || userInfo.email || userInfo.username;

    const existingResult = await database.query(`
      UPDATE users
      SET
        email = $2,
        email_verified = $3,
        display_name = COALESCE(NULLIF(users.display_name, ''), $4)
      WHERE auth_sub = $1
      RETURNING *
    `, [sub, email, email_verified, name]);

    if (existingResult.rowCount > 0) {
      return existingResult.rows[0];
    }

    const client = await database.connect();

    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('cwa24:first-user-admin'))"
      );

      const firstUserResult = await client.query(`
        SELECT NOT EXISTS (SELECT 1 FROM users) AS is_first_user
      `);
      const isFirstUser = Boolean(firstUserResult.rows[0]?.is_first_user);

      const result = await client.query(`
        INSERT INTO users (auth_sub, email, email_verified, display_name)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (auth_sub)
        DO UPDATE SET
          email = EXCLUDED.email,
          email_verified = EXCLUDED.email_verified,
          display_name = COALESCE(NULLIF(users.display_name, ''), EXCLUDED.display_name)
        RETURNING *
      `, [sub, email, email_verified, name]);

      if (isFirstUser) {
        await client.query(`
          INSERT INTO user_roles (uid, role, granted_at, granted_by_uid)
          VALUES ($1, 'admin', NOW(), $1)
          ON CONFLICT (uid, role) DO NOTHING
        `, [result.rows[0].id]);
      }

      await client.query("COMMIT");
      return result.rows[0];
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
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

  static async getUserAppSettings(userId) {
    const result = await pool.query(`
      SELECT
        p.language,
        p.show_sudoku,
        EXISTS (
          SELECT 1
          FROM user_roles r
          WHERE r.uid = u.id AND r.role = 'admin'
        ) AS is_admin
      FROM users u
      LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE u.id = $1
      LIMIT 1
    `, [userId]);

    if (result.rowCount === 0) {
      return {
        language: "en",
        showSudoku: false,
        isAdmin: false
      };
    }

    return {
      language: result.rows[0]?.language || "en",
      showSudoku: Boolean(result.rows[0]?.show_sudoku),
      isAdmin: Boolean(result.rows[0]?.is_admin)
    };
  }




}
