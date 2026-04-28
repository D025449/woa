function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function roundToQuarterHour(value) {
  return Math.round(value * 4) / 4;
}

function normalizeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeDays(days) {
  const allowed = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  const list = Array.isArray(days) ? days : [];
  return allowed.filter((day) => list.includes(day));
}

function buildGoalSummary(input) {
  if (input.primaryGoal === "power") {
    const labels = {
      sprint: "Sprint power",
      "1min": "1-minute power",
      "4min": "4-minute power",
      "8min": "8-minute power",
      ftp: "FTP / 60-minute power"
    };

    return labels[input.powerFocus] || "Power improvement";
  }

  return "Event preparation";
}

function buildIntensityDistribution(planningStyle) {
  switch (planningStyle) {
    case "conservative":
      return { hard: 1, medium: 1 };
    case "ambitious":
      return { hard: 2, medium: 2 };
    default:
      return { hard: 2, medium: 1 };
  }
}

function buildGoalProfile({ primaryGoal, powerFocus, planningStyle, athleteDataMode }) {
  const cautious = athleteDataMode === "historical";

  if (primaryGoal === "event") {
    return {
      powerFocus: null,
      hardDays: cautious ? 1 : planningStyle === "ambitious" ? 2 : 1,
      mediumDays: planningStyle === "conservative" ? 1 : 2,
      longShare: 0.38,
      hardShare: 0.13,
      mediumShare: 0.16,
      easyMin: 0.75,
      longMin: 1.75,
      longMax: 6,
      weeklyGrowth: cautious
        ? (planningStyle === "ambitious" ? 0.025 : planningStyle === "conservative" ? 0.01 : 0.02)
        : (planningStyle === "ambitious" ? 0.06 : planningStyle === "conservative" ? 0.025 : 0.04)
    };
  }

  const profiles = {
    sprint: {
      powerFocus: "sprint",
      hardDays: cautious ? 1 : 2,
      mediumDays: 1,
      longShare: 0.2,
      hardShare: 0.12,
      mediumShare: 0.16,
      easyMin: 0.75,
      longMin: 1.25,
      longMax: 3.25,
      weeklyGrowth: cautious ? 0.015 : planningStyle === "ambitious" ? 0.045 : 0.03
    },
    "1min": {
      powerFocus: "1min",
      hardDays: cautious ? 1 : 2,
      mediumDays: planningStyle === "conservative" ? 1 : 2,
      longShare: 0.24,
      hardShare: 0.14,
      mediumShare: 0.16,
      easyMin: 0.75,
      longMin: 1.5,
      longMax: 4,
      weeklyGrowth: cautious ? 0.02 : planningStyle === "ambitious" ? 0.05 : 0.035
    },
    "4min": {
      powerFocus: "4min",
      hardDays: cautious ? 1 : 2,
      mediumDays: 2,
      longShare: 0.28,
      hardShare: 0.14,
      mediumShare: 0.17,
      easyMin: 0.75,
      longMin: 1.75,
      longMax: 4.5,
      weeklyGrowth: cautious ? 0.02 : planningStyle === "ambitious" ? 0.055 : 0.04
    },
    "8min": {
      powerFocus: "8min",
      hardDays: cautious ? 1 : 2,
      mediumDays: 2,
      longShare: 0.3,
      hardShare: 0.14,
      mediumShare: 0.18,
      easyMin: 0.75,
      longMin: 2,
      longMax: 5,
      weeklyGrowth: cautious ? 0.02 : planningStyle === "ambitious" ? 0.05 : 0.04
    },
    ftp: {
      powerFocus: "ftp",
      hardDays: cautious ? 1 : 2,
      mediumDays: 2,
      longShare: 0.32,
      hardShare: 0.15,
      mediumShare: 0.18,
      easyMin: 0.75,
      longMin: 2,
      longMax: 5.5,
      weeklyGrowth: cautious ? 0.02 : planningStyle === "ambitious" ? 0.05 : 0.04
    }
  };

  return profiles[powerFocus] || profiles["4min"];
}

