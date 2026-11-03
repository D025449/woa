export function excludeTimeConflictWorkouts(decoded, skipped = []) {
  const conflictStartTimes = new Set(skipped
    .filter((entry) => entry.code === "workout_time_conflict" && entry.startTime)
    .map((entry) => Math.round(new Date(entry.startTime).getTime() / 1000)));
  if (conflictStartTimes.size === 0) return decoded;

  const workouts = decoded.workouts.filter((workout) => !conflictStartTimes.has(workout.startTimeSec));
  if (workouts.length === decoded.workouts.length) return decoded;

  const result = { ...decoded, workouts, workoutCount: workouts.length };
  if ("segmentCount" in decoded) {
    result.segmentCount = workouts.reduce((count, workout) => count + workout.segments.length, 0);
  }
  if ("matchCount" in decoded) {
    result.matchCount = workouts.reduce((count, workout) => count + workout.matches.length, 0);
  }
  return result;
}