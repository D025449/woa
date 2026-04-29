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

function toIsoDate(date) {
  return startOfDay(date).toISOString().slice(0, 10);
}

function weekdayOffset(dayCode) {
  const offsets = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 };
  return offsets[dayCode] ?? 0;
}

function buildGoalSummary(input) {
  if (input.primaryGoal === "power") {
    const labels = {
      sprint: "goalSummary.sprintPower",
      "1min": "goalSummary.oneMinutePower",
      "4min": "goalSummary.fourMinutePower",
      "8min": "goalSummary.eightMinutePower",
      ftp: "goalSummary.ftpPower"
    };

    return labels[input.powerFocus] || "goalSummary.powerImprovement";
  }

  return "goalSummary.eventPreparation";
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
        "sessionTitle.sprint1012",
        "sessionTitle.neuromuscularAccelerations"
      ],
      medium: [
        "sessionTitle.strengthEnduranceRide",
        "sessionTitle.tempoSessionSupport"
      ],
      easy: [
        "sessionTitle.recoverySpinRelaxed",
        "sessionTitle.enduranceAerobicSupport"
      ],
      long: [
        "sessionTitle.enduranceOpeners"
      ]
    },
    "1min": {
      hard: [
        "sessionTitle.anaerobic613",
        "sessionTitle.oneMinuteRepeats"
      ],
      medium: [
        "sessionTitle.sweetspotSustainedSupport",
        "sessionTitle.tempoRideThreshold"
      ],
      easy: [
        "sessionTitle.recoverySpinLightCirculation",
        "sessionTitle.enduranceSupportVolume"
      ],
      long: [
        "sessionTitle.longEnduranceSmoothPacing"
      ]
    },
    "4min": {
      hard: [
        "sessionTitle.vo2max544",
        "sessionTitle.vo2maxLadder"
      ],
      medium: [
        "sessionTitle.sweetspot312",
        "sessionTitle.thresholdSupportRide"
      ],
      easy: [
        "sessionTitle.recoverySpinLowStrain",
        "sessionTitle.enduranceFreshness"
      ],
      long: [
        "sessionTitle.longEnduranceControlledFinish"
      ]
    },
    "8min": {
      hard: [
        "sessionTitle.highAerobic48",
        "sessionTitle.vo2ThresholdBlend"
      ],
      medium: [
        "sessionTitle.sweetspotRide220",
        "sessionTitle.thresholdSustainedPacing"
      ],
      easy: [
        "sessionTitle.recoverySpinShortEasy",
        "sessionTitle.enduranceCadenceControl"
      ],
      long: [
        "sessionTitle.longEnduranceDurability"
      ]
    },
    ftp: {
      hard: [
        "sessionTitle.thresholdSession312",
        "sessionTitle.thresholdProgression220"
      ],
      medium: [
        "sessionTitle.sweetspotBlocks315",
        "sessionTitle.tempoEndurance"
      ],
      easy: [
        "sessionTitle.recoverySpinLowFatigue",
        "sessionTitle.enduranceSupportVolume"
      ],
      long: [
        "sessionTitle.longEnduranceSteadyFinish"
      ]
    }
  };

  return templates[powerFocus] || templates["4min"];
}

function buildEventTemplates(terrainProfile = "rolling") {
  const terrainLabel = {
    flat: "terrain.flatCourse",
    rolling: "terrain.rollingCourse",
    hilly: "terrain.hillyCourse",
    mountainous: "terrain.mountainCourse"
  }[terrainProfile] || "terrain.eventSpecific";

  return {
    hard: [
      `sessionTitle.eventSpecificIntensity|${terrainLabel}`,
      `sessionTitle.structuredKeySession|${terrainLabel}`
    ],
    medium: [
      "sessionTitle.tempoSweetspotSupport",
      "sessionTitle.aerobicSupportFueling"
    ],
    easy: [
      "sessionTitle.recoverySpinAbsorbLoad",
      "sessionTitle.easyEnduranceCadenceFreedom"
    ],
    long: [
      `sessionTitle.longEventSimulation|${terrainLabel}`
    ]
  };
}

function pickTemplate(list, index) {
  return list[index % list.length];
}