function buildPowerTemplates(powerFocus) {
  const templates = {
    sprint: {
      hard: [
        "Sprint session · 10 x 12s maximal efforts with full recovery",
        "Neuromuscular accelerations · 3 sets of 6 short sprints"
      ],
      medium: [
        "Strength endurance ride · low cadence climbing blocks",
        "Tempo session · controlled aerobic support work"
      ],
      easy: [
        "Recovery spin · easy cadence and relaxed aerobic volume",
        "Endurance ride · low intensity aerobic support"
      ],
      long: [
        "Endurance ride · steady aerobic support with a few openers"
      ]
    },
    "1min": {
      hard: [
        "Anaerobic capacity session · 6 x 1 min hard / 3 min easy",
        "1-minute repeats · 2 sets of 5 hard repetitions"
      ],
      medium: [
        "Sweetspot session · sustained aerobic support blocks",
        "Tempo ride · controlled pressure just below threshold"
      ],
      easy: [
        "Recovery spin · easy cadence and light circulation",
        "Endurance ride · low intensity support volume"
      ],
      long: [
        "Long endurance ride · stable aerobic base with smooth pacing"
      ]
    },
    "4min": {
      hard: [
        "VO2max session · 5 x 4 min hard / 4 min easy",
        "VO2max ladder · 4 x 4 min with progressive pacing"
      ],
      medium: [
        "Sweetspot session · 3 x 12 min controlled pressure",
        "Threshold support ride · over-under style aerobic control"
      ],
      easy: [
        "Recovery spin · easy cadence and low strain",
        "Endurance ride · aerobic support and freshness maintenance"
      ],
      long: [
        "Long endurance ride · upper aerobic focus with controlled finish"
      ]
    },
    "8min": {
      hard: [
        "High aerobic session · 4 x 8 min around critical power",
        "VO2-threshold blend · 3 x 8 min progressive efforts"
      ],
      medium: [
        "Sweetspot ride · 2 x 20 min steady pressure",
        "Threshold session · sustained pacing focus"
      ],
      easy: [
        "Recovery spin · short and easy aerobic support",
        "Endurance ride · relaxed volume with cadence control"
      ],
      long: [
        "Long endurance ride · aerobic durability and pacing"
      ]
    },
    ftp: {
      hard: [
        "Threshold session · 3 x 12 min around FTP",
        "Threshold progression · 2 x 20 min sustained work"
      ],
      medium: [
        "Sweetspot blocks · 3 x 15 min controlled pressure",
        "Tempo endurance · long steady aerobic support"
      ],
      easy: [
        "Recovery spin · easy circulation and low fatigue",
        "Endurance ride · low intensity support volume"
      ],
      long: [
        "Long endurance ride · aerobic base with steady finish"
      ]
    }
  };

  return templates[powerFocus] || templates["4min"];
}

function buildEventTemplates(terrainProfile = "rolling") {
  const terrainLabel = {
    flat: "flat-course",
    rolling: "rolling-course",
    hilly: "hilly-course",
    mountainous: "mountain-course"
  }[terrainProfile] || "event-specific";

  return {
    hard: [
      `Event-specific intensity · race-like intervals for ${terrainLabel} demands`,
      `Structured key session · intensity blocks matched to ${terrainLabel} pacing`
    ],
    medium: [
      "Tempo / sweetspot support · build sustainable event pace",
      "Aerobic support ride · controlled pressure and fueling practice"
    ],
    easy: [
      "Recovery spin · absorb previous load and maintain freshness",
      "Easy endurance ride · low intensity with cadence freedom"
    ],
    long: [
      `Long event simulation ride · duration and fueling focus for ${terrainLabel} demands`
    ]
  };
}

function pickTemplate(list, index) {
  return list[index % list.length];
}

