import pool from "./database.js";

function fail(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

function toPlanName(summary = {}) {
  const goalMap = {
    "goalSummary.sprintPower": "Sprint power",
    "goalSummary.oneMinutePower": "1-minute power",
    "goalSummary.fourMinutePower": "4-minute power",
    "goalSummary.eightMinutePower": "8-minute power",
    "goalSummary.ftpPower": "FTP / 60-minute power",
    "goalSummary.powerImprovement": "Power improvement",
    "goalSummary.eventPreparation": "Event preparation"
  };
  const goal = String(goalMap[summary.goal] || summary.goal || "Training Plan").trim();
  const created = new Date().toISOString().slice(0, 10);
  return `${goal} · ${created}`;
}

function toNullableDateString(value) {
  if (!value) {
    return null;
  }

  const normalized = String(value).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : null;
}

function startOfDay(date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function startOfWeekFromAnchor(anchorDate, weekIndex) {
  const anchor = startOfDay(anchorDate);
  const day = anchor.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  anchor.setDate(anchor.getDate() + diffToMonday + (weekIndex * 7));
  return anchor;
}

function addDays(date, days) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function weekdayOffset(dayCode) {
  return { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 }[dayCode] ?? 0;
}

function toIsoDate(date) {
  return startOfDay(date).toISOString().slice(0, 10);
}

function roundToQuarterHour(value) {
  return Math.round(value * 4) / 4;
}

function computePlannedDate(planStartDate, weekNumber, dayCode) {
  if (!planStartDate) {
    return null;
  }

  const base = startOfWeekFromAnchor(new Date(planStartDate), Number(weekNumber) - 1);
  return toIsoDate(addDays(base, weekdayOffset(dayCode)));
}

function withAdjustmentNote(existingNotes, note) {
  const prefix = "[Adjusted] ";
  const normalized = String(existingNotes || "").trim();
  const next = `${prefix}${note}`;
  if (!normalized) {
    return next;
  }
  if (normalized.includes(note)) {
    return normalized;
  }
  return `${next} ${normalized}`;
}

function normalizeSessionForWeek(session, targetWeekNumber, planStartDate) {
  const normalizedDay = String(session.day || "mon").trim().toLowerCase();
  return {
    id: Number(session.id) || null,
    day: normalizedDay,
    plannedDate: computePlannedDate(planStartDate, targetWeekNumber, normalizedDay),
    type: String(session.type || "easy").trim().toLowerCase(),
    title: String(session.title || "Session").trim() || "Session",
    durationHours: Number(session.durationHours || 0),
    notes: session.notes ? String(session.notes) : "",
    semantics: {
      objective: session.semantics?.objective ? String(session.semantics.objective) : "",
      intensity: session.semantics?.intensity ? String(session.semantics.intensity) : "",
      zone: session.semantics?.zone ? String(session.semantics.zone) : "",
      energySystem: session.semantics?.energySystem ? String(session.semantics.energySystem) : ""
    }
  };
}

function buildWeekRecommendations({ review, sessions = [], extraWorkouts = [] }) {
  if (!review) {
    return [];
  }

  const recommendations = [];
  const hardMissed = sessions.some((session) =>
    String(session?.type || "").toLowerCase() === "hard"
      && String(session?.match?.status || "") === "missed"
  );
  const longMissed = sessions.some((session) =>
    String(session?.type || "").toLowerCase() === "long"
      && String(session?.match?.status || "") === "missed"
  );
  const highSubstitutionLoad = Number(review.substitutedCount || 0) >= 2;
  const extraCount = Number(review.extraUnplannedCount || 0);
  const missedCount = Number(review.missedCount || 0);
  const completionRate = Number(review.completionRate || 0);

  if (hardMissed) {
    recommendations.push({
      severity: "medium",
      title: "recommendationTitle.replaceKeyStimulus",
      detail: "recommendationDetail.replaceKeyStimulus"
    });
  }

  if (longMissed) {
    recommendations.push({
      severity: "medium",
      title: "recommendationTitle.protectLongAnchor",
      detail: "recommendationDetail.protectLongAnchor"
    });
  }

  if (missedCount >= 2 || completionRate < 0.45) {
    recommendations.push({
      severity: "high",
      title: "recommendationTitle.reduceNextWeek",
      detail: "recommendationDetail.reduceNextWeek"
    });
  } else if (highSubstitutionLoad) {
    recommendations.push({
      severity: "medium",
      title: "recommendationTitle.simplifyNextBlock",
      detail: "recommendationDetail.simplifyNextBlock"
    });
  } else if (review.status === "on_track" && completionRate >= 0.8) {
    recommendations.push({
      severity: "low",
      title: "recommendationTitle.keepProgressionSteady",
      detail: "recommendationDetail.keepProgressionSteady"
    });
  }

  if (extraCount >= 2 || extraWorkouts.length >= 2) {
    recommendations.push({
      severity: "medium",
      title: "recommendationTitle.manageUnplannedVolume",
      detail: "recommendationDetail.manageUnplannedVolume"
    });
  }

  if (recommendations.length === 0) {
    recommendations.push({
      severity: "low",
      title: "recommendationTitle.stayWithCurrentTemplate",
      detail: "recommendationDetail.stayWithCurrentTemplate"
    });
  }

  return recommendations;
}

function applyAdjustmentToWeek(sourceWeek, targetWeek, planStartDate) {
  const review = sourceWeek?.review;
  if (!review) {
    fail("Week review is required before applying an adjustment");
  }

  const adjustedSessions = (targetWeek.sessions || []).map((session) =>
    normalizeSessionForWeek(session, targetWeek.weekNumber, planStartDate)
  );

  let scalingFactor = 1;
  const hardMissed = (sourceWeek.sessions || []).some((session) =>
    String(session?.type || "").toLowerCase() === "hard"
      && String(session?.match?.status || "") === "missed"
  );
  const longMissed = (sourceWeek.sessions || []).some((session) =>
    String(session?.type || "").toLowerCase() === "long"
      && String(session?.match?.status || "") === "missed"
  );

  if (Number(review.missedCount || 0) >= 2 || Number(review.completionRate || 0) < 0.45) {
    scalingFactor *= 0.88;
  } else if (Number(review.substitutedCount || 0) >= 2) {
    scalingFactor *= 0.94;
  }

  if (Number(review.extraUnplannedCount || 0) >= 2) {
    scalingFactor *= 0.94;
  }

  adjustedSessions.forEach((session) => {
    const minimum = session.type === "long" ? 1.5 : 0.5;
    session.durationHours = roundToQuarterHour(Math.max(minimum, session.durationHours * scalingFactor));
  });

  if (hardMissed) {
    const firstHard = adjustedSessions.find((session) => session.type === "hard");
    if (firstHard) {
      firstHard.day = "tue";
      firstHard.plannedDate = computePlannedDate(planStartDate, targetWeek.weekNumber, firstHard.day);
      firstHard.notes = withAdjustmentNote(firstHard.notes, "sessionNote.adjustedCarryForwardHard");
    }
  }

  if (longMissed) {
    const longSession = adjustedSessions.find((session) => session.type === "long");
    if (longSession) {
      longSession.durationHours = roundToQuarterHour(Math.min(longSession.durationHours + 0.5, longSession.durationHours * 1.25));
      longSession.notes = withAdjustmentNote(longSession.notes, "sessionNote.adjustedReinforceLongAnchor");
    }
  }

  if (Number(review.extraUnplannedCount || 0) >= 2) {
    const easySession = [...adjustedSessions]
      .filter((session) => session.type === "easy")
      .sort((a, b) => b.durationHours - a.durationHours)[0];
    if (easySession) {
      easySession.durationHours = roundToQuarterHour(Math.max(0.5, easySession.durationHours - 0.5));
      easySession.notes = withAdjustmentNote(easySession.notes, "sessionNote.adjustedTrimRecovery");
    }
  }

  if (Number(review.substitutedCount || 0) >= 2) {
    const hardSessions = adjustedSessions.filter((session) => session.type === "hard");
    if (hardSessions.length >= 2) {
      const secondHard = hardSessions[1];
      secondHard.type = "medium";
      secondHard.semantics.intensity = "moderate";
      secondHard.notes = withAdjustmentNote(secondHard.notes, "sessionNote.adjustedSimplifiedAfterSubstitutions");
    }
  }

  const targetHours = roundToQuarterHour(adjustedSessions.reduce((sum, session) => sum + Number(session.durationHours || 0), 0));

  return {
    theme: "weekTheme.adjustedWeek",
    targetHours,
    sessions: adjustedSessions
  };
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
    const planStartDate = toNullableDateString(summary.planStartDate);

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
          $11::date, $12, $13, $14, $15, $16::jsonb, $17, $18::jsonb, $19::jsonb, $20::jsonb, $21::jsonb
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
        planStartDate,
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
              planned_date,
              session_type,
              title,
              duration_hours,
              notes,
              objective,
              intensity,
              zone_label,
              energy_system
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          `, [
            weekId,
            String(session.day || ""),
            toNullableDateString(session.plannedDate),
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
        wc.model_name AS commentary_model_name,
        wc.commentary_payload,
        COALESCE((
          SELECT json_agg(
            json_build_object(
              'id', s.id,
              'day', s.day_code,
              'plannedDate', s.planned_date,
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
        ), '[]'::json) AS sessions,
        COALESCE((
          SELECT json_agg(
            json_build_object(
              'id', m.id,
              'workoutId', m.workout_id,
              'status', m.match_status,
              'score', m.match_score,
              'reason', m.match_reason,
              'startTime', wo.start_time,
              'durationHours', CASE
                WHEN wo.total_timer_time IS NULL THEN NULL
                ELSE wo.total_timer_time / 3600.0
              END,
              'distanceKm', CASE
                WHEN wo.total_distance IS NULL THEN NULL
                ELSE wo.total_distance / 1000.0
              END,
              'avgPower', wo.avg_power,
              'avgNormalizedPower', wo.avg_normalized_power
            )
            ORDER BY wo.start_time ASC NULLS LAST, m.id ASC
          )
          FROM training_plan_session_matches m
          LEFT JOIN workouts wo
            ON wo.id = m.workout_id
          WHERE m.training_plan_week_id = w.id
            AND m.training_plan_session_id IS NULL
            AND m.match_status = 'extra_unplanned'
        ), '[]'::json) AS extra_workouts
      FROM training_plan_weeks w
      LEFT JOIN training_plan_week_reviews wr
        ON wr.training_plan_week_id = w.id
      LEFT JOIN training_plan_week_commentary wc
        ON wc.training_plan_week_id = w.id
      WHERE w.training_plan_id = $1
      ORDER BY w.week_number ASC
    `, [planId]);

    const weeks = weekRows.rows.map((week) => {
      const sessions = Array.isArray(week.sessions) ? week.sessions : [];
      const extraWorkouts = Array.isArray(week.extra_workouts) ? week.extra_workouts : [];
      const review = week.review_status
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
        : null;

      return {
        id: Number(week.id),
        weekNumber: Number(week.week_number),
        theme: week.theme,
        targetHours: Number(week.target_hours),
        review: review
          ? {
              ...review,
              recommendations: buildWeekRecommendations({ review, sessions, extraWorkouts }),
              commentary: week.commentary_payload
                ? {
                    ...(week.commentary_payload || {}),
                    model: week.commentary_model_name || null
                  }
                : null
            }
          : null,
        sessions,
        extraWorkouts
      };
    });

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
      weeks
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
              planned_date = $3,
              session_type = $4,
              title = $5,
              duration_hours = $6,
              notes = $7,
              objective = $8,
              intensity = $9,
              zone_label = $10,
              energy_system = $11
            WHERE id = $1
              AND training_plan_week_id = $12
        `, [
            sessionId,
            normalizedDay,
            toNullableDateString(session.plannedDate),
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
            planned_date,
            session_type,
            title,
            duration_hours,
            notes,
            objective,
            intensity,
            zone_label,
            energy_system
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          RETURNING id
        `, [
          weekId,
          normalizedDay,
          toNullableDateString(session.plannedDate),
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
            planned_date,
            session_type,
            title,
            duration_hours,
            notes,
            objective,
            intensity,
            zone_label,
            energy_system
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `, [
          weekId,
          String(session.day || ""),
          toNullableDateString(session.plannedDate),
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

  static async applyWeekAdjustment(userId, planId, sourceWeekNumber) {
    const plan = await this.getPlanById(userId, planId);
    const sourceWeek = (plan.weeks || []).find((week) => Number(week.weekNumber) === Number(sourceWeekNumber));
    const targetWeek = (plan.weeks || []).find((week) => Number(week.weekNumber) === Number(sourceWeekNumber) + 1);

    if (!sourceWeek) {
      fail("Source training week not found", 404);
    }

    if (!sourceWeek.review) {
      fail("Review this week before applying an adjustment", 400);
    }

    if (!targetWeek) {
      fail("No following training week is available for adjustment", 404);
    }

    const adjustedWeek = applyAdjustmentToWeek(sourceWeek, targetWeek, plan.summary?.planStartDate || null);
    return this.updateWeek(userId, planId, Number(targetWeek.weekNumber), adjustedWeek);
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

  static async saveWeekCommentary(userId, planId, weekNumber, commentary = { model: null, payload: {} }) {
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

      await client.query(`
        INSERT INTO training_plan_week_commentary (
          training_plan_id,
          training_plan_week_id,
          model_name,
          commentary_payload
        )
        VALUES ($1, $2, $3, $4::jsonb)
        ON CONFLICT (training_plan_week_id)
        DO UPDATE SET
          model_name = EXCLUDED.model_name,
          commentary_payload = EXCLUDED.commentary_payload,
          updated_at = NOW()
      `, [
        planId,
        weekId,
        String(commentary.model || "unknown"),
        JSON.stringify(commentary.payload || {})
      ]);

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
