import pool from "./database.js";
import PaymentsDBService from "./paymentsDBService.js";

const DEFAULT_TIER = "free";

const TIER_LIMITS = {
  free: {
    training_plan_generation: { type: "monthly", limit: 5 },
    coach_commentary_generation: { type: "monthly", limit: 10 },
    training_plan_saved: { type: "concurrent", limit: 1 },
    stored_workout: { type: "lifetime", limit: 100 }
  },
  plus: {
    training_plan_generation: { type: "monthly", limit: 40 },
    coach_commentary_generation: { type: "monthly", limit: 80 },
    training_plan_saved: { type: "concurrent", limit: 10 },
    stored_workout: { type: "lifetime", limit: 1000 }
  },
  pro: {
    training_plan_generation: { type: "monthly", limit: 150 },
    coach_commentary_generation: { type: "monthly", limit: 300 },
    training_plan_saved: { type: "concurrent", limit: 50 },
    stored_workout: { type: "lifetime", limit: 5000 }
  },
  premium: {
    training_plan_generation: { type: "monthly", limit: 500 },
    coach_commentary_generation: { type: "monthly", limit: 1000 },
    training_plan_saved: { type: "concurrent", limit: 250 },
    stored_workout: { type: "lifetime", limit: 25000 }
  }
};

function monthPeriodKey(date = new Date()) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function warningForUsage(used, limit) {
  if (!Number.isFinite(limit) || limit <= 0) {
    return false;
  }
  return used / limit >= 0.8;
}

function exceededForUsage(used, limit) {
  if (!Number.isFinite(limit) || limit <= 0) {
    return false;
  }
  return used > limit;
}

export default class EntitlementService {
  static async getActiveTier(userId) {
    const membership = await PaymentsDBService.getMembershipForUser(userId);
    const tierCode = membership?.isActive
      ? String(membership?.plan?.tierCode || DEFAULT_TIER).trim().toLowerCase()
      : DEFAULT_TIER;
    return Object.prototype.hasOwnProperty.call(TIER_LIMITS, tierCode) ? tierCode : DEFAULT_TIER;
  }

  static getEntitlementsForTier(tierCode) {
    const normalized = String(tierCode || DEFAULT_TIER).trim().toLowerCase();
    return TIER_LIMITS[normalized] || TIER_LIMITS[DEFAULT_TIER];
  }

  static describeTier(tierCode) {
    const normalized = String(tierCode || DEFAULT_TIER).trim().toLowerCase();
    const entitlements = this.getEntitlementsForTier(normalized);
    return {
      tierCode: normalized,
      limits: {
        trainingPlanGenerationPerMonth: entitlements.training_plan_generation?.limit ?? null,
        coachCommentaryGenerationPerMonth: entitlements.coach_commentary_generation?.limit ?? null,
        savedPlans: entitlements.training_plan_saved?.limit ?? null,
        storedWorkouts: entitlements.stored_workout?.limit ?? null
      }
    };
  }

  static async getUsage(userId, featureKey, periodKey = monthPeriodKey()) {
    const result = await pool.query(`
      SELECT COALESCE(SUM(amount), 0) AS used
      FROM feature_usage_events
      WHERE user_id = $1
        AND feature_key = $2
        AND period_key = $3
    `, [userId, featureKey, periodKey]);

    return Number(result.rows[0]?.used || 0);
  }

  static async getCurrentPlanCount(userId) {
    const result = await pool.query(`
      SELECT COUNT(*) AS count
      FROM training_plans
      WHERE user_id = $1
    `, [userId]);

    return Number(result.rows[0]?.count || 0);
  }

  static async getWorkoutCount(userId) {
    const result = await pool.query(`
      SELECT COUNT(*) AS count
      FROM workouts
      WHERE uid = $1
    `, [userId]);

    return Number(result.rows[0]?.count || 0);
  }

