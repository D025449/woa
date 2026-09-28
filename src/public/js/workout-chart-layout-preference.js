export const WORKOUT_CHART_LAYOUT_STORAGE_KEY = "woaWorkoutChartLayoutMode";

const VALID_LAYOUT_MODES = new Set(["overlay", "bands"]);

export function normalizeWorkoutChartLayoutMode(value, fallback = null) {
  return VALID_LAYOUT_MODES.has(value) ? value : fallback;
}

function getLocalStorage() {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

export function readWorkoutChartLayoutMode(storage = getLocalStorage()) {
  try {
    return normalizeWorkoutChartLayoutMode(storage?.getItem(WORKOUT_CHART_LAYOUT_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function writeWorkoutChartLayoutMode(mode, storage = getLocalStorage()) {
  const normalizedMode = normalizeWorkoutChartLayoutMode(mode);
  if (!normalizedMode) return null;

  try {
    storage?.setItem(WORKOUT_CHART_LAYOUT_STORAGE_KEY, normalizedMode);
  } catch {
    // Browser storage can be unavailable (for example in private or restricted contexts).
  }
  return normalizedMode;
}