function buildSessionSemantics({ primaryGoal, powerFocus, type }) {
  const baseByType = {
    long: {
      objective: primaryGoal === "event" ? "Event durability and fueling" : "Aerobic durability",
      intensity: "low",
      zone: primaryGoal === "event" ? "Z2 with event-specific pacing" : "Z2",
      energySystem: "aerobic endurance"
    },
    hard: {
      objective: "Primary adaptation stimulus",
      intensity: "high",
      zone: "Z5-Z6",
      energySystem: "high aerobic power"
    },
    medium: {
      objective: "Supportive quality work",
      intensity: "moderate",
      zone: "Z3-Z4",
      energySystem: "threshold support"
    },
    easy: {
      objective: "Recovery and aerobic support",
      intensity: "low",
      zone: "Z1-Z2",
      energySystem: "recovery aerobic"
    }
  };

  const semantics = {
    ...(baseByType[type] || baseByType.easy)
  };

  if (primaryGoal === "event") {
    if (type === "hard") {
      semantics.objective = "Race-specific intensity and pacing";
      semantics.zone = "Z4-Z5";
      semantics.energySystem = "event-specific intensity";
    } else if (type === "medium") {
      semantics.objective = "Sustainable event pace support";
      semantics.zone = "Z3-Z4";
      semantics.energySystem = "tempo-threshold support";
    }

    return semantics;
  }

  const powerProfiles = {
    sprint: {
      hard: {
        objective: "Neuromuscular sprint power",
        zone: "Z6+",
        energySystem: "neuromuscular anaerobic"
      },
      medium: {
        objective: "Force and torque support",
        zone: "Z3-Z4",
        energySystem: "strength endurance"
      }
    },
    "1min": {
      hard: {
        objective: "Anaerobic capacity",
        zone: "Z6",
        energySystem: "anaerobic capacity"
      },
      medium: {
        objective: "Lactate tolerance support",
        zone: "Z3-Z4",
        energySystem: "high aerobic support"
      }
    },
    "4min": {
      hard: {
        objective: "VO2max development",
        zone: "Z5",
        energySystem: "vo2max"
      },
      medium: {
        objective: "Threshold support",
        zone: "Z3-Z4",
        energySystem: "sweetspot-threshold"
      }
    },
    "8min": {
      hard: {
        objective: "High aerobic power",
        zone: "Z4-Z5",
        energySystem: "vo2-threshold blend"
      },
      medium: {
        objective: "Sustained threshold support",
        zone: "Z3-Z4",
        energySystem: "threshold"
      }
    },
    ftp: {
      hard: {
        objective: "FTP extension",
        zone: "Z4",
        energySystem: "threshold"
      },
      medium: {
        objective: "Sweetspot durability",
        zone: "Z3-Z4",
        energySystem: "sweetspot"
      }
    }
  };

  const overrides = powerProfiles[powerFocus]?.[type];
  return overrides ? { ...semantics, ...overrides } : semantics;
}

function buildSession(type, label, hours, notes = "", semantics = null) {
  return {
    type,
    title: label,
    durationHours: roundToQuarterHour(hours),
    notes,
    semantics
  };
}

function pickTrainingDays(availableDays, goalProfile) {
  const preferredHard = ["tue", "thu", "sat", "wed", "fri"];
  const preferredMedium = ["wed", "fri", "thu", "sun", "mon"];
  const longDay = availableDays.includes("sat")
    ? "sat"
    : availableDays.includes("sun")
    ? "sun"
    : availableDays[availableDays.length - 1];

  const hardDays = preferredHard.filter((day) => availableDays.includes(day) && day !== longDay).slice(0, goalProfile.hardDays);
  const mediumDays = preferredMedium
    .filter((day) => availableDays.includes(day) && day !== longDay && !hardDays.includes(day))
    .slice(0, goalProfile.mediumDays);

  return { hardDays, mediumDays, longDay };
}

