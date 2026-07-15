export function groupSegmentPersistenceItems(items = [], batchSize = 100) {
  const normalizedBatchSize = Math.max(1, Math.floor(Number(batchSize) || 100));
  const groups = [];
  let currentBatch = [];

  const flushBatch = () => {
    if (currentBatch.length > 0) {
      groups.push({ type: "batch", items: currentBatch });
      currentBatch = [];
    }
  };

  for (const item of Array.isArray(items) ? items : []) {
    const canBatch = !!item?.uid
      && Number.isInteger(Number(item?.workoutId))
      && item?.recomputeFromDb === true
      && !item?.payloadPath;

    const sameScope = currentBatch.length === 0
      || (
        String(currentBatch[0].uid) === String(item.uid)
        && String(currentBatch[0].importJobId ?? "") === String(item.importJobId ?? "")
      );

    if (!canBatch || !sameScope || currentBatch.length >= normalizedBatchSize) {
      flushBatch();
    }

    if (canBatch) {
      currentBatch.push(item);
    } else {
      groups.push({ type: "single", items: [item] });
    }
  }

  flushBatch();
  return groups;
}
