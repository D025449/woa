import pool from "./database.js";

const WORKOUT_LIBRARY_VIEW_KEY = "workout-library";
const ANALYTICS_VIEW_KEY = "analytics";
const WORKOUT_LIBRARY_SORTS = new Set([
  "newest",
  "oldest",
  "uploaded",
  "distance",
  "duration",
  "calories",
  "powerload",
  "power",
  "np"
]);
const WORKOUT_LIBRARY_SCOPES = new Set(["mine", "shared", "all"]);
const ACTIVITY_TYPES = new Set(["all", "cycling", "strength_training", "mobility", "other"]);
const WORKOUT_TYPES = new Set(["all", "indoor", "road", "mountain", "motorsport", "unknown"]);
const TERRAIN_PROFILES = new Set(["all", "flat", "rolling", "mountainous", "altitude_missing", "altitude_invalid"]);
const INTENSITY_PROFILES = new Set(["all", "recovery", "endurance", "tempo", "threshold", "vo2max", "anaerobic", "unknown"]);
const GPS_FILTERS = new Set(["all", "valid", "invalid"]);
const CHART_X_AXIS_MODES = new Set(["time", "distance"]);
const CHART_SMOOTHING_LEVELS = new Set([
  "automatic",
  "off",
  "light",
  "medium",
  "strong",
  "veryStrong"
]);
const CHART_SERIES_VISIBILITY_KEYS = [
  "power",
  "heartRate",
  "cadence",
  "speed",
  "altitude",
  "leftRightBalance"
];
const SEGMENT_VISIBILITY_KEYS = [
  "criticalPower",
  "auto",
  "manual",
  "gps"
];
const ANALYTICS_SHARED_GROUPINGS = new Set(["week", "month", "quarter", "year"]);
const ANALYTICS_LOAD_GROUPINGS = new Set(["date", "week", "month", "quarter", "year"]);
const ANALYTICS_POWER_GROUPINGS = new Set([
  "year_week",
  "year_month",
  "year_quarter",
  "year"
]);
const ANALYTICS_LOAD_SERIES_KEYS = ["atl", "ctl", "tsb", "tss", "intensityDistribution"];
const ANALYTICS_POWER_SERIES_KEYS = [
  "cp5",
  "cp15",
  "cp60",
  "cp120",
  "cp240",
  "cp360",
  "cp480",
  "cp720",
  "cp900",
  "cp960",
  "cp1800",
  "eftp"
];
const ANALYTICS_TIME_RANGE_MODES = new Set(["all", "custom"]);

function normalizeEnum(value, allowed, fallback) {
  const normalized = String(value ?? "").trim();
  return allowed.has(normalized) ? normalized : fallback;
}

export function normalizeWorkoutLibraryState(state = {}) {
  /** @type {Record<string, any>} */
  const source = state && typeof state === "object" && !Array.isArray(state)
    ? state
    : {};

  const normalized = {
    search: String(source.search ?? "").slice(0, 300),
    sort: normalizeEnum(source.sort, WORKOUT_LIBRARY_SORTS, "newest"),
    scope: normalizeEnum(source.scope, WORKOUT_LIBRARY_SCOPES, "mine"),
    favoritesOnly: source.favoritesOnly === true,
    activityType: normalizeEnum(source.activityType, ACTIVITY_TYPES, "all"),
    workoutType: normalizeEnum(source.workoutType, WORKOUT_TYPES, "all"),
    terrainProfile: normalizeEnum(source.terrainProfile, TERRAIN_PROFILES, "all"),
    intensityProfile: normalizeEnum(source.intensityProfile, INTENSITY_PROFILES, "all"),
    gpsFilter: normalizeEnum(source.gpsFilter, GPS_FILTERS, "all")
  };

  if (
    source.seriesVisibility
    && typeof source.seriesVisibility === "object"
    && !Array.isArray(source.seriesVisibility)
  ) {
    normalized.seriesVisibility = Object.fromEntries(
      CHART_SERIES_VISIBILITY_KEYS.map((key) => [
        key,
        source.seriesVisibility[key] !== false
      ])
    );
  }

  if (CHART_X_AXIS_MODES.has(source.xAxisMode)) {
    normalized.xAxisMode = source.xAxisMode;
  }

  if (CHART_SMOOTHING_LEVELS.has(source.smoothingLevel)) {
    normalized.smoothingLevel = source.smoothingLevel;
  }

  if (typeof source.bridgePowerCadenceZeros === "boolean") {
    normalized.bridgePowerCadenceZeros = source.bridgePowerCadenceZeros;
  }

  if (
    source.segmentVisibility
    && typeof source.segmentVisibility === "object"
    && !Array.isArray(source.segmentVisibility)
  ) {
    normalized.segmentVisibility = Object.fromEntries(
      SEGMENT_VISIBILITY_KEYS.map((key) => [
        key,
        source.segmentVisibility[key] !== false
      ])
    );
  }

  return normalized;
}