function buildSessionSemantics({ primaryGoal, powerFocus, type }) {
  const baseByType = {
    long: {
      objective: primaryGoal === "event" ? "semanticsObjective.eventDurabilityFueling" : "semanticsObjective.aerobicDurability",
      intensity: "low",
      zone: primaryGoal === "event" ? "Z2 with event-specific pacing" : "Z2",
      energySystem: "semanticsSystem.aerobicEndurance"
    },
    hard: {
      objective: "semanticsObjective.primaryAdaptationStimulus",
      intensity: "high",
      zone: "Z5-Z6",
      energySystem: "semanticsSystem.highAerobicPower"
    },
    medium: {
      objective: "semanticsObjective.supportiveQualityWork",
      intensity: "moderate",
      zone: "Z3-Z4",
      energySystem: "semanticsSystem.thresholdSupport"
    },
    easy: {
      objective: "semanticsObjective.recoveryAerobicSupport",
      intensity: "low",
      zone: "Z1-Z2",
      energySystem: "semanticsSystem.recoveryAerobic"
    }
  };

  const semantics = {
    ...(baseByType[type] || baseByType.easy)
  };

  if (primaryGoal === "event") {
    if (type === "hard") {
      semantics.objective = "semanticsObjective.raceSpecificIntensity";
      semantics.zone = "Z4-Z5";
      semantics.energySystem = "semanticsSystem.eventSpecificIntensity";
    } else if (type === "medium") {
      semantics.objective = "semanticsObjective.eventPaceSupport";
      semantics.zone = "Z3-Z4";
      semantics.energySystem = "semanticsSystem.tempoThresholdSupport";
    }

    return semantics;
  }

  const powerProfiles = {
    sprint: {
      hard: {
        objective: "semanticsObjective.neuromuscularSprintPower",
        zone: "Z6+",
        energySystem: "semanticsSystem.neuromuscularAnaerobic"
      },
      medium: {
        objective: "semanticsObjective.forceTorqueSupport",
        zone: "Z3-Z4",
        energySystem: "semanticsSystem.strengthEndurance"
      }
    },
    "1min": {
      hard: {
        objective: "semanticsObjective.anaerobicCapacity",
        zone: "Z6",
        energySystem: "semanticsSystem.anaerobicCapacity"
      },
      medium: {
        objective: "semanticsObjective.lactateTolerance",
        zone: "Z3-Z4",
        energySystem: "semanticsSystem.highAerobicSupport"
      }
    },
    "4min": {
      hard: {
        objective: "semanticsObjective.vo2maxDevelopment",
        zone: "Z5",
        energySystem: "semanticsSystem.vo2max"
      },
      medium: {
        objective: "semanticsObjective.thresholdSupport",
        zone: "Z3-Z4",
        energySystem: "semanticsSystem.sweetspotThreshold"
      }
    },
    "8min": {
      hard: {
        objective: "semanticsObjective.highAerobicPower",
        zone: "Z4-Z5",
        energySystem: "semanticsSystem.vo2ThresholdBlend"
      },
      medium: {
        objective: "semanticsObjective.sustainedThresholdSupport",
        zone: "Z3-Z4",
        energySystem: "semanticsSystem.threshold"
      }
    },
    ftp: {
      hard: {
        objective: "semanticsObjective.ftpExtension",
        zone: "Z4",
        energySystem: "semanticsSystem.threshold"
      },
      medium: {
        objective: "semanticsObjective.sweetspotDurability",
        zone: "Z3-Z4",
        energySystem: "semanticsSystem.sweetspot"
      }
    }
  };

  const overrides = powerProfiles[powerFocus]?.[type];
  return overrides ? { ...semantics, ...overrides } : semantics;
}

function buildWeekTheme({ isRecoveryWeek, isFinalWeek, primaryGoal, athleteDataMode, powerFocus }) {
  if (isRecoveryWeek) {
    return "weekTheme.recoveryAndConsolidation";
  }
  if (primaryGoal === "event" && isFinalWeek) {
    return "weekTheme.eventTaperAndFreshness";
  }
  if (athleteDataMode === "historical") {
    return "weekTheme.conservativeRestartAndCalibration";
  }
  if (primaryGoal !== "power") {
    return "weekTheme.eventOrientedBuild";
  }
  const map = {
    sprint: "weekTheme.sprintFocus",
    "1min": "weekTheme.oneMinuteFocus",
    "4min": "weekTheme.fourMinuteFocus",
    "8min": "weekTheme.eightMinuteFocus",
    ftp: "weekTheme.ftpFocus"
  };
  return map[powerFocus] || "weekTheme.fourMinuteFocus";
}

