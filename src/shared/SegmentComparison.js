export const MAX_SEGMENT_COMPARISON_WORKOUTS = 3;
export const DEFAULT_SEGMENT_COMPARISON_POINTS = 600;

function finiteMetric(value) {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sampleIndices(start, end, maxPoints) {
  const pointCount = end - start + 1;
  const step = Math.max(1, Math.ceil((pointCount - 1) / (Math.max(2, maxPoints) - 1)));
  const indices = [];
  for (let index = start; index <= end; index += step) {
    indices.push(index);
  }
  if (indices.at(-1) !== end) indices.push(end);
  return indices;
}

export function buildSegmentComparisonProfile(
  workout,
  effort,
  segmentDistanceMeters,
  options = {}
) {
  const workoutObject = workout?.workoutObject ?? workout;
  const recordCount = Number(workoutObject?.length);
  if (!Number.isInteger(recordCount) || recordCount < 2) {
    throw new RangeError("Workout has no comparable records");
  }

  const startOffset = Math.max(0, Math.round(Number(effort?.start_offset)));
  const endOffset = Math.min(recordCount - 1, Math.round(Number(effort?.end_offset)));
  if (!Number.isFinite(startOffset) || !Number.isFinite(endOffset) || endOffset <= startOffset) {
    throw new RangeError("Invalid segment comparison range");
  }

  const officialDistance = Number(segmentDistanceMeters);
  const startDistance = finiteMetric(workoutObject.getDistanceAt?.(startOffset));
  const endDistance = finiteMetric(workoutObject.getDistanceAt?.(endOffset));
  const recordedDistance = startDistance != null && endDistance != null
    ? endDistance - startDistance
    : 0;
  const targetDistance = Number.isFinite(officialDistance) && officialDistance > 0
    ? officialDistance
    : recordedDistance;
  const canAlignByDistance = recordedDistance > 0 && targetDistance > 0;
  const maxPoints = Math.max(2, Math.floor(Number(options.maxPoints) || DEFAULT_SEGMENT_COMPARISON_POINTS));
  let previousDistance = 0;

  const points = sampleIndices(startOffset, endOffset, maxPoints).map((index) => {
    const recordedAtIndex = finiteMetric(workoutObject.getDistanceAt?.(index));
    const progress = canAlignByDistance && recordedAtIndex != null
      ? (recordedAtIndex - startDistance) / recordedDistance
      : (index - startOffset) / (endOffset - startOffset);
    const alignedDistance = Math.max(previousDistance, Math.min(targetDistance, Math.max(0, progress * targetDistance)));
    previousDistance = alignedDistance;

    return {
      distanceKm: alignedDistance / 1000,
      elapsedSeconds: index - startOffset,
      power: finiteMetric(workoutObject.getPowerAt?.(index)),
      heartRate: finiteMetric(workoutObject.getHrAt?.(index))
    };
  });

  return {
    workoutId: Number(effort?.wid ?? workout?.id),
    startOffset,
    endOffset,
    duration: endOffset - startOffset,
    distanceMeters: targetDistance,
    alignment: canAlignByDistance ? "distance" : "progress",
    points
  };
}