function buildWeekPlan({ weekIndex, availableDays, weeklyHours, goalTemplates, goalProfile, isRecoveryWeek, primaryGoal }) {
  const sessions = [];
  const dayCount = availableDays.length;
  const safeWeeklyHours = clamp(weeklyHours, 2, 40);
  const scaledHours = isRecoveryWeek ? safeWeeklyHours * 0.7 : safeWeeklyHours;
  const { hardDays, mediumDays, longDay } = pickTrainingDays(availableDays, goalProfile);

  let assignedHours = 0;

  availableDays.forEach((day, index) => {
    if (day === longDay) {
      const longHours = clamp(scaledHours * goalProfile.longShare, goalProfile.longMin, goalProfile.longMax);
      assignedHours += longHours;
      const semantics = buildSessionSemantics({ primaryGoal, powerFocus: goalProfile.powerFocus, type: "long" });
      sessions.push({
        day,
        ...buildSession("long", pickTemplate(goalTemplates.long, weekIndex + index), longHours, isRecoveryWeek ? "Reduced duration for recovery week." : "Primary endurance anchor of the week.", semantics)
      });
      return;
    }

    if (hardDays.includes(day)) {
      const hardHours = clamp(scaledHours * goalProfile.hardShare, 1, primaryGoal === "event" ? 2.5 : 2);
      assignedHours += hardHours;
      const semantics = buildSessionSemantics({ primaryGoal, powerFocus: goalProfile.powerFocus, type: "hard" });
      sessions.push({
        day,
        ...buildSession("hard", pickTemplate(goalTemplates.hard, weekIndex + index), hardHours, isRecoveryWeek ? "Keep intensity but reduce total stress." : "Key intensity day matched to the chosen goal.", semantics)
      });
      return;
    }

    if (mediumDays.includes(day)) {
      const mediumHours = clamp(scaledHours * goalProfile.mediumShare, 1, 3);
      assignedHours += mediumHours;
      const semantics = buildSessionSemantics({ primaryGoal, powerFocus: goalProfile.powerFocus, type: "medium" });
      sessions.push({
        day,
        ...buildSession("medium", pickTemplate(goalTemplates.medium, weekIndex + index), mediumHours, "Controlled support work to build repeatable training load.", semantics)
      });
      return;
    }

    const easyHours = clamp((scaledHours - assignedHours) / Math.max(1, dayCount - sessions.length), goalProfile.easyMin, 1.75);
    assignedHours += easyHours;
    const semantics = buildSessionSemantics({ primaryGoal, powerFocus: goalProfile.powerFocus, type: "easy" });
    sessions.push({
      day,
      ...buildSession("easy", pickTemplate(goalTemplates.easy, weekIndex + index), easyHours, "Low-intensity support day.", semantics)
    });
  });

  return sessions;
}