  static async checkAllowance(userId, featureKey, amount = 1) {
    const tierCode = await this.getActiveTier(userId);
    const entitlements = this.getEntitlementsForTier(tierCode);
    const config = entitlements[featureKey];

    if (!config) {
      return {
        allowed: true,
        tierCode,
        featureKey,
        limitType: null,
        limitValue: null,
        used: 0,
        remaining: null,
        warning: false
      };
    }

    if (config.type === "monthly") {
      const periodKey = monthPeriodKey();
      const used = await this.getUsage(userId, featureKey, periodKey);
      const remaining = Math.max(0, config.limit - used);
      const allowed = used + amount <= config.limit;
      return {
        allowed,
        tierCode,
        featureKey,
        limitType: config.type,
        limitValue: config.limit,
        used,
        remaining,
        periodKey,
        warning: warningForUsage(used, config.limit),
        reason: allowed ? null : "limit_exceeded"
      };
    }

    if (config.type === "concurrent") {
      const used = featureKey === "training_plan_saved"
        ? await this.getCurrentPlanCount(userId)
        : 0;
      const remaining = Math.max(0, config.limit - used);
      const allowed = used + amount <= config.limit;
      return {
        allowed,
        tierCode,
        featureKey,
        limitType: config.type,
        limitValue: config.limit,
        used,
        remaining,
        warning: warningForUsage(used, config.limit),
        reason: allowed ? null : "limit_exceeded"
      };
    }

    if (config.type === "lifetime") {
      const used = featureKey === "stored_workout"
        ? await this.getWorkoutCount(userId)
        : 0;
      const remaining = Math.max(0, config.limit - used);
      const allowed = used + amount <= config.limit;
      return {
        allowed,
        tierCode,
        featureKey,
        limitType: config.type,
        limitValue: config.limit,
        used,
        remaining,
        warning: warningForUsage(used, config.limit),
        reason: allowed ? null : "limit_exceeded"
      };
    }

    return {
      allowed: true,
      tierCode,
      featureKey,
      limitType: config.type || null,
      limitValue: config.limit ?? null,
      used: 0,
      remaining: null,
      warning: false
    };
  }

  static async consume(userId, featureKey, amount = 1, metadata = {}) {
    const check = await this.checkAllowance(userId, featureKey, amount);
    if (!check.allowed) {
      const error = new Error(`Usage limit exceeded for ${featureKey}`);
      error.statusCode = 402;
      error.limit = check;
      throw error;
    }

    if (check.limitType !== "monthly") {
      return check;
    }

    await pool.query(`
      INSERT INTO feature_usage_events (
        user_id,
        tier_code,
        feature_key,
        amount,
        period_key,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb)
    `, [
      userId,
      check.tierCode,
      featureKey,
      amount,
      check.periodKey,
      JSON.stringify(metadata || {})
    ]);

    return {
      ...check,
      used: check.used + amount,
      remaining: Math.max(0, (check.remaining ?? 0) - amount),
      warning: warningForUsage(check.used + amount, check.limitValue)
    };
  }

  static async getUsageOverview(userId) {
    const tierCode = await this.getActiveTier(userId);
    const tier = this.describeTier(tierCode);
    const periodKey = monthPeriodKey();
    const [planGenerationUsed, coachCommentaryUsed, savedPlansUsed, storedWorkoutsUsed] = await Promise.all([
      this.getUsage(userId, "training_plan_generation", periodKey),
      this.getUsage(userId, "coach_commentary_generation", periodKey),
      this.getCurrentPlanCount(userId),
      this.getWorkoutCount(userId)
    ]);

    const usageItems = [
      {
        featureKey: "training_plan_generation",
        label: "Plan generations",
        periodLabel: "This month",
        used: planGenerationUsed,
        limit: tier.limits.trainingPlanGenerationPerMonth,
        warning: warningForUsage(planGenerationUsed, tier.limits.trainingPlanGenerationPerMonth),
        exceeded: exceededForUsage(planGenerationUsed, tier.limits.trainingPlanGenerationPerMonth)
      },
      {
        featureKey: "coach_commentary_generation",
        label: "Coach commentary",
        periodLabel: "This month",
        used: coachCommentaryUsed,
        limit: tier.limits.coachCommentaryGenerationPerMonth,
        warning: warningForUsage(coachCommentaryUsed, tier.limits.coachCommentaryGenerationPerMonth),
        exceeded: exceededForUsage(coachCommentaryUsed, tier.limits.coachCommentaryGenerationPerMonth)
      },
      {
        featureKey: "training_plan_saved",
        label: "Saved plans",
        periodLabel: "Current",
        used: savedPlansUsed,
        limit: tier.limits.savedPlans,
        warning: warningForUsage(savedPlansUsed, tier.limits.savedPlans),
        exceeded: exceededForUsage(savedPlansUsed, tier.limits.savedPlans)
      },
      {
        featureKey: "stored_workout",
        label: "Stored workouts",
        periodLabel: "Current",
        used: storedWorkoutsUsed,
        limit: tier.limits.storedWorkouts,
        warning: warningForUsage(storedWorkoutsUsed, tier.limits.storedWorkouts),
        exceeded: exceededForUsage(storedWorkoutsUsed, tier.limits.storedWorkouts)
      }
    ];

    return {
      tierCode,
      periodKey,
      items: usageItems.map((item) => ({
        ...item,
        remaining: item.limit == null ? null : Math.max(0, item.limit - item.used)
      }))
    };
  }
}
