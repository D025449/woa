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

function isoDateString(date) {
  return startOfDay(date).toISOString().slice(0, 10);
}

function weekdayCode(date) {
  return ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][date.getDay()];
}

function weekdayIndex(value) {
  return {
    mon: 1,
    tue: 2,
    wed: 3,
    thu: 4,
    fri: 5,
    sat: 6,
    sun: 7
  }[value] ?? 0;
}

function dayDistance(sessionDay, workoutDate) {
  return Math.abs(weekdayIndex(sessionDay) - weekdayIndex(weekdayCode(workoutDate)));
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

function normalizeDurationBucket(hours) {
  if (hours >= 2.5) {
    return "long";
  }
  if (hours >= 1.25) {
    return "medium";
  }
  return "short";
}

function sessionObjectiveBucket(session) {
  const plannedType = String(session.type || "easy").toLowerCase();
  const plannedHours = safeNumber(session.durationHours, 0);

  if (plannedType === "long") {
    return "long";
  }
  if (plannedType === "hard") {
    return "high_intensity";
  }
  if (plannedType === "medium") {
    return plannedHours >= 1.5 ? "tempo_endurance" : "steady";
  }
  return plannedHours >= 1.75 ? "easy_endurance" : "recovery";
}

function workoutObjectiveBucket(workout) {
  const durationHours = safeNumber(workout.total_timer_time, 0) / 3600;
  const intensity = normalizeIntensityFromWorkout(workout);

  if (durationHours >= 2.5) {
    return intensity === "low" ? "long" : "tempo_endurance";
  }
  if (intensity === "high") {
    return "high_intensity";
  }
  if (intensity === "moderate") {
    return durationHours >= 1.5 ? "tempo_endurance" : "steady";
  }
  return durationHours >= 1.75 ? "easy_endurance" : "recovery";
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
  const plannedObjective = sessionObjectiveBucket(session);
  const workoutObjective = workoutObjectiveBucket(workout);
  const plannedDurationBucket = normalizeDurationBucket(safeNumber(session.durationHours, 0));
  const workoutDurationBucket = normalizeDurationBucket(safeNumber(workout.total_timer_time, 0) / 3600);

  if (plannedObjective === workoutObjective) {
    return 1;
  }

  const compatibleObjectives = new Set([
    "tempo_endurance:steady",
    "steady:tempo_endurance",
    "easy_endurance:long",
    "long:easy_endurance",
    "recovery:steady",
    "steady:recovery"
  ]);

  if (compatibleObjectives.has(`${plannedObjective}:${workoutObjective}`)) {
    return 0.72;
  }

  if (plannedDurationBucket === workoutDurationBucket) {
    return 0.58;
  }

  return 0.25;
}

function timingCompliance(session, workout) {
  const workoutDate = new Date(workout.start_time);
  const plannedDate = session.plannedDate ? new Date(session.plannedDate) : null;

  if (plannedDate && !Number.isNaN(plannedDate.getTime())) {
    const diffDays = Math.abs((startOfDay(workoutDate).getTime() - startOfDay(plannedDate).getTime()) / 86400000);
    if (diffDays === 0) {
      return 1;
    }
    if (diffDays === 1) {
      return 0.85;
    }
    if (diffDays === 2) {
      return 0.65;
    }
    if (diffDays <= 3) {
      return 0.45;
    }
    return 0.15;
  }

  const fallbackDistance = dayDistance(session.day, workoutDate);
  if (fallbackDistance === 0) {
    return 1;
  }
  if (fallbackDistance === 1) {
    return 0.8;
  }
  if (fallbackDistance === 2) {
    return 0.55;
  }
  return 0.25;
}

function overallMatchScore(session, workout) {
  const d = durationCompliance(session, workout);
  const i = intensityCompliance(session, workout);
  const o = objectiveCompliance(session, workout);
  const t = timingCompliance(session, workout);
  return {
    durationCompliance: d,
    intensityCompliance: i,
    objectiveCompliance: o,
    timingCompliance: t,
    matchScore: clamp((d * 0.32) + (i * 0.26) + (o * 0.24) + (t * 0.18), 0, 1)
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
  if (counts.completed_count === 0 && counts.mostly_completed_count === 0 && counts.substituted_count === 0 && counts.extra_unplanned_count === 0) {
    return {
      reviewStatus: "off_track",
      reviewSummary: "reviewSummary.noMatchingWorkouts"
    };
  }

  if (counts.missed_count >= 2 || rates.completionRate < 0.45) {
    return {
      reviewStatus: "off_track",
      reviewSummary: "reviewSummary.severalMissed"
    };
  }

  if (counts.substituted_count > 0 || rates.completionRate < 0.75) {
    return {
      reviewStatus: "slightly_off",
      reviewSummary: "reviewSummary.partlyOnTrack"
    };
  }

  return {
    reviewStatus: "on_track",
    reviewSummary: "reviewSummary.matchedPlannedStructure"
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
        const candidatePool = weekWorkouts
          .filter((workout) => unmatchedWorkoutIds.has(Number(workout.id)))
          .map((workout) => ({
            workout,
            workoutDate: new Date(workout.start_time),
            timingDistance: session.plannedDate
              ? Math.abs((startOfDay(new Date(workout.start_time)).getTime() - startOfDay(new Date(session.plannedDate)).getTime()) / 86400000)
              : dayDistance(session.day, new Date(workout.start_time))
          }))
          .sort((a, b) => a.timingDistance - b.timingDistance)
          .map((entry) => entry.workout);

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
            timingCompliance: 0,
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
          timingCompliance: bestScore.timingCompliance,
          matchedBy: "rule_engine",
          matchReason: `Matched workout on ${isoDateString(new Date(bestWorkout.start_time))} using timing, duration, and intensity similarity.`
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
          timingCompliance: 0,
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
