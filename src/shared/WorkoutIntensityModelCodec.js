import { INTENSITY_EFFORT_DURATIONS } from "./WorkoutIntensityClassifier.js";

const MAGIC = [0x49, 0x46, 0x4d, 0x31]; // IFM1
export const INTENSITY_MODEL_FEATURE_BYTES = 4 + (INTENSITY_EFFORT_DURATIONS.length * 2);

export function encodeWorkoutIntensityModelFeatures(features = {}) {
  const bytes = new Uint8Array(INTENSITY_MODEL_FEATURE_BYTES);
  bytes.set(MAGIC, 0);
  const view = new DataView(bytes.buffer);
  INTENSITY_EFFORT_DURATIONS.forEach((duration, index) => {
    const power = Number(features.bestEfforts?.[duration]?.[0]?.avgPower || 0);
    view.setUint16(4 + (index * 2), Math.max(0, Math.min(0xffff, Math.round(power))), true);
  });
  return bytes;
}

export function decodeWorkoutIntensityModelFeatures(inputBytes) {
  const bytes = inputBytes instanceof Uint8Array ? inputBytes : new Uint8Array(inputBytes || 0);
  if (
    bytes.byteLength !== INTENSITY_MODEL_FEATURE_BYTES
    || MAGIC.some((value, index) => bytes[index] !== value)
  ) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bestEfforts = {};
  let hasPower = false;
  INTENSITY_EFFORT_DURATIONS.forEach((duration, index) => {
    const avgPower = view.getUint16(4 + (index * 2), true);
    bestEfforts[duration] = avgPower > 0 ? [{ duration, avgPower }] : [];
    hasPower ||= avgPower > 0;
  });
  return {
    positivePowerSeconds: hasPower ? 1 : 0,
    bestEfforts
  };
}