function buildSession(type, label, hours, notes = "", semantics = null, plannedDate = null) {
  return {
    type,
    title: label,
    durationHours: roundToQuarterHour(hours),
    notes,
    semantics,
    plannedDate
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

function buildWeekPlan({ weekIndex, availableDays, weeklyHours, goalTemplates, goalProfile, isRecoveryWeek, primaryGoal, planStartDate }) {
  const sessions = [];
  const dayCount = availableDays.length;
  const safeWeeklyHours = clamp(weeklyHours, 2, 40);
  const scaledHours = isRecoveryWeek ? safeWeeklyHours * 0.7 : safeWeeklyHours;
  const { hardDays, mediumDays, longDay } = pickTrainingDays(availableDays, goalProfile);
  const weekStartDate = planStartDate ? startOfWeekFromAnchor(new Date(planStartDate), weekIndex) : null;

  let assignedHours = 0;

  availableDays.forEach((day, index) => {
    const plannedDate = weekStartDate ? toIsoDate(addDays(weekStartDate, weekdayOffset(day))) : null;
    if (day === longDay) {
      const longHours = clamp(scaledHours * goalProfile.longShare, goalProfile.longMin, goalProfile.longMax);
      assignedHours += longHours;
      const semantics = buildSessionSemantics({ primaryGoal, powerFocus: goalProfile.powerFocus, type: "long" });
      sessions.push({
        day,
        ...buildSession("long", pickTemplate(goalTemplates.long, weekIndex + index), longHours, isRecoveryWeek ? "sessionNote.reducedDurationRecovery" : "sessionNote.primaryEnduranceAnchor", semantics, plannedDate)
      });
      return;
    }

    if (hardDays.includes(day)) {
      const hardHours = clamp(scaledHours * goalProfile.hardShare, 1, primaryGoal === "event" ? 2.5 : 2);
      assignedHours += hardHours;
      const semantics = buildSessionSemantics({ primaryGoal, powerFocus: goalProfile.powerFocus, type: "hard" });
      sessions.push({
        day,
        ...buildSession("hard", pickTemplate(goalTemplates.hard, weekIndex + index), hardHours, isRecoveryWeek ? "sessionNote.keepIntensityReduceStress" : "sessionNote.keyIntensityDay", semantics, plannedDate)
      });
      return;
    }

    if (mediumDays.includes(day)) {
      const mediumHours = clamp(scaledHours * goalProfile.mediumShare, 1, 3);
      assignedHours += mediumHours;
      const semantics = buildSessionSemantics({ primaryGoal, powerFocus: goalProfile.powerFocus, type: "medium" });
      sessions.push({
        day,
        ...buildSession("medium", pickTemplate(goalTemplates.medium, weekIndex + index), mediumHours, "sessionNote.controlledSupportWork", semantics, plannedDate)
      });
      return;
    }

    const easyHours = clamp((scaledHours - assignedHours) / Math.max(1, dayCount - sessions.length), goalProfile.easyMin, 1.75);
    assignedHours += easyHours;
    const semantics = buildSessionSemantics({ primaryGoal, powerFocus: goalProfile.powerFocus, type: "easy" });
    sessions.push({
      day,
      ...buildSession("easy", pickTemplate(goalTemplates.easy, weekIndex + index), easyHours, "sessionNote.lowIntensitySupportDay", semantics, plannedDate)
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
    const planStartDate = toNullableDateString(payload.planStartDate);
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
        theme: buildWeekTheme({ isRecoveryWeek, isFinalWeek, primaryGoal, athleteDataMode: athleteDataMode === "historical" && weekIndex === 0 ? "historical" : athleteDataMode, powerFocus }),
        targetHours: roundToQuarterHour(isRecoveryWeek ? progressiveHours * 0.7 : progressiveHours),
        sessions: buildWeekPlan({
          weekIndex,
          availableDays: safeDays,
          weeklyHours: progressiveHours,
          goalTemplates,
          goalProfile,
          isRecoveryWeek,
          primaryGoal,
          planStartDate
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
