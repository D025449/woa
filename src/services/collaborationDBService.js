import pool from "./database.js";

function fail(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  throw err;
}

export default class CollaborationDBService {

  static async listGroupsForUser(userId) {
    const result = await pool.query(`
      SELECT
        g.id,
        g.name,
        g.description,
        g.visibility,
        g.owner_user_id,
        g.created_at,
        g.updated_at,
        gm.role,
        gm.joined_at,
        (
          SELECT COUNT(*)
          FROM group_members gm_count
          WHERE gm_count.group_id = g.id
        )::int AS member_count,
        COALESCE((
          SELECT json_agg(member_row ORDER BY member_row.sort_name)
          FROM (
            SELECT
              gm_members.user_id,
              gm_members.role,
              COALESCE(u.display_name, u.email, 'User') AS label,
              lower(COALESCE(u.display_name, u.email, 'User')) AS sort_name
            FROM group_members gm_members
            INNER JOIN users u
              ON u.id = gm_members.user_id
            WHERE gm_members.group_id = g.id
          ) AS member_row
        ), '[]'::json) AS members
      FROM groups g
      INNER JOIN group_members gm
        ON gm.group_id = g.id
      WHERE gm.user_id = $1
      ORDER BY lower(g.name) ASC, g.id ASC
    `, [userId]);

    return result.rows;
  }

