import {
  SEGMENT_COLORS,
  WORKOUT_ROUTE_COLOR,
  getSegmentColor,
  getSegmentVisibilityKey
} from "../../shared/SegmentAppearance.js";

export {
  SEGMENT_COLORS,
  WORKOUT_ROUTE_COLOR,
  getSegmentColor,
  getSegmentVisibilityKey
};

export const DEFAULT_SEGMENT_VISIBILITY = Object.freeze({
  criticalPower: true,
  auto: true,
  manual: true,
  gps: true
});

export function isSegmentVisible(segment, visibility = DEFAULT_SEGMENT_VISIBILITY) {
  if (!segment) {
    return false;
  }

  return visibility?.[getSegmentVisibilityKey(segment)] !== false;
}
