import pool from "./database.js";

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function startOfDay(date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function startOfWeekFromAnchor(anchorDate, weekNumber) {
  const anchor = startOfDay(anchorDate);
  const day = anchor.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  anchor.setDate(anchor.getDate() + diffToMonday + (weekNumber - 1) * 7);
  return anchor;
}

function addDays(date, days) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function weekdayCode(date) {
  return ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][date.getDay()];
}

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeIntensityFromWorkout(workout) {
  const np = safeNumber(workout.avg_normalized_power, 0);
  const avgPower = safeNumber(workout.avg_power, 0);
  const proxy = Math.max(np, avgPower);

  if (proxy >= 250) {
    return "high";
  }
  if (proxy >= 170) {
    return "moderate";
  }
  return "low";
}

function durationCompliance(session, workout) {
  const planned = safeNumber(session.durationHours, 0);
  const actual = safeNumber(workout.total_timer_time, 0) / 3600;
  if (planned <= 0 || actual <= 0) {
    return 0;
  }

  return clamp(1 - Math.abs(actual - planned) / planned, 0, 1);
}

function intensityCompliance(session, workout) {
  const planned = String(session.semantics?.intensity || "low").toLowerCase();
  const actual = normalizeIntensityFromWorkout(workout);
  if (planned === actual) {
    return 1;
  }
  if ((planned === "high" && actual === "moderate") || (planned === "moderate" && actual === "low")) {
    return 0.6;
  }
  if ((planned === "moderate" && actual === "high") || (planned === "low" && actual === "moderate")) {
    return 0.75;
  }
  return 0.3;
}

function objectiveCompliance(session, workout) {
  const plannedType = String(session.type || "easy").toLowerCase();
  const actualDuration = safeNumber(workout.total_timer_time, 0) / 3600;
  const actualIntensity = normalizeIntensityFromWorkout(workout);

  if (plannedType === "long") {
    return actualDuration >= Math.max(1.5, safeNumber(session.durationHours, 0) * 0.75) ? 1 : 0.45;
  }
  if (plannedType === "hard") {
    return actualIntensity === "high" ? 1 : actualIntensity === "moderate" ? 0.55 : 0.2;
  }
  if (plannedType === "medium") {
    return actualIntensity === "moderate" ? 1 : actualIntensity === "high" ? 0.7 : 0.45;
  }
  return actualIntensity === "low" ? 1 : 0.5;
}

function overallMatchScore(session, workout) {
  const d = durationCompliance(session, workout);
  const i = intensityCompliance(session, workout);
  const o = objectiveCompliance(session, workout);
  return {
    durationCompliance: d,
    intensityCompliance: i,
    objectiveCompliance: o,
    matchScore: clamp((d * 0.4) + (i * 0.35) + (o * 0.25), 0, 1)
  };
}

function deriveMatchStatus(score) {
  if (score >= 0.85) {
    return "completed";
  }
  if (score >= 0.6) {
    return "mostly_completed";
  }
  if (score >= 0.35) {
    return "substituted";
  }
  return "missed";
}

function buildWeekSummary(counts, rates) {
  if (counts.missed_count >= 2 || rates.completionRate < 0.45) {
    return {
      reviewStatus: "off_track",
      reviewSummary: "Several planned sessions were missed or replaced. The week drifted clearly away from the original intent."
    };
  }

  if (counts.substituted_count > 0 || rates.completionRate < 0.75) {
    return {
      reviewStatus: "slightly_off",
      reviewSummary: "The week stayed partly on track, but some sessions were replaced or completed below target."
    };
  }

  return {
    reviewStatus: "on_track",
    reviewSummary: "The week matched the planned structure well and stayed close to the intended training objective."
  };
}