  static async createGroup(ownerUserId, payload = {}) {
    const name = payload.name?.trim();
    const description = payload.description?.trim() || null;
    const visibility = payload.visibility || "private";

    if (!name) {
      fail("Group name is required");
    }

    if (!["private", "discoverable"].includes(visibility)) {
      fail("Invalid visibility");
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const groupResult = await client.query(`
        INSERT INTO groups (name, description, owner_user_id, visibility)
        VALUES ($1, $2, $3, $4)
        RETURNING *
      `, [name, description, ownerUserId, visibility]);

      const group = groupResult.rows[0];

      await client.query(`
        INSERT INTO group_members (group_id, user_id, role, joined_at)
        VALUES ($1, $2, 'owner', NOW())
      `, [group.id, ownerUserId]);

      await client.query("COMMIT");

      return group;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  static async updateGroup(ownerUserId, groupId, payload = {}) {
    const name = payload.name?.trim();
    const description = payload.description?.trim() || null;

    if (!name) {
      fail("Group name is required");
    }

    const groupResult = await pool.query(`
      SELECT
        id,
        owner_user_id
      FROM groups
      WHERE id = $1
      LIMIT 1
    `, [groupId]);

    if (groupResult.rowCount === 0) {
      fail("Group not found", 404);
    }

    const group = groupResult.rows[0];

    if (Number(group.owner_user_id) !== Number(ownerUserId)) {
      fail("Nur der Owner kann die Gruppe bearbeiten", 403);
    }

    const updateResult = await pool.query(`
      UPDATE groups
      SET
        name = $2,
        description = $3,
        updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `, [groupId, name, description]);

    return updateResult.rows[0];
  }

  static async leaveGroup(userId, groupId) {
    const membershipResult = await pool.query(`
      SELECT
        gm.group_id,
        gm.user_id,
        gm.role,
        g.name
      FROM group_members gm
      INNER JOIN groups g
        ON g.id = gm.group_id
      WHERE gm.group_id = $1
        AND gm.user_id = $2
      LIMIT 1
    `, [groupId, userId]);

    if (membershipResult.rowCount === 0) {
      fail("Group membership not found", 404);
    }

    const membership = membershipResult.rows[0];

    if (membership.role === "owner") {
      fail("Owner kann die Gruppe aktuell nicht direkt verlassen", 409);
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      await client.query(`
        DELETE FROM workout_group_shares
        WHERE group_id = $1
          AND shared_by_user_id = $2
      `, [groupId, userId]);

      await client.query(`
        DELETE FROM gps_segment_group_shares
        WHERE group_id = $1
          AND shared_by_user_id = $2
      `, [groupId, userId]);

      await client.query(`
        DELETE FROM gps_segment_best_efforts b
        USING workouts w, gps_segments s
        WHERE b.wid = w.id
          AND b.sid = s.id
          AND (
            (w.uid = $1 AND s.uid <> $1)
            OR
            (s.uid = $1 AND w.uid <> $1)
          )
          AND NOT EXISTS (
            SELECT 1
            FROM workout_group_shares wgs
            INNER JOIN gps_segment_group_shares sgs
              ON sgs.group_id = wgs.group_id
            WHERE wgs.workout_id = w.id
              AND sgs.segment_id = s.id
          )
      `, [userId]);

      await client.query(`
        DELETE FROM group_members
        WHERE group_id = $1
          AND user_id = $2
      `, [groupId, userId]);

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    return {
      ok: true,
      groupId: Number(groupId),
      groupName: membership.name
    };
  }

  static async deleteGroup(ownerUserId, groupId) {
    const groupResult = await pool.query(`
      SELECT
        id,
        name,
        owner_user_id
      FROM groups
      WHERE id = $1
      LIMIT 1
    `, [groupId]);

    if (groupResult.rowCount === 0) {
      fail("Group not found", 404);
    }

    const group = groupResult.rows[0];

    if (Number(group.owner_user_id) !== Number(ownerUserId)) {
      fail("Nur der Owner kann die Gruppe loeschen", 403);
    }

    await pool.query(`
      DELETE FROM groups
      WHERE id = $1
    `, [groupId]);

    return {
      ok: true,
      groupId: Number(groupId),
      groupName: group.name
    };
  }

  static async getGroupDetailForUser(userId, groupId) {
    const groupResult = await pool.query(`
      SELECT
        g.id,
        g.name,
        g.description,
        g.visibility,
        g.owner_user_id,
        g.created_at,
        g.updated_at,
        gm.role,
        gm.joined_at
      FROM groups g
      INNER JOIN group_members gm
        ON gm.group_id = g.id
      WHERE g.id = $1
        AND gm.user_id = $2
      LIMIT 1
    `, [groupId, userId]);

    if (groupResult.rowCount === 0) {
      fail("Group not found", 404);
    }

    const group = groupResult.rows[0];

    const membersResult = await pool.query(`
      SELECT
        gm.user_id,
        gm.role,
        gm.joined_at,
        u.email,
        u.display_name
      FROM group_members gm
      INNER JOIN users u
        ON u.id = gm.user_id
      WHERE gm.group_id = $1
      ORDER BY
        CASE gm.role
          WHEN 'owner' THEN 0
          WHEN 'admin' THEN 1
          ELSE 2
        END,
        lower(COALESCE(u.display_name, u.email)) ASC
    `, [groupId]);

    let invites = [];

    if (["owner", "admin"].includes(group.role)) {
      const invitesResult = await pool.query(`
        SELECT
          gi.id,
          gi.status,
          gi.message,
          gi.expires_at,
          gi.created_at,
          gi.responded_at,
          gi.invited_user_id,
          invited.email AS invited_email,
          invited.display_name AS invited_display_name,
          gi.invited_by_user_id,
          inviter.email AS invited_by_email,
          inviter.display_name AS invited_by_display_name
        FROM group_invites gi
        INNER JOIN users invited
          ON invited.id = gi.invited_user_id
        INNER JOIN users inviter
          ON inviter.id = gi.invited_by_user_id
        WHERE gi.group_id = $1
        ORDER BY gi.created_at DESC, gi.id DESC
      `, [groupId]);

      invites = invitesResult.rows;
    }

    return {
      group,
      members: membersResult.rows,
      invites
    };
  }

  static async listInvitesForUser(userId, options = {}) {
    const status = options.status || "pending";
    const values = [userId];
    let whereStatus = "";

    if (status && status !== "all") {
      values.push(status);
      whereStatus = `AND gi.status = $2`;
    }

    const result = await pool.query(`
      SELECT
        gi.id,
        gi.status,
        gi.message,
        gi.expires_at,
        gi.created_at,
        gi.responded_at,
        gi.group_id,
        g.name AS group_name,
        g.description AS group_description,
        gi.invited_by_user_id,
        inviter.email AS invited_by_email,
        inviter.display_name AS invited_by_display_name
      FROM group_invites gi
      INNER JOIN groups g
        ON g.id = gi.group_id
      INNER JOIN users inviter
        ON inviter.id = gi.invited_by_user_id
      WHERE gi.invited_user_id = $1
        ${whereStatus}
      ORDER BY gi.created_at DESC, gi.id DESC
    `, values);

    return result.rows;
  }

  static async listSentInvitesForUser(userId, options = {}) {
    const status = options.status || "all";
    const values = [userId];
    let whereStatus = `
      AND (
        gi.status = 'pending'
        OR (
          gi.status IN ('accepted', 'declined', 'revoked')
          AND gi.responded_at >= NOW() - INTERVAL '7 days'
        )
      )
    `;

    if (status && status !== "all") {
      values.push(status);
      whereStatus += ` AND gi.status = $2`;
    }

    const result = await pool.query(`
      SELECT
        gi.id,
        gi.status,
        gi.message,
        gi.expires_at,
        gi.created_at,
        gi.responded_at,
        gi.group_id,
        g.name AS group_name,
        g.description AS group_description,
        gi.invited_user_id,
        invited.email AS invited_email,
        invited.display_name AS invited_display_name
      FROM group_invites gi
      INNER JOIN groups g
        ON g.id = gi.group_id
      INNER JOIN users invited
        ON invited.id = gi.invited_user_id
      LEFT JOIN group_invite_sender_dismissals gisd
        ON gisd.invite_id = gi.id
       AND gisd.user_id = $1
      WHERE gi.invited_by_user_id = $1
        AND gisd.invite_id IS NULL
        ${whereStatus}
      ORDER BY gi.created_at DESC, gi.id DESC
    `, values);

    return result.rows;
  }

  static async listFeedForUser(userId, options = {}) {
    const limit = Math.max(1, Math.min(Number(options.limit) || 25, 100));
    const offset = Math.max(0, Number(options.offset) || 0);
    const range = String(options.range || "7d").toLowerCase();
    const actorScope = String(options.actorScope || "all").toLowerCase();
    let rangeFilter = "";
    let actorFilter = "";

    if (range === "1d") {
      rangeFilter = `AND gfe.created_at >= NOW() - INTERVAL '1 day'`;
    } else if (range === "7d") {
      rangeFilter = `AND gfe.created_at >= NOW() - INTERVAL '7 days'`;
    }

    if (actorScope === "others") {
      actorFilter = `AND gfe.actor_user_id <> $1`;
    }

    const result = await pool.query(`
      SELECT
        gfe.id,
        gfe.actor_user_id,
        actor.email AS actor_email,
        actor.display_name AS actor_display_name,
        gfe.event_type,
        gfe.entity_type,
        gfe.entity_id,
        gfe.payload_json AS payload,
        gfe.created_at,
        COUNT(DISTINCT gfeg.group_id)::int AS group_count
      FROM group_feed_events gfe
      INNER JOIN group_feed_event_groups gfeg
        ON gfeg.feed_event_id = gfe.id
      INNER JOIN group_members gm
        ON gm.group_id = gfeg.group_id
      INNER JOIN users actor
        ON actor.id = gfe.actor_user_id
      LEFT JOIN group_feed_event_dismissals gfed
        ON gfed.feed_event_id = gfe.id
       AND gfed.user_id = $1
      WHERE gm.user_id = $1
        AND gfed.feed_event_id IS NULL
        ${rangeFilter}
        ${actorFilter}
      GROUP BY
        gfe.id,
        gfe.actor_user_id,
        actor.email,
        actor.display_name,
        gfe.event_type,
        gfe.entity_type,
        gfe.entity_id,
        gfe.payload_json,
        gfe.created_at
      ORDER BY gfe.created_at DESC, gfe.id DESC
      LIMIT $2
      OFFSET $3
    `, [userId, limit, offset]);

    return result.rows;
  }

  static async dismissFeedEventForUser(userId, feedEventId) {
    const membershipResult = await pool.query(`
      SELECT 1
      FROM group_feed_events gfe
      INNER JOIN group_feed_event_groups gfeg
        ON gfeg.feed_event_id = gfe.id
      INNER JOIN group_members gm
        ON gm.group_id = gfeg.group_id
      WHERE gfe.id = $1
        AND gm.user_id = $2
      LIMIT 1
    `, [feedEventId, userId]);

    if (membershipResult.rowCount === 0) {
      fail("Feed event not found", 404);
    }

    await pool.query(`
      INSERT INTO group_feed_event_dismissals (feed_event_id, user_id)
      VALUES ($1, $2)
      ON CONFLICT (feed_event_id, user_id) DO NOTHING
    `, [feedEventId, userId]);

    return {
      ok: true,
      feedEventId
    };
  }

  static async dismissSentInviteForUser(userId, inviteId) {
    const inviteResult = await pool.query(`
      SELECT
        id,
        status
      FROM group_invites
      WHERE id = $1
        AND invited_by_user_id = $2
      LIMIT 1
    `, [inviteId, userId]);

    if (inviteResult.rowCount === 0) {
      fail("Invite not found", 404);
    }

    const invite = inviteResult.rows[0];
    if (String(invite.status || "").toLowerCase() === "pending") {
      fail("Pending invites koennen nicht ausgeblendet werden", 409);
    }

    await pool.query(`
      INSERT INTO group_invite_sender_dismissals (invite_id, user_id)
      VALUES ($1, $2)
      ON CONFLICT (invite_id, user_id) DO NOTHING
    `, [inviteId, userId]);

    return {
      ok: true,
      inviteId
    };
  }

  static async createWorkoutUploadedFeedEvents({
    groupIds = [],
    actorUserId,
    workoutId,
    payload = {}
  }) {
    const normalizedGroupIds = [...new Set(
      (Array.isArray(groupIds) ? groupIds : [])
        .map((groupId) => Number(groupId))
        .filter((groupId) => Number.isInteger(groupId) && groupId > 0)
    )];

    if (!normalizedGroupIds.length || !actorUserId || !workoutId) {
      return [];
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const eventResult = await client.query(`
        INSERT INTO group_feed_events (
          group_id,
          actor_user_id,
          event_type,
          entity_type,
          entity_id,
          payload_json
        )
        VALUES (
          $1,
          $2,
          'workout_uploaded',
          'workout',
          $3,
          $4::jsonb
        )
        ON CONFLICT (actor_user_id, event_type, entity_type, entity_id)
          WHERE event_type IN ('workout_uploaded', 'segment_published')
            AND entity_id IS NOT NULL
        DO UPDATE SET payload_json = EXCLUDED.payload_json
        RETURNING id
      `, [normalizedGroupIds[0], actorUserId, workoutId, JSON.stringify(payload)]);

      const eventId = eventResult.rows[0]?.id;

      const mappingResult = await client.query(`
        INSERT INTO group_feed_event_groups (feed_event_id, group_id)
        SELECT
          $1,
          unnest($2::bigint[])
        ON CONFLICT (feed_event_id, group_id) DO NOTHING
        RETURNING group_id
      `, [eventId, normalizedGroupIds]);

      await client.query("COMMIT");
      return mappingResult.rows;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  static async listGroupIdsForUser(userId) {
    const result = await pool.query(`
      SELECT group_id
      FROM group_members
      WHERE user_id = $1
      ORDER BY group_id ASC
    `, [userId]);

    return result.rows.map((row) => Number(row.group_id));
  }

  static async createSegmentPublishedFeedEvents({
    groupIds = [],
    actorUserId,
    segmentId,
    payload = {}
  }) {
    const normalizedGroupIds = [...new Set(
      (Array.isArray(groupIds) ? groupIds : [])
        .map((groupId) => Number(groupId))
        .filter((groupId) => Number.isInteger(groupId) && groupId > 0)
    )];

    if (!normalizedGroupIds.length || !actorUserId || !segmentId) {
      return [];
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const eventResult = await client.query(`
        INSERT INTO group_feed_events (
          group_id,
          actor_user_id,
          event_type,
          entity_type,
          entity_id,
          payload_json
        )
        VALUES (
          $1,
          $2,
          'segment_published',
          'segment',
          $3,
          $4::jsonb
        )
        ON CONFLICT (actor_user_id, event_type, entity_type, entity_id)
          WHERE event_type IN ('workout_uploaded', 'segment_published')
            AND entity_id IS NOT NULL
        DO UPDATE SET payload_json = EXCLUDED.payload_json
        RETURNING id
      `, [normalizedGroupIds[0], actorUserId, segmentId, JSON.stringify(payload)]);

      const eventId = eventResult.rows[0]?.id;

      const mappingResult = await client.query(`
        INSERT INTO group_feed_event_groups (feed_event_id, group_id)
        SELECT
          $1,
          unnest($2::bigint[])
        ON CONFLICT (feed_event_id, group_id) DO NOTHING
        RETURNING group_id
      `, [eventId, normalizedGroupIds]);

      await client.query("COMMIT");
      return mappingResult.rows;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  static async createInvite(inviterUserId, groupId, payload = {}) {
    const invitedUserId = payload.invitedUserId ? Number(payload.invitedUserId) : null;
    const invitedEmail = payload.invitedEmail?.trim() || null;
    const message = payload.message?.trim() || null;
    const expiresAt = payload.expiresAt || null;

    if (!invitedUserId && !invitedEmail) {
      fail("invitedUserId or invitedEmail is required");
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const actorResult = await client.query(`
        SELECT role
        FROM group_members
        WHERE group_id = $1
          AND user_id = $2
        LIMIT 1
      `, [groupId, inviterUserId]);

      if (actorResult.rowCount === 0) {
        fail("Group not found", 404);
      }

      const role = actorResult.rows[0].role;
      if (!["owner", "admin"].includes(role)) {
        fail("Only owner or admin can invite members", 403);
      }

      let invitedUser = null;

      if (invitedUserId) {
        const invitedResult = await client.query(`
          SELECT id, email, display_name
          FROM users
          WHERE id = $1
          LIMIT 1
        `, [invitedUserId]);
        invitedUser = invitedResult.rows[0] || null;
      } else if (invitedEmail) {
        const invitedResult = await client.query(`
          SELECT id, email, display_name
          FROM users
          WHERE lower(email) = lower($1)
          LIMIT 1
        `, [invitedEmail]);
        invitedUser = invitedResult.rows[0] || null;
      }

      if (!invitedUser) {
        fail("Invited user not found", 404);
      }

      if (Number(invitedUser.id) === Number(inviterUserId)) {
        fail("You cannot invite yourself");
      }

      const memberResult = await client.query(`
        SELECT 1
        FROM group_members
        WHERE group_id = $1
          AND user_id = $2
        LIMIT 1
      `, [groupId, invitedUser.id]);

      if (memberResult.rowCount > 0) {
        fail("User is already a group member");
      }

      const inviteResult = await client.query(`
        INSERT INTO group_invites (
          group_id,
          invited_user_id,
          invited_by_user_id,
          status,
          message,
          expires_at
        )
        VALUES ($1, $2, $3, 'pending', $4, $5)
        RETURNING *
      `, [groupId, invitedUser.id, inviterUserId, message, expiresAt]);

      await client.query("COMMIT");

      return inviteResult.rows[0];
    } catch (err) {
      await client.query("ROLLBACK");

      if (err.code === "23505") {
        fail("A pending invite already exists for this user", 409);
      }

      throw err;
    } finally {
      client.release();
    }
  }

  static async respondToInvite(userId, inviteId, action) {
    if (!["accept", "decline"].includes(action)) {
      fail("Invalid invite action");
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const inviteResult = await client.query(`
        SELECT *
        FROM group_invites
        WHERE id = $1
          AND invited_user_id = $2
        LIMIT 1
      `, [inviteId, userId]);

      if (inviteResult.rowCount === 0) {
        fail("Invite not found", 404);
      }

      const invite = inviteResult.rows[0];

      if (invite.status !== "pending") {
        fail("Invite is no longer pending", 409);
      }

      let membership = null;

      if (action === "accept") {
        const memberInsert = await client.query(`
          INSERT INTO group_members (group_id, user_id, role, joined_at)
          VALUES ($1, $2, 'member', NOW())
          ON CONFLICT (group_id, user_id)
          DO UPDATE SET joined_at = COALESCE(group_members.joined_at, NOW())
          RETURNING *
        `, [invite.group_id, userId]);

        membership = memberInsert.rows[0];
      }

      const nextStatus = action === "accept" ? "accepted" : "declined";
      const updatedInvite = await client.query(`
        UPDATE group_invites
        SET
          status = $1,
          responded_at = NOW()
        WHERE id = $2
        RETURNING *
      `, [nextStatus, inviteId]);

      await client.query("COMMIT");

      return {
        invite: updatedInvite.rows[0],
        membership
      };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  static async revokeInvite(userId, inviteId) {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const inviteResult = await client.query(`
        SELECT gi.*, gm.role
        FROM group_invites gi
        INNER JOIN group_members gm
          ON gm.group_id = gi.group_id
         AND gm.user_id = $2
        WHERE gi.id = $1
        LIMIT 1
      `, [inviteId, userId]);

      if (inviteResult.rowCount === 0) {
        fail("Invite not found", 404);
      }

      const invite = inviteResult.rows[0];

      if (!["owner", "admin"].includes(invite.role)) {
        fail("Only owner or admin can revoke invites", 403);
      }

      if (invite.status !== "pending") {
        fail("Only pending invites can be revoked", 409);
      }

      const updatedInvite = await client.query(`
        UPDATE group_invites
        SET
          status = 'revoked',
          responded_at = NOW()
        WHERE id = $1
        RETURNING *
      `, [inviteId]);

      await client.query("COMMIT");

      return updatedInvite.rows[0];
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}
