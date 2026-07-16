const HEADER_BYTES = 24;
const WORKOUT_BYTES = 12;
const MATCH_BYTES = 18;
const textEncoder = new TextEncoder();

function uint(value, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(max, Math.round(numeric)));
}

export function encodeBrowserGpsBestEffortsTransport(workouts = []) {
  const normalized = Array.isArray(workouts) ? workouts : [];
  if (normalized.length > 0xffffffff) throw new Error("Too many GBE1 workouts");
  for (const workout of normalized) {
    if ((Array.isArray(workout?.matches) ? workout.matches.length : 0) > 0xffff) {
      throw new Error("Too many GBE1 matches for one workout");
    }
  }
  const matchCount = normalized.reduce((sum, workout) => sum + (Array.isArray(workout?.matches) ? workout.matches.length : 0), 0);
  if (matchCount > 0xffffffff) throw new Error("Too many GBE1 matches");
  const matchStart = HEADER_BYTES + normalized.length * WORKOUT_BYTES;
  const bytes = new Uint8Array(matchStart + matchCount * MATCH_BYTES);
  const view = new DataView(bytes.buffer);
  bytes.set(textEncoder.encode("GBE1"), 0);
  view.setUint16(4, 1, true);
  view.setUint32(8, normalized.length, true);
  view.setUint32(12, matchCount, true);
  view.setUint32(16, HEADER_BYTES, true);
  view.setUint32(20, matchStart, true);

  let workoutOffset = HEADER_BYTES;
  let firstMatch = 0;
  for (const workout of normalized) {
    const matches = Array.isArray(workout?.matches) ? workout.matches : [];
    view.setUint32(workoutOffset, uint(workout?.startTimeSec, 0xfffffffe), true);
    view.setUint32(workoutOffset + 4, firstMatch, true);
    view.setUint16(workoutOffset + 8, uint(matches.length, 0xffff), true);
    workoutOffset += WORKOUT_BYTES;
    firstMatch += matches.length;
  }

  const segmentIdOffset = matchStart;
  const startOffset = segmentIdOffset + matchCount * 4;
  const endOffset = startOffset + matchCount * 4;
  const powerOffset = endOffset + matchCount * 4;
  const heartRateOffset = powerOffset + matchCount * 2;
  const cadenceOffset = heartRateOffset + matchCount;
  const speedOffset = cadenceOffset + matchCount;
  let index = 0;
  for (const workout of normalized) {
    for (const match of workout.matches || []) {
      view.setUint32(segmentIdOffset + index * 4, uint(match.segmentId, 0xfffffffe), true);
      view.setUint32(startOffset + index * 4, uint(match.startOffset, 0xfffffffe), true);
      view.setUint32(endOffset + index * 4, uint(match.endOffset, 0xfffffffe), true);
      view.setUint16(powerOffset + index * 2, uint(match.avgPower, 0xfffe), true);
      view.setUint8(heartRateOffset + index, uint(match.avgHeartRate, 0xfe));
      view.setUint8(cadenceOffset + index, uint(match.avgCadence, 0xfe));
      view.setUint16(speedOffset + index * 2, uint(Number(match.avgSpeed || 0) * 10, 0xfffe), true);
      index += 1;
    }
  }
  return bytes;
}

export function decodeBrowserGpsBestEffortsTransport(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < HEADER_BYTES || String.fromCharCode(...bytes.subarray(0, 4)) !== "GBE1") throw new Error("Invalid GBE1 transport");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(4, true);
  const workoutCount = view.getUint32(8, true);
  const matchCount = view.getUint32(12, true);
  const workoutStart = view.getUint32(16, true);
  const matchStart = view.getUint32(20, true);
  if (version !== 1 || workoutStart !== HEADER_BYTES || matchStart !== HEADER_BYTES + workoutCount * WORKOUT_BYTES || matchStart + matchCount * MATCH_BYTES !== bytes.byteLength) {
    throw new Error("Corrupt GBE1 layout");
  }
  const segmentIdOffset = matchStart;
  const startOffset = segmentIdOffset + matchCount * 4;
  const endOffset = startOffset + matchCount * 4;
  const powerOffset = endOffset + matchCount * 4;
  const heartRateOffset = powerOffset + matchCount * 2;
  const cadenceOffset = heartRateOffset + matchCount;
  const speedOffset = cadenceOffset + matchCount;
  const matches = Array.from({ length: matchCount }, (_, index) => ({
    segmentId: view.getUint32(segmentIdOffset + index * 4, true),
    startOffset: view.getUint32(startOffset + index * 4, true),
    endOffset: view.getUint32(endOffset + index * 4, true),
    avgPower: view.getUint16(powerOffset + index * 2, true),
    avgHeartRate: view.getUint8(heartRateOffset + index),
    avgCadence: view.getUint8(cadenceOffset + index),
    avgSpeed: view.getUint16(speedOffset + index * 2, true) / 10
  }));
  let expectedFirstMatch = 0;
  const workouts = Array.from({ length: workoutCount }, (_, index) => {
    const offset = workoutStart + index * WORKOUT_BYTES;
    const firstMatch = view.getUint32(offset + 4, true);
    const count = view.getUint16(offset + 8, true);
    if (firstMatch !== expectedFirstMatch || firstMatch + count > matches.length) throw new Error("Corrupt GBE1 workout range");
    expectedFirstMatch += count;
    return { startTimeSec: view.getUint32(offset, true), matches: matches.slice(firstMatch, firstMatch + count) };
  });
  if (expectedFirstMatch !== matchCount) throw new Error("Corrupt GBE1 match coverage");
  return { version, workoutCount, matchCount, byteLength: bytes.byteLength, workouts };
}