export default class TrainingPlanReviewService {
  static async reviewWeek(userId, plan) {
    const matches = [];
    const reviews = [];
    const workoutsResult = await pool.query(`
      SELECT
        id,
        uid,
        start_time,
        total_timer_time,
        total_distance,
        avg_power,
        avg_normalized_power
      FROM workouts
      WHERE uid = $1
      ORDER BY start_time ASC
    `, [userId]);
    const workouts = workoutsResult.rows;

    const anchorDate = plan?.summary?.planStartDate || plan?.input?.planStartDate || plan?.createdAt || new Date();

    for (const week of plan.weeks || []) {
      const weekStart = startOfWeekFromAnchor(anchorDate, week.weekNumber);
      const weekEnd = addDays(weekStart, 7);
      const weekWorkouts = workouts.filter((workout) => {
        const start = new Date(workout.start_time);
        return start >= weekStart && start < weekEnd;
      });
      const unmatchedWorkoutIds = new Set(weekWorkouts.map((workout) => Number(workout.id)));

      for (const session of week.sessions || []) {
        const exactDayCandidates = weekWorkouts.filter((workout) =>
          unmatchedWorkoutIds.has(Number(workout.id)) && weekdayCode(new Date(workout.start_time)) === session.day
        );
        const relaxedCandidates = weekWorkouts.filter((workout) => unmatchedWorkoutIds.has(Number(workout.id)));
        const candidatePool = exactDayCandidates.length > 0 ? exactDayCandidates : relaxedCandidates;

        let bestWorkout = null;
        let bestScore = null;

        for (const workout of candidatePool) {
          const score = overallMatchScore(session, workout);
          if (!bestScore || score.matchScore > bestScore.matchScore) {
            bestWorkout = workout;
            bestScore = score;
          }
        }

        if (!bestWorkout || !bestScore || bestScore.matchScore < 0.2) {
          matches.push({
            trainingPlanWeekId: week.id,
            trainingPlanSessionId: session.id,
            workoutId: null,
            matchStatus: "missed",
            matchScore: 0,
            durationCompliance: 0,
            intensityCompliance: 0,
            objectiveCompliance: 0,
            matchedBy: "rule_engine",
            matchReason: "No suitable workout was found for the planned session."
          });
          continue;
        }

        unmatchedWorkoutIds.delete(Number(bestWorkout.id));
        matches.push({
          trainingPlanWeekId: week.id,
          trainingPlanSessionId: session.id,
          workoutId: Number(bestWorkout.id),
          matchStatus: deriveMatchStatus(bestScore.matchScore),
          matchScore: bestScore.matchScore,
          durationCompliance: bestScore.durationCompliance,
          intensityCompliance: bestScore.intensityCompliance,
          objectiveCompliance: bestScore.objectiveCompliance,
          matchedBy: "rule_engine",
          matchReason: "Workout matched to the planned session based on timing, duration, and intensity profile."
        });
      }

      for (const workoutId of unmatchedWorkoutIds) {
        matches.push({
          trainingPlanWeekId: week.id,
          trainingPlanSessionId: null,
          workoutId,
          matchStatus: "extra_unplanned",
          matchScore: 0,
          durationCompliance: 0,
          intensityCompliance: 0,
          objectiveCompliance: 0,
          matchedBy: "rule_engine",
          matchReason: "Workout did not align with a planned session in this week."
        });
      }

      const weekMatches = matches.filter((match) => Number(match.trainingPlanWeekId) === Number(week.id));
      const plannedMatches = weekMatches.filter((match) => match.trainingPlanSessionId != null);
      const counts = {
        completed_count: plannedMatches.filter((match) => match.matchStatus === "completed").length,
        mostly_completed_count: plannedMatches.filter((match) => match.matchStatus === "mostly_completed").length,
        substituted_count: plannedMatches.filter((match) => match.matchStatus === "substituted").length,
        missed_count: plannedMatches.filter((match) => match.matchStatus === "missed").length,
        extra_unplanned_count: weekMatches.filter((match) => match.matchStatus === "extra_unplanned").length
      };
      const plannedCount = Math.max(1, plannedMatches.length);
      const rates = {
        completionRate: (counts.completed_count + (counts.mostly_completed_count * 0.75) + (counts.substituted_count * 0.35)) / plannedCount,
        volumeCompliance: plannedMatches.reduce((acc, match) => acc + safeNumber(match.durationCompliance, 0), 0) / plannedCount,
        intensityCompliance: plannedMatches.reduce((acc, match) => acc + safeNumber(match.intensityCompliance, 0), 0) / plannedCount,
        objectiveCompliance: plannedMatches.reduce((acc, match) => acc + safeNumber(match.objectiveCompliance, 0), 0) / plannedCount
      };
      const summary = buildWeekSummary(counts, rates);

      reviews.push({
        trainingPlanWeekId: week.id,
        completionRate: rates.completionRate,
        volumeCompliance: rates.volumeCompliance,
        intensityCompliance: rates.intensityCompliance,
        objectiveCompliance: rates.objectiveCompliance,
        ...counts,
        reviewStatus: summary.reviewStatus,
        reviewSummary: summary.reviewSummary
      });
    }

    return { matches, reviews };
  }
}