export default class TrainingPlanService {
  static generatePreviewPlan(payload = {}, userContext = null) {
    const primaryGoal = payload.primaryGoal === "power" ? "power" : "event";
    const powerFocus = payload.powerFocus || "4min";
    const planHorizonWeeks = clamp(normalizeNumber(payload.planHorizon, 4), 4, 12);
    const planningStyle = payload.planningStyle || "balanced";
    const athleteDataMode = payload.athleteDataMode === "historical" ? "historical" : "current";
    const contextHours7d = normalizeNumber(userContext?.recentVolume?.hours7d, 0);
    const contextHours28d = normalizeNumber(userContext?.recentVolume?.hours28d, 0);
    const currentCtl = normalizeNumber(userContext?.latestLoad?.ctl, 0);
    const currentAtl = normalizeNumber(userContext?.latestLoad?.atl, 0);
    const currentTsb = normalizeNumber(userContext?.latestLoad?.tsb, 0);
    const enteredWeeklyHours = clamp(normalizeNumber(payload.hoursPerWeek, 8), 2, 40);
    const baselineWeeklyHours = athleteDataMode === "historical"
      ? enteredWeeklyHours
      : contextHours28d > 0
      ? Math.max(enteredWeeklyHours, contextHours28d / 4)
      : enteredWeeklyHours;
    const fatigueAdjustment = athleteDataMode === "historical"
      ? 0.9
      : currentTsb < -15
      ? 0.88
      : currentTsb > 10
      ? 1.04
      : 1;
    const weeklyHours = clamp(roundToQuarterHour(baselineWeeklyHours * fatigueAdjustment), 2, 40);
    const availableDays = normalizeDays(payload.days);
    const safeDays = availableDays.length > 0 ? availableDays : ["tue", "thu", "sat"];
    const eventDate = payload.eventDate || null;
    const planStartDate = payload.planStartDate || null;
    const eventDistanceKm = normalizeNumber(payload.eventDistance, 0);
    const eventElevationM = normalizeNumber(payload.eventElevation, 0);
    const eventDurationH = normalizeNumber(payload.eventDuration, 0);
    const terrainProfile = payload.terrainProfile || "rolling";
    const notes = String(payload.additionalNotes || "").trim();
    const goalProfile = buildGoalProfile({ primaryGoal, powerFocus, planningStyle, athleteDataMode });
    const goalTemplates = primaryGoal === "power"
      ? buildPowerTemplates(powerFocus)
      : buildEventTemplates(terrainProfile);

    const weeks = [];

    for (let weekIndex = 0; weekIndex < planHorizonWeeks; weekIndex += 1) {
      const isRecoveryWeek = weekIndex > 0 && (weekIndex + 1) % 4 === 0;
      const isFinalWeek = weekIndex === planHorizonWeeks - 1;
      const taperFactor = primaryGoal === "event" && isFinalWeek
        ? 0.72
        : 1;
      const progressiveHours = clamp(
        weeklyHours * (1 + Math.min(weekIndex, 2) * goalProfile.weeklyGrowth) * taperFactor,
        2,
        40
      );

      weeks.push({
        weekNumber: weekIndex + 1,
        theme: isRecoveryWeek
          ? "Recovery and consolidation"
          : primaryGoal === "event" && isFinalWeek
          ? "Event taper and freshness"
          : athleteDataMode === "historical" && weekIndex === 0
          ? "Conservative restart and calibration"
          : primaryGoal === "power"
          ? `${buildGoalSummary({ primaryGoal, powerFocus })} focus`
          : "Event-oriented build",
        targetHours: roundToQuarterHour(isRecoveryWeek ? progressiveHours * 0.7 : progressiveHours),
        sessions: buildWeekPlan({
          weekIndex,
          availableDays: safeDays,
          weeklyHours: progressiveHours,
          goalTemplates,
          goalProfile,
          isRecoveryWeek,
          primaryGoal
        })
      });
    }

    return {
      summary: {
        goal: buildGoalSummary({ primaryGoal, powerFocus }),
        primaryGoal,
        powerFocus: primaryGoal === "power" ? powerFocus : null,
        eventDate,
        planStartDate,
        eventDistanceKm: primaryGoal === "event" ? eventDistanceKm : null,
        eventElevationM: primaryGoal === "event" ? eventElevationM : null,
        eventDurationH: primaryGoal === "event" ? eventDurationH : null,
        terrainProfile: primaryGoal === "event" ? terrainProfile : null,
        athleteDataMode,
        weeklyHours,
        enteredWeeklyHours,
        availableDays: safeDays,
        planHorizonWeeks,
        planningStyle,
        notes,
        userContext: userContext
          ? {
              latestLoad: userContext.latestLoad,
              latestFtp: userContext.latestFtp,
              recentVolume: userContext.recentVolume,
              workoutCount: userContext.workoutCount,
              recentPowerTargets: userContext.recentPowerTargets
            }
          : null,
        planningSignals: {
          currentCtl: athleteDataMode === "historical" ? null : currentCtl,
          currentAtl: athleteDataMode === "historical" ? null : currentAtl,
          currentTsb: athleteDataMode === "historical" ? null : currentTsb,
          contextHours7d: athleteDataMode === "historical" ? null : contextHours7d,
          contextHours28d: athleteDataMode === "historical" ? null : contextHours28d
        }
      },
      weeks
    };
  }
}
