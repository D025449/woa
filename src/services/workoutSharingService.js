import pool from "./database.js";

function normalizeGroupIds(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(
    value
      .map((entry) => Number(entry))
      .filter((entry) => Number.isInteger(entry) && entry > 0)
  )];
}

export default class WorkoutSharingService {
  static async ensureGroupMember(userId, groupId) {
    const normalizedGroupId = Number(groupId);
    if (!Number.isInteger(normalizedGroupId) || normalizedGroupId <= 0) {
      const error = new Error("Ungueltige Gruppe.");
      error.statusCode = 400;
      throw error;
    }

    const result = await pool.query(`
      SELECT group_id
      FROM group_members
      WHERE user_id = $1
        AND group_id = $2
      LIMIT 1
    `, [userId, normalizedGroupId]);

    if (result.rowCount === 0) {
      const error = new Error("Gruppe fuer diesen User nicht verfuegbar.");
      error.statusCode = 403;
      throw error;
    }

    return normalizedGroupId;
  }


  static async getAccessibleWorkout(userId, workoutId) {
    const result = await pool.query(`
      SELECT
        w.id,
        w.uid,
        owner.display_name AS owner_display_name,
        owner.email AS owner_email,
        (w.uid = $2) AS is_owner
      FROM workouts w
      INNER JOIN users owner
        ON owner.id = w.uid
      WHERE w.id = $1
        AND (
          w.uid = $2
          OR EXISTS (
            SELECT 1
            FROM workout_group_shares wgs
            INNER JOIN group_members gm
              ON gm.group_id = wgs.group_id
            WHERE wgs.workout_id = w.id
              AND gm.user_id = $2
          )
        )
      LIMIT 1
    `, [workoutId, userId]);

    if (result.rowCount === 0) {
      const error = new Error("Workout not found or not accessible");
      error.statusCode = 404;
      throw error;
    }

    return result.rows[0];
  }

  static async resolveShareConfigForUser(userId, payload = {}) {
    const shareMode = String(payload.shareMode || "private").toLowerCase() === "groups"
      ? "groups"
      : "private";

    if (shareMode !== "groups") {
      return {
        shareMode: "private",
        groupIds: []
      };
    }

    const requestedGroupIds = normalizeGroupIds(payload.groupIds);

    if (requestedGroupIds.length === 0) {
      const error = new Error("Bitte mindestens eine Gruppe zum Teilen auswaehlen.");
      error.statusCode = 400;
      throw error;
    }

    const result = await pool.query(`
      SELECT group_id
      FROM group_members
      WHERE user_id = $1
        AND group_id = ANY($2::bigint[])
      ORDER BY group_id ASC
    `, [userId, requestedGroupIds]);

    const allowedGroupIds = result.rows.map((row) => Number(row.group_id));

    if (allowedGroupIds.length !== requestedGroupIds.length) {
      const error = new Error("Mindestens eine ausgewaehlte Gruppe ist fuer diesen User nicht freigegeben.");
      error.statusCode = 403;
      throw error;
    }

    return {
      shareMode: "groups",
      groupIds: allowedGroupIds
    };
  }

  static async createSharesForWorkout({ workoutId, sharedByUserId, groupIds = [] }) {
    const normalizedGroupIds = normalizeGroupIds(groupIds);

    if (!workoutId || normalizedGroupIds.length === 0) {
      return [];
    }

    const result = await pool.query(`
      INSERT INTO workout_group_shares (workout_id, group_id, shared_by_user_id)
      SELECT
        $1,
        gm.group_id,
        $2
      FROM group_members gm
      WHERE gm.user_id = $2
        AND gm.group_id = ANY($3::bigint[])
      ON CONFLICT (workout_id, group_id) DO NOTHING
      RETURNING group_id
    `, [workoutId, sharedByUserId, normalizedGroupIds]);

    return result.rows.map((row) => Number(row.group_id));
  }

  static async getSharingForWorkout(userId, workoutId) {
    const workoutResult = await pool.query(`
      SELECT id
      FROM workouts
      WHERE id = $1
        AND uid = $2
      LIMIT 1
    `, [workoutId, userId]);

    if (workoutResult.rowCount === 0) {
      const error = new Error("Workout not found");
      error.statusCode = 404;
      throw error;
    }

    const sharesResult = await pool.query(`
      SELECT
        wgs.group_id,
        g.name AS group_name
      FROM workout_group_shares wgs
      INNER JOIN groups g
        ON g.id = wgs.group_id
      WHERE wgs.workout_id = $1
      ORDER BY lower(g.name) ASC, wgs.group_id ASC
    `, [workoutId]);

    const groupIds = sharesResult.rows.map((row) => Number(row.group_id));

    return {
      shareMode: groupIds.length > 0 ? "groups" : "private",
      groupIds,
      groups: sharesResult.rows
    };
  }

