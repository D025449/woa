export function groupWorkoutSegmentBestEffortItems(items = [], batchSize = 100) {
  const normalizedBatchSize = Math.max(1, Math.floor(Number(batchSize) || 100));
  const groups = [];
  let currentBatch = [];

  const flushBatch = () => {
    if (currentBatch.length > 0) {
      groups.push(currentBatch);
      currentBatch = [];
    }
  };

  for (const item of Array.isArray(items) ? items : []) {
    if (!item?.uid || !Number.isInteger(Number(item?.workoutId))) {
      continue;
    }
    const sameScope = currentBatch.length === 0
      || (
        String(currentBatch[0].uid) === String(item.uid)
        && String(currentBatch[0].importJobId ?? "") === String(item.importJobId ?? "")
      );
    if (!sameScope || currentBatch.length >= normalizedBatchSize) {
      flushBatch();
    }
    currentBatch.push(item);
  }

  flushBatch();
  return groups;
}
