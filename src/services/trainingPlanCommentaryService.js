import fetch from "node-fetch";

function fail(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

function compactSession(session = {}) {
  return {
    day: session.day || null,
    planned_date: session.plannedDate || null,
    type: session.type || null,
    title: session.title || null,
    duration_hours: session.durationHours ?? null,
    semantics: session.semantics || {},
    match: session.match
      ? {
          status: session.match.status || null,
          score: session.match.score ?? null,
          duration_compliance: session.match.durationCompliance ?? null,
          intensity_compliance: session.match.intensityCompliance ?? null,
          objective_compliance: session.match.objectiveCompliance ?? null,
          reason: session.match.reason || null
        }
      : null
  };
}

function compactExtraWorkout(workout = {}) {
  return {
    workout_id: workout.workoutId ?? null,
    start_time: workout.startTime || null,
    duration_hours: workout.durationHours ?? null,
    distance_km: workout.distanceKm ?? null,
    avg_power: workout.avgPower ?? null,
    normalized_power: workout.avgNormalizedPower ?? null,
    reason: workout.reason || null
  };
}

function languageInstruction(locale) {
  const normalized = String(locale || "en").toLowerCase();
  const labels = {
    de: "German",
    en: "English",
    es: "Spanish",
    fr: "French",
    it: "Italian",
    pt: "Portuguese"
  };

  return labels[normalized] || "English";
}

function buildPromptPayload(plan, week, locale) {
  return {
    target_locale: String(locale || "en").toLowerCase(),
    athlete_context: {
      primary_goal: plan?.summary?.primaryGoal || plan?.input?.primaryGoal || null,
      power_focus: plan?.summary?.powerFocus || plan?.input?.powerFocus || null,
      weekly_hours: plan?.summary?.weeklyHours ?? null,
      available_days: plan?.summary?.availableDays || [],
      planning_style: plan?.summary?.planningStyle || plan?.input?.planningStyle || null,
      athlete_data_mode: plan?.summary?.athleteDataMode || plan?.input?.athleteDataMode || null
    },
    plan_context: {
      plan_name: plan?.name || null,
      plan_start_date: plan?.summary?.planStartDate || null,
      week_number: week?.weekNumber ?? null,
      week_theme: week?.theme || null,
      week_target_hours: week?.targetHours ?? null
    },
    review_context: {
      review_status: week?.review?.status || null,
      completion_rate: week?.review?.completionRate ?? null,
      volume_compliance: week?.review?.volumeCompliance ?? null,
      intensity_compliance: week?.review?.intensityCompliance ?? null,
      objective_compliance: week?.review?.objectiveCompliance ?? null,
      counts: {
        completed: week?.review?.completedCount ?? 0,
        mostly_completed: week?.review?.mostlyCompletedCount ?? 0,
        substituted: week?.review?.substitutedCount ?? 0,
        missed: week?.review?.missedCount ?? 0,
        extra_unplanned: week?.review?.extraUnplannedCount ?? 0
      },
      week_summary: week?.review?.summary || null,
      sessions: (week?.sessions || []).map(compactSession),
      extra_workouts: (week?.extraWorkouts || []).map(compactExtraWorkout),
      rule_based_recommendations: (week?.review?.recommendations || []).map((item) => ({
        severity: item.severity || "low",
        title: item.title || "",
        detail: item.detail || ""
      }))
    }
  };
}

function extractText(responseJson = {}) {
  if (typeof responseJson.output_text === "string" && responseJson.output_text.trim()) {
    return responseJson.output_text.trim();
  }

  const parts = [];
  for (const item of responseJson.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) {
        parts.push(content.text);
      }
    }
  }
  return parts.join("\n").trim();
}

function parseCommentary(rawText) {
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    fail("Coach commentary response could not be parsed", 502);
  }

  return {
    week_summary: String(parsed.week_summary || "").trim(),
    highlights: Array.isArray(parsed.highlights) ? parsed.highlights.map((item) => String(item)).filter(Boolean) : [],
    risks: Array.isArray(parsed.risks) ? parsed.risks.map((item) => String(item)).filter(Boolean) : [],
    next_actions: Array.isArray(parsed.next_actions) ? parsed.next_actions.map((item) => String(item)).filter(Boolean) : [],
    coach_tone: String(parsed.coach_tone || "").trim()
  };
}

export default class TrainingPlanCommentaryService {
  static async generateWeekCommentary(plan, week, locale = "en") {
    if (!process.env.OPENAI_API_KEY) {
      fail("Coach commentary is not configured. Missing OPENAI_API_KEY.", 400);
    }

    if (!week?.review) {
      fail("Review this week before generating commentary.", 400);
    }

    const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
    const payload = buildPromptPayload(plan, week, locale);
    const targetLanguage = languageInstruction(locale);
    const systemPrompt = [
      "You are an endurance training coach assistant.",
      "Use only the supplied structured data.",
      "Do not invent facts or workout details.",
      "Do not provide medical advice.",
      "Be concise, practical, supportive, and specific.",
      `Write all user-facing text in ${targetLanguage}.`,
      "Return strict JSON only with keys: week_summary, highlights, risks, next_actions, coach_tone."
    ].join(" ");

    const userPrompt = [
      "Analyze the reviewed training week and produce concise coaching commentary.",
      "Focus on what happened, what matters most, and what the athlete should do next.",
      "If the data is limited or historical/simulated, acknowledge uncertainty briefly."
    ].join(" ");

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model,
        input: [
          {
            role: "system",
            content: [{ type: "input_text", text: systemPrompt }]
          },
          {
            role: "user",
            content: [
              { type: "input_text", text: userPrompt },
              { type: "input_text", text: JSON.stringify(payload, null, 2) }
            ]
          }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "training_week_commentary",
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                week_summary: { type: "string" },
                highlights: { type: "array", items: { type: "string" } },
                risks: { type: "array", items: { type: "string" } },
                next_actions: { type: "array", items: { type: "string" } },
                coach_tone: { type: "string" }
              },
              required: ["week_summary", "highlights", "risks", "next_actions", "coach_tone"]
            }
          }
        }
      })
    });

    const responseJson = await response.json();

    if (!response.ok) {
      fail(responseJson?.error?.message || "Coach commentary request failed", response.status);
    }

    const rawText = extractText(responseJson);
    const commentary = parseCommentary(rawText);

    return {
      model,
      payload: commentary
    };
  }
}
