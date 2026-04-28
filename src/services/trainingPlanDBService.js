import pool from "./database.js";

function fail(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

function toPlanName(summary = {}) {
  const goal = String(summary.goal || "Training Plan").trim();
  const created = new Date().toISOString().slice(0, 10);
  return `${goal} · ${created}`;
}

export default class TrainingPlanDBService {
  static async listPlans(userId, limit = 12) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 12, 50));
    const result = await pool.query(`
      SELECT
        id,
        plan_name,
        primary_goal,
        power_focus,
        athlete_data_mode,
        planning_style,
        plan_horizon_weeks,
        weekly_hours,
        created_at,
        summary_payload
      FROM training_plans
      WHERE user_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2
    `, [userId, safeLimit]);

    return result.rows.map((row) => ({
      id: Number(row.id),
      name: row.plan_name,
      primaryGoal: row.primary_goal,
      powerFocus: row.power_focus,
      athleteDataMode: row.athlete_data_mode,
      planningStyle: row.planning_style,
      planHorizonWeeks: Number(row.plan_horizon_weeks),
      weeklyHours: row.weekly_hours == null ? null : Number(row.weekly_hours),
      createdAt: row.created_at,
      summary: row.summary_payload || {}
    }));
  }

  static async savePlan(userId, inputPayload = {}, generatedPlan = {}) {
    const summary = generatedPlan.summary || {};
    const weeks = Array.isArray(generatedPlan.weeks) ? generatedPlan.weeks : [];

    if (weeks.length === 0) {
      fail("Cannot save an empty training plan");
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const planResult = await client.query(`
        INSERT INTO training_plans (
          user_id,
          plan_name,
          primary_goal,
          power_focus,
          athlete_data_mode,
          planning_style,
          plan_horizon_weeks,
          weekly_hours,
          entered_weekly_hours,
          plan_start_date,
          event_date,
          event_distance_km,
          event_elevation_m,
          event_duration_h,
          terrain_profile,
          available_days,
          notes,
          input_payload,
          context_snapshot,
          planning_signals,
          summary_payload
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16::jsonb, $17, $18::jsonb, $19::jsonb, $20::jsonb, $21::jsonb
        )
        RETURNING id, created_at
      `, [
        userId,
        toPlanName(summary),
        summary.primaryGoal || "event",
        summary.powerFocus || null,
        summary.athleteDataMode || "current",
        summary.planningStyle || "balanced",
        Number(summary.planHorizonWeeks || weeks.length || 4),
        summary.weeklyHours ?? null,
        summary.enteredWeeklyHours ?? null,
        summary.planStartDate || null,
        summary.eventDate || null,
        summary.eventDistanceKm ?? null,
        summary.eventElevationM ?? null,
        summary.eventDurationH ?? null,
        summary.terrainProfile || null,
        JSON.stringify(summary.availableDays || []),
        summary.notes || null,
        JSON.stringify(inputPayload || {}),
        JSON.stringify(summary.userContext || null),
        JSON.stringify(summary.planningSignals || null),
        JSON.stringify(summary || {})
      ]);

      const planRow = planResult.rows[0];

      for (const week of weeks) {
        const weekResult = await client.query(`
          INSERT INTO training_plan_weeks (
            training_plan_id,
            week_number,
            theme,
            target_hours
          )
          VALUES ($1, $2, $3, $4)
          RETURNING id
        `, [
          planRow.id,
          Number(week.weekNumber || 0),
          String(week.theme || "Training Week"),
          Number(week.targetHours || 0)
        ]);

        const weekId = weekResult.rows[0].id;
        const sessions = Array.isArray(week.sessions) ? week.sessions : [];

        for (const session of sessions) {
          await client.query(`
            INSERT INTO training_plan_sessions (
              training_plan_week_id,
              day_code,
              session_type,
              title,
              duration_hours,
              notes,
              objective,
              intensity,
              zone_label,
              energy_system
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          `, [
            weekId,
            String(session.day || ""),
            String(session.type || "easy"),
            String(session.title || "Session"),
            Number(session.durationHours || 0),
            session.notes || null,
            session.semantics?.objective || null,
            session.semantics?.intensity || null,
            session.semantics?.zone || null,
            session.semantics?.energySystem || null
          ]);
        }
      }

      await client.query("COMMIT");
      return this.getPlanById(userId, Number(planRow.id));
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  static async getLatestPlan(userId) {
    const result = await pool.query(`
      SELECT id
      FROM training_plans
      WHERE user_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `, [userId]);

    if (result.rowCount === 0) {
      return null;
    }

    return this.getPlanById(userId, Number(result.rows[0].id));
  }

  static async getPlanById(userId, planId) {
    const planResult = await pool.query(`
      SELECT
        id,
        plan_name,
        primary_goal,
        power_focus,
        athlete_data_mode,
        planning_style,
        plan_horizon_weeks,
        weekly_hours,
        entered_weekly_hours,
        plan_start_date,
        event_date,
        event_distance_km,
        event_elevation_m,
        event_duration_h,
        terrain_profile,
        available_days,
        notes,
        input_payload,
        context_snapshot,
        planning_signals,
        summary_payload,
        created_at,
        updated_at
      FROM training_plans
      WHERE id = $1
        AND user_id = $2
      LIMIT 1
    `, [planId, userId]);

    if (planResult.rowCount === 0) {
      fail("Training plan not found", 404);
    }

    const plan = planResult.rows[0];
    const weekRows = await pool.query(`
      SELECT
        w.id,
        w.week_number,
        w.theme,
        w.target_hours,
        wr.completion_rate,
        wr.volume_compliance,
        wr.intensity_compliance,
        wr.objective_compliance,
        wr.completed_count,
        wr.mostly_completed_count,
        wr.substituted_count,
        wr.missed_count,
        wr.extra_unplanned_count,
        wr.review_status,
        wr.review_summary,
        COALESCE((
          SELECT json_agg(
            json_build_object(
              'id', s.id,
              'day', s.day_code,
              'type', s.session_type,
              'title', s.title,
              'durationHours', s.duration_hours,
              'notes', s.notes,
              'semantics', json_build_object(
                'objective', s.objective,
                'intensity', s.intensity,
                'zone', s.zone_label,
                'energySystem', s.energy_system
              ),
              'match', (
                SELECT json_build_object(
                  'id', m.id,
                  'status', m.match_status,
                  'score', m.match_score,
                  'durationCompliance', m.duration_compliance,
                  'intensityCompliance', m.intensity_compliance,
                  'objectiveCompliance', m.objective_compliance,
                  'reason', m.match_reason,
                  'workoutId', m.workout_id
                )
                FROM training_plan_session_matches m
                WHERE m.training_plan_session_id = s.id
                LIMIT 1
              )
            )
            ORDER BY
              CASE s.day_code
                WHEN 'mon' THEN 1
                WHEN 'tue' THEN 2
                WHEN 'wed' THEN 3
                WHEN 'thu' THEN 4
                WHEN 'fri' THEN 5
                WHEN 'sat' THEN 6
                WHEN 'sun' THEN 7
                ELSE 99
              END,
              s.id ASC
          )
          FROM training_plan_sessions s
          WHERE s.training_plan_week_id = w.id
        ), '[]'::json) AS sessions
      FROM training_plan_weeks w
      LEFT JOIN training_plan_week_reviews wr
        ON wr.training_plan_week_id = w.id
      WHERE w.training_plan_id = $1
      ORDER BY w.week_number ASC
    `, [planId]);

    return {
      id: Number(plan.id),
      name: plan.plan_name,
      createdAt: plan.created_at,
      updatedAt: plan.updated_at,
      input: plan.input_payload || {},
      summary: {
        ...(plan.summary_payload || {}),
        planStartDate: plan.plan_start_date || plan.summary_payload?.planStartDate || null
      },
      weeks: weekRows.rows.map((week) => ({
        id: Number(week.id),
        weekNumber: Number(week.week_number),
        theme: week.theme,
        targetHours: Number(week.target_hours),
        review: week.review_status
          ? {
              completionRate: week.completion_rate == null ? null : Number(week.completion_rate),
              volumeCompliance: week.volume_compliance == null ? null : Number(week.volume_compliance),
              intensityCompliance: week.intensity_compliance == null ? null : Number(week.intensity_compliance),
              objectiveCompliance: week.objective_compliance == null ? null : Number(week.objective_compliance),
              completedCount: Number(week.completed_count || 0),
              mostlyCompletedCount: Number(week.mostly_completed_count || 0),
              substitutedCount: Number(week.substituted_count || 0),
              missedCount: Number(week.missed_count || 0),
              extraUnplannedCount: Number(week.extra_unplanned_count || 0),
              status: week.review_status,
              summary: week.review_summary || ""
            }
          : null,
        sessions: Array.isArray(week.sessions) ? week.sessions : []
      }))
    };
  }

  static async updateWeek(userId, planId, weekNumber, payload = {}) {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const weekResult = await client.query(`
        SELECT
          w.id,
          w.training_plan_id
        FROM training_plan_weeks w
        INNER JOIN training_plans p
          ON p.id = w.training_plan_id
        WHERE p.user_id = $1
          AND p.id = $2
          AND w.week_number = $3
        LIMIT 1
      `, [userId, planId, weekNumber]);

      if (weekResult.rowCount === 0) {
        fail("Training plan week not found", 404);
      }

      const weekId = Number(weekResult.rows[0].id);
      const theme = String(payload.theme || "Training Week").trim() || "Training Week";
      const targetHours = Number(payload.targetHours);
      const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];

      if (!Number.isFinite(targetHours) || targetHours <= 0) {
        fail("Target hours must be a positive number");
      }

      await client.query(`
        UPDATE training_plan_weeks
        SET
          theme = $2,
          target_hours = $3
        WHERE id = $1
      `, [weekId, theme, targetHours]);

      const existingSessionResult = await client.query(`
        SELECT id
        FROM training_plan_sessions
        WHERE training_plan_week_id = $1
      `, [weekId]);
      const existingSessionIds = new Set(existingSessionResult.rows.map((row) => Number(row.id)));
      const keptSessionIds = new Set();

      for (const session of sessions) {
        const durationHours = Number(session.durationHours);

        if (!Number.isFinite(durationHours) || durationHours <= 0) {
          fail("Session duration must be a positive number");
        }
        const normalizedDay = String(session.day || "").trim().toLowerCase();
        const normalizedType = String(session.type || "easy").trim().toLowerCase();
        const title = String(session.title || "Session").trim() || "Session";
        const notes = session.notes ? String(session.notes) : null;
        const objective = session.semantics?.objective ? String(session.semantics.objective) : null;
        const intensity = session.semantics?.intensity ? String(session.semantics.intensity) : null;
        const zone = session.semantics?.zone ? String(session.semantics.zone) : null;
        const system = session.semantics?.energySystem ? String(session.semantics.energySystem) : null;
        const sessionId = Number(session.id);

        if (Number.isFinite(sessionId) && sessionId > 0 && existingSessionIds.has(sessionId)) {
          keptSessionIds.add(sessionId);
          await client.query(`
            UPDATE training_plan_sessions
            SET
              day_code = $2,
              session_type = $3,
              title = $4,
              duration_hours = $5,
              notes = $6,
              objective = $7,
              intensity = $8,
              zone_label = $9,
              energy_system = $10
            WHERE id = $1
              AND training_plan_week_id = $11
          `, [
            sessionId,
            normalizedDay,
            normalizedType,
            title,
            durationHours,
            notes,
            objective,
            intensity,
            zone,
            system,
            weekId
          ]);
          continue;
        }

        const insertResult = await client.query(`
          INSERT INTO training_plan_sessions (
            training_plan_week_id,
            day_code,
            session_type,
            title,
            duration_hours,
            notes,
            objective,
            intensity,
            zone_label,
            energy_system
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          RETURNING id
        `, [
          weekId,
          normalizedDay,
          normalizedType,
          title,
          durationHours,
          notes,
          objective,
          intensity,
          zone,
          system
        ]);
        keptSessionIds.add(Number(insertResult.rows[0].id));
      }

      const sessionIdsToDelete = [...existingSessionIds].filter((id) => !keptSessionIds.has(id));
      if (sessionIdsToDelete.length > 0) {
        await client.query(`
          DELETE FROM training_plan_sessions
          WHERE training_plan_week_id = $1
            AND id = ANY($2::bigint[])
        `, [weekId, sessionIdsToDelete]);
      }

      await client.query(`
        UPDATE training_plans
        SET updated_at = NOW()
        WHERE id = $1
      `, [planId]);

      await client.query("COMMIT");
      return this.getPlanById(userId, planId);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  static async replaceWeekWithGenerated(userId, planId, weekNumber, generatedWeek = {}) {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const weekResult = await client.query(`
        SELECT
          w.id
        FROM training_plan_weeks w
        INNER JOIN training_plans p
          ON p.id = w.training_plan_id
        WHERE p.user_id = $1
          AND p.id = $2
          AND w.week_number = $3
        LIMIT 1
      `, [userId, planId, weekNumber]);

      if (weekResult.rowCount === 0) {
        fail("Training plan week not found", 404);
      }

      const weekId = Number(weekResult.rows[0].id);
      const sessions = Array.isArray(generatedWeek.sessions) ? generatedWeek.sessions : [];

      await client.query(`
        UPDATE training_plan_weeks
        SET
          theme = $2,
          target_hours = $3
        WHERE id = $1
      `, [
        weekId,
        String(generatedWeek.theme || "Training Week"),
        Number(generatedWeek.targetHours || 0)
      ]);

      await client.query(`
        DELETE FROM training_plan_sessions
        WHERE training_plan_week_id = $1
      `, [weekId]);

      for (const session of sessions) {
        await client.query(`
          INSERT INTO training_plan_sessions (
            training_plan_week_id,
            day_code,
            session_type,
            title,
            duration_hours,
            notes,
            objective,
            intensity,
            zone_label,
            energy_system
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `, [
          weekId,
          String(session.day || ""),
          String(session.type || "easy"),
          String(session.title || "Session"),
          Number(session.durationHours || 0),
          session.notes || null,
          session.semantics?.objective || null,
          session.semantics?.intensity || null,
          session.semantics?.zone || null,
          session.semantics?.energySystem || null
        ]);
      }

      await client.query(`
        UPDATE training_plans
        SET updated_at = NOW()
        WHERE id = $1
      `, [planId]);

      await client.query("COMMIT");
      return this.getPlanById(userId, planId);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  static async updatePlanName(userId, planId, planName) {
    const normalizedName = String(planName || "").trim();
    if (!normalizedName) {
      fail("Plan name is required");
    }

    const result = await pool.query(`
      UPDATE training_plans
      SET
        plan_name = $3,
        updated_at = NOW()
      WHERE id = $1
        AND user_id = $2
      RETURNING id
    `, [planId, userId, normalizedName]);

    if (result.rowCount === 0) {
      fail("Training plan not found", 404);
    }

    return this.getPlanById(userId, planId);
  }

  static async replaceReviewData(userId, planId, reviewData = { matches: [], reviews: [] }) {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const ownedPlan = await client.query(`
        SELECT id
        FROM training_plans
        WHERE id = $1
          AND user_id = $2
        LIMIT 1
      `, [planId, userId]);

      if (ownedPlan.rowCount === 0) {
        fail("Training plan not found", 404);
      }

      await client.query(`
        DELETE FROM training_plan_session_matches
        WHERE training_plan_id = $1
      `, [planId]);

      await client.query(`
        DELETE FROM training_plan_week_reviews
        WHERE training_plan_id = $1
      `, [planId]);

      for (const match of reviewData.matches || []) {
        await client.query(`
          INSERT INTO training_plan_session_matches (
            training_plan_id,
            training_plan_week_id,
            training_plan_session_id,
            workout_id,
            match_status,
            match_score,
            duration_compliance,
            intensity_compliance,
            objective_compliance,
            matched_by,
            match_reason
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `, [
          planId,
          match.trainingPlanWeekId,
          match.trainingPlanSessionId,
          match.workoutId,
          match.matchStatus,
          match.matchScore,
          match.durationCompliance,
          match.intensityCompliance,
          match.objectiveCompliance,
          match.matchedBy || "rule_engine",
          match.matchReason || null
        ]);
      }

      for (const review of reviewData.reviews || []) {
        await client.query(`
          INSERT INTO training_plan_week_reviews (
            training_plan_id,
            training_plan_week_id,
            completion_rate,
            volume_compliance,
            intensity_compliance,
            objective_compliance,
            completed_count,
            mostly_completed_count,
            substituted_count,
            missed_count,
            extra_unplanned_count,
            review_status,
            review_summary
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        `, [
          planId,
          review.trainingPlanWeekId,
          review.completionRate,
          review.volumeCompliance,
          review.intensityCompliance,
          review.objectiveCompliance,
          review.completed_count,
          review.mostly_completed_count,
          review.substituted_count,
          review.missed_count,
          review.extra_unplanned_count,
          review.reviewStatus,
          review.reviewSummary || null
        ]);
      }

      await client.query("COMMIT");
      return this.getPlanById(userId, planId);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