function normalizeSeriesVisibility(value, keys) {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};

  return Object.fromEntries(keys.map((key) => [key, source[key] !== false]));
}

function normalizeAnalyticsTimeRange(value) {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
  const mode = normalizeEnum(source.mode, ANALYTICS_TIME_RANGE_MODES, "all");
  const datePattern = /^\d{4}-\d{2}-\d{2}$/u;
  const start = String(source.start ?? "");
  const end = String(source.end ?? "");
  const isIsoDate = (date) => datePattern.test(date)
    && Number.isFinite(Date.parse(date))
    && new Date(Date.parse(date)).toISOString().slice(0, 10) === date;

  if (
    mode === "custom"
    && isIsoDate(start)
    && isIsoDate(end)
    && start <= end
  ) {
    return { mode, start, end };
  }

  return { mode: mode === "custom" ? "all" : mode };
}

export function normalizeAnalyticsState(state = {}) {
  /** @type {Record<string, any>} */
  const source = state && typeof state === "object" && !Array.isArray(state)
    ? state
    : {};
  const loadModel = source.loadModel && typeof source.loadModel === "object"
    && !Array.isArray(source.loadModel)
    ? source.loadModel
    : {};
  const powerCurve = source.powerCurve && typeof source.powerCurve === "object"
    && !Array.isArray(source.powerCurve)
    ? source.powerCurve
    : {};

  return {
    timeRange: normalizeAnalyticsTimeRange(source.timeRange),
    grouping: normalizeEnum(source.grouping, ANALYTICS_SHARED_GROUPINGS, "month"),
    loadModel: {
      grouping: normalizeEnum(loadModel.grouping, ANALYTICS_LOAD_GROUPINGS, "date"),
      seriesVisibility: normalizeSeriesVisibility(
        loadModel.seriesVisibility,
        ANALYTICS_LOAD_SERIES_KEYS
      )
    },
    powerCurve: {
      grouping: normalizeEnum(powerCurve.grouping, ANALYTICS_POWER_GROUPINGS, "year"),
      seriesVisibility: normalizeSeriesVisibility(
        powerCurve.seriesVisibility,
        ANALYTICS_POWER_SERIES_KEYS
      )
    }
  };
}

function normalizeViewState(viewKey, state) {
  if (viewKey === WORKOUT_LIBRARY_VIEW_KEY) {
    return normalizeWorkoutLibraryState(state);
  }

  if (viewKey === ANALYTICS_VIEW_KEY) {
    return normalizeAnalyticsState(state);
  }

  const error = new Error("Unsupported view preference key");
  error.statusCode = 400;
  throw error;
}

export default class ViewPreferenceService {
  static WORKOUT_LIBRARY_VIEW_KEY = WORKOUT_LIBRARY_VIEW_KEY;
  static ANALYTICS_VIEW_KEY = ANALYTICS_VIEW_KEY;

  static async get(uid, viewKey, db = pool) {
    normalizeViewState(viewKey, {});
    const result = await db.query(`
      SELECT
        view_key AS "viewKey",
        state,
        version,
        updated_at AS "updatedAt"
      FROM user_view_preferences
      WHERE uid = $1
        AND view_key = $2
    `, [uid, viewKey]);

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return {
      ...row,
      state: normalizeViewState(viewKey, row.state)
    };
  }

  static async upsert(uid, viewKey, state, db = pool) {
    const normalizedState = normalizeViewState(viewKey, state);
    const result = await db.query(`
      INSERT INTO user_view_preferences (
        uid,
        view_key,
        state,
        version
      )
      VALUES ($1, $2, $3::jsonb, 1)
      ON CONFLICT (uid, view_key)
      DO UPDATE SET
        state = EXCLUDED.state,
        version = EXCLUDED.version,
        updated_at = NOW()
      RETURNING
        view_key AS "viewKey",
        state,
        version,
        updated_at AS "updatedAt"
    `, [uid, viewKey, JSON.stringify(normalizedState)]);

    return result.rows[0] || null;
  }
}
