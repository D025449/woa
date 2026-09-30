// Keep the full workout intact for other views and for subsequent legend changes.
export function filterAnalyticsWorkoutSegments(workout, visibleDurations) {
  const durations = new Set(visibleDurations.map(Number));
  return {
    ...workout,
    segments: (workout.segments || []).filter((segment) => (
      segment.segmenttype === "crit"
      && !segment.isGPSSegment
      && durations.has(Number(segment.duration))
    ))
  };
}
