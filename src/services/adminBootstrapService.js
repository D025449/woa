import pool from "./database.js";

function normalizedValue(value) {
  return String(value || "").trim();
}

/**
 * @param {{authSub?: string, email?: string, confirm?: string}} [request]
 */
export function normalizeAdminBootstrapRequest(request = {}) {
  const { authSub, email, confirm } = request;
  const normalizedAuthSub = normalizedValue(authSub);
  const normalizedEmail = normalizedValue(email).toLowerCase();
  const normalizedConfirm = normalizedValue(confirm);

  if (Boolean(normalizedAuthSub) === Boolean(normalizedEmail)) {
    throw new Error("Specify exactly one of --auth-sub or --email.");
  }
  const selector = normalizedAuthSub || normalizedEmail;
  const effectiveConfirm = normalizedEmail ? normalizedConfirm.toLowerCase() : normalizedConfirm;
  if (effectiveConfirm !== selector) {
    throw new Error(`Bootstrap requires --confirm ${selector}.`);
  }
  return normalizedAuthSub
    ? { type: "auth-sub", value: normalizedAuthSub }
    : { type: "email", value: normalizedEmail };
}

export default class AdminBootstrapService {
  static async bootstrap(request) {
    const selector = normalizeAdminBootstrapRequest(request);
    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      await client.query("LOCK TABLE user_roles IN SHARE ROW EXCLUSIVE MODE");

      const userResult = selector.type === "auth-sub"
        ? await client.query(`
            SELECT id, auth_sub, email, account_status
            FROM users
            WHERE auth_sub = $1
          `, [selector.value])
        : await client.query(`
            SELECT id, auth_sub, email, account_status
            FROM users
            WHERE lower(email) = $1
            ORDER BY id
          `, [selector.value]);

      if (userResult.rowCount === 0) {
        throw new Error(`No user found for ${selector.type} ${selector.value}. Log in once first.`);
      }
      if (userResult.rowCount !== 1) {
        throw new Error(`The ${selector.type} selector is not unique: ${selector.value}.`);
      }
      const user = userResult.rows[0];
      if (user.account_status !== "active") {
        throw new Error(`Cannot bootstrap a non-active user (${user.account_status}).`);
      }

      const adminsResult = await client.query(`
        SELECT uid
        FROM user_roles
        WHERE role = 'admin'
        ORDER BY uid
      `);
      const adminIds = adminsResult.rows.map((row) => String(row.uid));
      const userId = String(user.id);
      if (adminIds.length > 0) {
        if (adminIds.length === 1 && adminIds[0] === userId) {
          await client.query("COMMIT");
          return {
            created: false,
            alreadyAdmin: true,
            user: { id: Number(user.id), authSub: user.auth_sub, email: user.email }
          };
        }
        throw new Error("Admin bootstrap is closed because an admin already exists.");
      }

      await client.query(`
        INSERT INTO user_roles (uid, role, granted_at, granted_by_uid)
        VALUES ($1, 'admin', NOW(), $1)
      `, [user.id]);
      await client.query("COMMIT");
      return {
        created: true,
        alreadyAdmin: false,
        user: { id: Number(user.id), authSub: user.auth_sub, email: user.email }
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}
