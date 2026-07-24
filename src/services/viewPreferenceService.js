import pool from "./database.js";

const WORKOUT_LIBRARY_VIEW_KEY = "workout-library";
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
const WORKOUT_TYPES = new Set(["all", "indoor", "road", "mountain", "unknown"]);
const GPS_FILTERS = new Set(["all", "valid", "invalid"]);

function normalizeEnum(value, allowed, fallback) {
  const normalized = String(value ?? "").trim();
  return allowed.has(normalized) ? normalized : fallback;
}

export function normalizeWorkoutLibraryState(state = {}) {
  const source = state && typeof state === "object" && !Array.isArray(state)
    ? state
    : {};

  return {
    search: String(source.search ?? "").slice(0, 300),
    sort: normalizeEnum(source.sort, WORKOUT_LIBRARY_SORTS, "newest"),
    scope: normalizeEnum(source.scope, WORKOUT_LIBRARY_SCOPES, "mine"),
    favoritesOnly: source.favoritesOnly === true,
    workoutType: normalizeEnum(source.workoutType, WORKOUT_TYPES, "all"),
    gpsFilter: normalizeEnum(source.gpsFilter, GPS_FILTERS, "all")
  };
}

function normalizeViewState(viewKey, state) {
  if (viewKey === WORKOUT_LIBRARY_VIEW_KEY) {
    return normalizeWorkoutLibraryState(state);
  }

  const error = new Error("Unsupported view preference key");
  error.statusCode = 400;
  throw error;
}

export default class ViewPreferenceService {
  static WORKOUT_LIBRARY_VIEW_KEY = WORKOUT_LIBRARY_VIEW_KEY;

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
