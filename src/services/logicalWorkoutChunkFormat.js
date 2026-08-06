export const LOGICAL_WORKOUT_CHUNK_SIZE = 100;
export const LOGICAL_WORKOUT_CHUNK_FORMAT = "cwa24-logical-workout-chunks";
export const LOGICAL_WORKOUT_CHUNK_VERSION = 1;

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export function buildLogicalWorkoutChunkCollection(chunks) {
  return {
    format: LOGICAL_WORKOUT_CHUNK_FORMAT,
    version: LOGICAL_WORKOUT_CHUNK_VERSION,
    chunkSize: LOGICAL_WORKOUT_CHUNK_SIZE,
    chunks
  };
}

export function validateLogicalWorkoutChunkCollection(collection, source) {
  const label = String(source || "workout").toUpperCase();
  if (collection?.format !== LOGICAL_WORKOUT_CHUNK_FORMAT
    || Number(collection?.version) !== LOGICAL_WORKOUT_CHUNK_VERSION
    || Number(collection?.chunkSize) !== LOGICAL_WORKOUT_CHUNK_SIZE
    || !Array.isArray(collection?.chunks)) {
    throw Object.assign(new Error(`Backup has no valid ${label} workout chunks.`), { statusCode: 400 });
  }
  const chunks = new Map();
  for (const descriptor of collection.chunks) {
    const index = Number(descriptor?.index);
    const workoutCount = Number(descriptor?.workoutCount);
    if (!Number.isInteger(index) || index < 0 || chunks.has(index)
      || !Number.isInteger(workoutCount) || workoutCount < 1 || workoutCount > LOGICAL_WORKOUT_CHUNK_SIZE
      || !String(descriptor?.key || "")
      || !Number.isInteger(Number(descriptor?.sizeBytes)) || Number(descriptor.sizeBytes) < 1
      || !SHA256_PATTERN.test(String(descriptor?.sha256 || ""))) {
      throw new Error(`Invalid ${label} workout chunk descriptor.`);
    }
    chunks.set(index, descriptor);
  }
  return chunks;
}

export function validateLogicalWorkoutChunkIndex(indexPayload, chunks) {
  const rows = Array.isArray(indexPayload?.workouts) ? indexPayload.workouts : [];
  if (rows.length !== Number(indexPayload?.workoutCount)) {
    throw new Error("Logical workout index count does not match its manifest.");
  }
  const countsByChunk = new Map();
  const identities = new Set();
  for (const row of rows) {
    const ownerIndex = Number(row?.[0]);
    const sourceId = row?.[3] == null ? "" : String(row[3]);
    const chunkIndex = Number(row?.[4]);
    const identity = `${ownerIndex}:${sourceId}`;
    if (!Number.isInteger(ownerIndex) || ownerIndex < 0 || ownerIndex >= (indexPayload.owners?.length || 0)
      || !sourceId || !Number.isInteger(chunkIndex) || !chunks.has(chunkIndex) || identities.has(identity)) {
      throw new Error("Logical workout index contains an invalid source or chunk mapping.");
    }
    identities.add(identity);
    countsByChunk.set(chunkIndex, (countsByChunk.get(chunkIndex) || 0) + 1);
  }
  if (chunks.size !== countsByChunk.size) {
    throw new Error("Logical workout index does not reference every declared chunk.");
  }
  for (const [chunkIndex, descriptor] of chunks) {
    if ((countsByChunk.get(chunkIndex) || 0) !== Number(descriptor.workoutCount)) {
      throw new Error(`Logical workout count does not match chunk ${chunkIndex}.`);
    }
  }
  return indexPayload;
}
