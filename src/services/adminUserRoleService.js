import pool from "./database.js";

export class AdminUserRoleError extends Error {
  constructor(message, status = 400, code = "ADMIN_ROLE_ERROR") {
    super(message);
    this.name = "AdminUserRoleError";
    this.status = status;
    this.code = code;
  }
}

function normalizeRoleFilter(value) {
  const normalized = String(value || "all").trim().toLowerCase();
  return ["all", "admin", "user"].includes(normalized) ? normalized : "all";
}

export default class AdminUserRoleService {
  static async listUsers({ search = "", role = "all" } = {}, database = pool) {
    const normalizedSearch = String(search || "").trim().slice(0, 100);
    const normalizedRole = normalizeRoleFilter(role);
    const [usersResult, adminCountResult] = await Promise.all([
      database.query(`
        SELECT
          u.id,
          u.email,
          u.display_name,
          u.account_status,
          u.email_verified,
          u.created_at,
          (r.uid IS NOT NULL) AS is_admin,
          r.granted_at,
          grantor.display_name AS granted_by_display_name,
          grantor.email AS granted_by_email,
          COUNT(*) OVER()::integer AS filtered_count
        FROM users u
        LEFT JOIN user_roles r
          ON r.uid = u.id AND r.role = 'admin'
        LEFT JOIN users grantor ON grantor.id = r.granted_by_uid
        WHERE (
          $1 = ''
          OR u.email ILIKE '%' || $1 || '%'
          OR COALESCE(u.display_name, '') ILIKE '%' || $1 || '%'
          OR u.id::text = $1
        )
          AND (
            $2 = 'all'
            OR ($2 = 'admin' AND r.uid IS NOT NULL)
            OR ($2 = 'user' AND r.uid IS NULL)
          )
        ORDER BY
          (r.uid IS NOT NULL) DESC,
          LOWER(COALESCE(NULLIF(u.display_name, ''), u.email)) ASC,
          u.id ASC
        LIMIT 200
      `, [normalizedSearch, normalizedRole]),
      database.query(`
        SELECT COUNT(*)::integer AS admin_count
        FROM user_roles
        WHERE role = 'admin'
      `)
    ]);

    return {
      users: usersResult.rows.map((row) => ({
        id: String(row.id),
        email: row.email,
        displayName: row.display_name || row.email,
        accountStatus: row.account_status,
        emailVerified: Boolean(row.email_verified),
        createdAt: row.created_at,
        isAdmin: Boolean(row.is_admin),
        grantedAt: row.granted_at || null,
        grantedBy: row.granted_by_display_name || row.granted_by_email || null
      })),
      filteredCount: Number(usersResult.rows[0]?.filtered_count || 0),
      adminCount: Number(adminCountResult.rows[0]?.admin_count || 0)
    };
  }

  static async grantAdmin(actorUserId, targetUserId, database = pool) {
    return AdminUserRoleService.withRoleLock(database, async (client) => {
      await AdminUserRoleService.assertActorIsAdmin(client, actorUserId);
      const target = await AdminUserRoleService.getTargetUser(client, targetUserId);
      if (target.account_status !== "active") {
        throw new AdminUserRoleError(
          "Only active users can be made administrators.",
          409,
          "TARGET_NOT_ACTIVE"
        );
      }

      const result = await client.query(`
        INSERT INTO user_roles (uid, role, granted_at, granted_by_uid)
        VALUES ($1, 'admin', NOW(), $2)
        ON CONFLICT (uid, role) DO NOTHING
        RETURNING uid
      `, [targetUserId, actorUserId]);

      return { changed: result.rowCount > 0, userId: String(targetUserId), isAdmin: true };
    });
  }

  static async revokeAdmin(actorUserId, targetUserId, database = pool) {
    return AdminUserRoleService.withRoleLock(database, async (client) => {
      await AdminUserRoleService.assertActorIsAdmin(client, actorUserId);
      await AdminUserRoleService.getTargetUser(client, targetUserId);

      if (String(actorUserId) === String(targetUserId)) {
        throw new AdminUserRoleError(
          "You cannot remove your own administrator role.",
          409,
          "SELF_REVOKE_FORBIDDEN"
        );
      }

      const targetRole = await client.query(`
        SELECT 1
        FROM user_roles
        WHERE uid = $1 AND role = 'admin'
        LIMIT 1
      `, [targetUserId]);
      if (targetRole.rowCount === 0) {
        throw new AdminUserRoleError(
          "The selected user is not an administrator.",
          409,
          "TARGET_NOT_ADMIN"
        );
      }

      const countResult = await client.query(`
        SELECT COUNT(*)::integer AS admin_count
        FROM user_roles
        WHERE role = 'admin'
      `);
      if (Number(countResult.rows[0]?.admin_count || 0) <= 1) {
        throw new AdminUserRoleError(
          "At least one administrator must remain.",
          409,
          "LAST_ADMIN_PROTECTED"
        );
      }

      await client.query(`
        DELETE FROM user_roles
        WHERE uid = $1 AND role = 'admin'
      `, [targetUserId]);
      return { changed: true, userId: String(targetUserId), isAdmin: false };
    });
  }

  static async withRoleLock(database, operation) {
    const client = await database.connect();
    try {
      await client.query("BEGIN");
      await client.query("LOCK TABLE user_roles IN SHARE ROW EXCLUSIVE MODE");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  static async assertActorIsAdmin(client, actorUserId) {
    const result = await client.query(`
      SELECT 1
      FROM user_roles
      WHERE uid = $1 AND role = 'admin'
      LIMIT 1
    `, [actorUserId]);
    if (result.rowCount === 0) {
      throw new AdminUserRoleError(
        "Administrator role required.",
        403,
        "ACTOR_NOT_ADMIN"
      );
    }
  }

  static async getTargetUser(client, targetUserId) {
    const result = await client.query(`
      SELECT id, account_status
      FROM users
      WHERE id = $1
      FOR UPDATE
    `, [targetUserId]);
    if (result.rowCount === 0) {
      throw new AdminUserRoleError("User not found.", 404, "USER_NOT_FOUND");
    }
    return result.rows[0];
  }
}
