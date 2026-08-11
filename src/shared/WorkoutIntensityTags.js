export const INTENSITY_TAG_BITS = Object.freeze({
  recovery: 1 << 0,
  endurance: 1 << 1,
  tempo: 1 << 2,
  threshold: 1 << 3,
  vo2max: 1 << 4,
  anaerobic: 1 << 5
});

export const INTENSITY_TAG_MASK = Object.values(INTENSITY_TAG_BITS)
  .reduce((mask, bit) => mask | bit, 0);

export function intensityTagBit(profile) {
  return INTENSITY_TAG_BITS[String(profile || "")] || 0;
}

export function normalizeIntensityTags(value) {
  return Math.max(0, Math.floor(Number(value) || 0)) & INTENSITY_TAG_MASK;
}

export function buildIntensityTags(profiles = []) {
  return profiles.reduce((mask, profile) => mask | intensityTagBit(profile), 0);
}
