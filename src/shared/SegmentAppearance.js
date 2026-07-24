export const WORKOUT_ROUTE_COLOR = "#ff4d4f";
export const WORKOUT_ROUTE_THUMBNAIL_STYLE_VERSION = "2";

export const SEGMENT_COLORS = Object.freeze({
  criticalPower: Object.freeze({
    solid: "#f59e0b",
    area: "rgba(245, 158, 11, 0.24)"
  }),
  auto: Object.freeze({
    solid: "#2587df",
    area: "rgba(37, 135, 223, 0.26)"
  }),
  manual: Object.freeze({
    solid: "#ef4444",
    area: "rgba(239, 68, 68, 0.24)"
  }),
  gps: Object.freeze({
    solid: "#22a957",
    area: "rgba(34, 169, 87, 0.25)"
  })
});

export function getSegmentVisibilityKey(segment) {
  if (segment?.isGPSSegment || segment?.segmenttype === "gps") {
    return "gps";
  }

  if (segment?.segmenttype === "crit") {
    return "criticalPower";
  }

  if (segment?.segmenttype === "auto") {
    return "auto";
  }

  return "manual";
}

export function getSegmentColor(segment, variant = "solid") {
  const colors = SEGMENT_COLORS[getSegmentVisibilityKey(segment)] || SEGMENT_COLORS.manual;
  return colors[variant] || colors.solid;
}