  static async updateSharingForWorkout(userId, workoutId, payload = {}) {
    const shareConfig = await this.resolveShareConfigForUser(userId, payload);

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const workoutResult = await client.query(`
        SELECT id
        FROM workouts
        WHERE id = $1
          AND uid = $2
        LIMIT 1
      `, [workoutId, userId]);

      if (workoutResult.rowCount === 0) {
        const error = new Error("Workout not found");
        error.statusCode = 404;
        throw error;
      }

      const previousSharesResult = await client.query(`
        SELECT group_id
        FROM workout_group_shares
        WHERE workout_id = $1
      `, [workoutId]);

      const previousGroupIds = previousSharesResult.rows.map((row) => Number(row.group_id));

      await client.query(`
        DELETE FROM workout_group_shares
        WHERE workout_id = $1
      `, [workoutId]);

      if (shareConfig.shareMode === "groups" && shareConfig.groupIds.length > 0) {
        await client.query(`
          INSERT INTO workout_group_shares (workout_id, group_id, shared_by_user_id)
          SELECT
            $1,
            gm.group_id,
            $2
          FROM group_members gm
          WHERE gm.user_id = $2
            AND gm.group_id = ANY($3::bigint[])
          ON CONFLICT (workout_id, group_id) DO NOTHING
        `, [workoutId, userId, shareConfig.groupIds]);
      }

      await client.query("COMMIT");

      const sharing = await this.getSharingForWorkout(userId, workoutId);
      return {
        ...sharing,
        newlyPublishedGroupIds: sharing.groupIds.filter((groupId) => !previousGroupIds.includes(groupId))
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  static async bulkPublishWorkoutsToGroup(userId, groupId, preset = "training-30d") {
    const normalizedGroupId = await this.ensureGroupMember(userId, groupId);

    const presets = {
      "training-30d": {
        label: "Trainings der letzten 30 Tage",
        sql: "w.start_time >= NOW() - INTERVAL '30 days'"
      },
      "training-90d": {
        label: "Trainings der letzten 90 Tage",
        sql: "w.start_time >= NOW() - INTERVAL '90 days'"
      },
      "uploaded-7d": {
        label: "Uploads der letzten 7 Tage",
        sql: "w.uploaded_at >= NOW() - INTERVAL '7 days'"
      },
      "uploaded-90d": {
        label: "Uploads der letzten 90 Tage",
        sql: "w.uploaded_at >= NOW() - INTERVAL '90 days'"
      },
      "all": {
        label: "Alle Workouts",
        sql: "TRUE"
      }
    };

    const selectedPreset = presets[String(preset || "").toLowerCase()] || presets["training-30d"];

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const insertResult = await client.query(`
        WITH candidates AS (
          SELECT
            w.id,
            w.start_time,
            w.total_distance,
            w.total_timer_time
          FROM workouts w
          WHERE w.uid = $1
            AND ${selectedPreset.sql}
            AND NOT EXISTS (
              SELECT 1
              FROM workout_group_shares wgs
              WHERE wgs.workout_id = w.id
                AND wgs.group_id = $2
            )
        )
        INSERT INTO workout_group_shares (workout_id, group_id, shared_by_user_id)
        SELECT
          c.id,
          $2,
          $1
        FROM candidates c
        RETURNING workout_id
      `, [userId, normalizedGroupId]);

      const workoutIds = insertResult.rows.map((row) => Number(row.workout_id));
      let workouts = [];

      if (workoutIds.length > 0) {
        const workoutsResult = await client.query(`
          SELECT
            id,
            start_time,
            total_distance,
            total_timer_time
          FROM workouts
          WHERE id = ANY($1::bigint[])
        `, [workoutIds]);

        workouts = workoutsResult.rows;
      }

      await client.query("COMMIT");

      return {
        groupId: normalizedGroupId,
        preset: String(preset || "").toLowerCase() || "training-30d",
        presetLabel: selectedPreset.label,
        workoutIds,
        workouts,
        publishedCount: workoutIds.length
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

}
