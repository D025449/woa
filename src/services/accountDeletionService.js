import pool from "./database.js";

const DELETION_GRACE_DAYS = 28;
const DEFAULT_BATCH_SIZE = 25;

function normalizeStatusRow(row) {
  return {
    accountStatus: row?.account_status || "active",
    deletionRequestedAt: row?.deletion_requested_at || null,
    deletionScheduledFor: row?.deletion_scheduled_for || null,
    deletedAt: row?.deleted_at || null,
    canCancel: row?.account_status === "pending_deletion"
  };
}

export default class AccountDeletionService {
  static getGraceDays() {
    return DELETION_GRACE_DAYS;
  }

  static async getDeletionStatus(userId) {
    const result = await pool.query(
      `
        SELECT
          account_status,
          deletion_requested_at,
          deletion_scheduled_for,
          deleted_at
        FROM users
        WHERE id = $1
        LIMIT 1
      `,
      [userId]
    );

    if (result.rowCount === 0) {
      const error = new Error("User not found");
      error.statusCode = 404;
      throw error;
    }

    return normalizeStatusRow(result.rows[0]);
  }

  static async requestDeletion(userId) {
    const result = await pool.query(
      `
        UPDATE users
        SET
          account_status = 'pending_deletion',
          deletion_requested_at = COALESCE(deletion_requested_at, NOW()),
          deletion_scheduled_for = COALESCE(
            deletion_scheduled_for,
            NOW() + ($2::text || ' days')::interval
          ),
          deleted_at = NULL
        WHERE id = $1
        RETURNING
          account_status,
          deletion_requested_at,
          deletion_scheduled_for,
          deleted_at
      `,
      [userId, DELETION_GRACE_DAYS]
    );

    if (result.rowCount === 0) {
      const error = new Error("User not found");
      error.statusCode = 404;
      throw error;
    }

    return normalizeStatusRow(result.rows[0]);
  }

  static async cancelDeletion(userId) {
    const result = await pool.query(
      `
        UPDATE users
        SET
          account_status = 'active',
          deletion_requested_at = NULL,
          deletion_scheduled_for = NULL,
          deleted_at = NULL
        WHERE id = $1
          AND account_status = 'pending_deletion'
        RETURNING
          account_status,
          deletion_requested_at,
          deletion_scheduled_for,
          deleted_at
      `,
      [userId]
    );

    if (result.rowCount === 0) {
      const status = await this.getDeletionStatus(userId);
      if (status.accountStatus !== "pending_deletion") {
        const error = new Error("Account deletion is not pending");
        error.statusCode = 400;
        throw error;
      }
    }

    return normalizeStatusRow(result.rows[0]);
  }

  static async executeDeletion(userId, db = pool) {
    const client = db === pool ? await pool.connect() : db;
    const shouldRelease = db === pool;

    try {
      await client.query("BEGIN");

      const lockedUser = await client.query(
        `
          SELECT id
          FROM users
          WHERE id = $1
            AND account_status = 'pending_deletion'
            AND deletion_scheduled_for <= NOW()
          FOR UPDATE
        `,
        [userId]
      );

      if (lockedUser.rowCount === 0) {
        await client.query("ROLLBACK");
        return { deleted: false, userId };
      }

      await client.query(`DELETE FROM group_invite_sender_dismissals WHERE user_id = $1`, [userId]);
      await client.query(`DELETE FROM group_feed_event_dismissals WHERE user_id = $1`, [userId]);
      await client.query(`DELETE FROM group_feed_events WHERE actor_user_id = $1`, [userId]);
      await client.query(`DELETE FROM group_invites WHERE invited_user_id = $1 OR invited_by_user_id = $1`, [userId]);
      await client.query(`DELETE FROM group_members WHERE user_id = $1`, [userId]);
      await client.query(`DELETE FROM groups WHERE owner_user_id = $1`, [userId]);

      await client.query(`DELETE FROM workout_group_shares WHERE shared_by_user_id = $1`, [userId]);
      await client.query(`DELETE FROM gps_segment_group_shares WHERE shared_by_user_id = $1`, [userId]);

      await client.query(`DELETE FROM feature_usage_events WHERE user_id = $1`, [userId]);
      await client.query(`DELETE FROM user_memberships WHERE user_id = $1`, [userId]);
      await client.query(`DELETE FROM payment_orders WHERE user_id = $1`, [userId]);
      await client.query(`DELETE FROM import_jobs WHERE uid = $1`, [userId]);
      await client.query(`DELETE FROM training_plans WHERE user_id = $1`, [userId]);
      await client.query(`DELETE FROM workouts WHERE uid = $1`, [userId]);
      await client.query(`DELETE FROM gps_segments WHERE uid = $1`, [userId]);
      await client.query(`DELETE FROM user_profiles WHERE user_id = $1`, [userId]);

      const result = await client.query(
        `
          UPDATE users
          SET
            account_status = 'deleted',
            deletion_requested_at = NULL,
            deletion_scheduled_for = NULL,
            deleted_at = NOW(),
            email = 'deleted+' || id::text || '@example.invalid',
            email_verified = FALSE,
            display_name = 'Deleted user'
          WHERE id = $1
          RETURNING
            account_status,
            deletion_requested_at,
            deletion_scheduled_for,
            deleted_at
        `,
        [userId]
      );

      await client.query("COMMIT");
      return {
        deleted: true,
        userId,
        status: normalizeStatusRow(result.rows[0])
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      if (shouldRelease) {
        client.release();
      }
    }
  }

  static async runDueDeletionBatch(limit = DEFAULT_BATCH_SIZE) {
    const client = await pool.connect();
    try {
      const dueUsers = await client.query(
        `
          SELECT id
          FROM users
          WHERE account_status = 'pending_deletion'
            AND deletion_scheduled_for <= NOW()
          ORDER BY deletion_scheduled_for ASC, id ASC
          LIMIT $1
        `,
        [limit]
      );

      const results = [];
      for (const row of dueUsers.rows) {
        results.push(await this.executeDeletion(row.id));
      }

      return {
        scanned: dueUsers.rowCount,
        deleted: results.filter((item) => item.deleted).length,
        results
      };
    } finally {
      client.release();
    }
  }

  static isPendingDeletion(user) {
    return user?.account_status === "pending_deletion" || user?.accountStatus === "pending_deletion";
  }
}
