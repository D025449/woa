import { intensityTagBit, normalizeIntensityTags } from "./WorkoutIntensityTags.js";

const PROFILES = ["unknown", "recovery", "endurance", "tempo", "threshold", "vo2max", "anaerobic"];
const STRUCTURES = ["unknown", "steady", "variable", "intervals"];
const DOSES = ["unknown", "low", "moderate", "high"];

const MULTI_TAG_MARKER = 0x80;

function indexOfOrZero(values, value) {
  const index = values.indexOf(String(value || "unknown"));
  return index < 0 ? 0 : index;
}

export function writeWorkoutIntensityHeader(inputBytes, classification = {}) {
  const bytes = inputBytes instanceof Uint8Array ? inputBytes : new Uint8Array(inputBytes);
  if (bytes.byteLength < 24) throw new Error("WOA1 header is truncated");
  const profile = indexOfOrZero(PROFILES, classification.profile);
  const structure = indexOfOrZero(STRUCTURES, classification.structure);
  const dose = indexOfOrZero(DOSES, classification.dose);
  bytes[6] = MULTI_TAG_MARKER | profile | (structure << 3) | (dose << 5);
  const tags = normalizeIntensityTags(classification.tags) || intensityTagBit(classification.profile);
  const version = Math.max(0, Math.min(3, Math.floor(Number(classification.classifierVersion) || 0)));
  bytes[7] = tags | (version << 6);
  return bytes;
}

export function readWorkoutIntensityHeader(inputBytes) {
  const bytes = inputBytes instanceof Uint8Array ? inputBytes : new Uint8Array(inputBytes);
  if (bytes.byteLength < 24) throw new Error("WOA1 header is truncated");
  const flags = bytes[6];
  const profile = PROFILES[flags & 0x07] || "unknown";
  const hasMultiTagHeader = (flags & MULTI_TAG_MARKER) !== 0;
  return {
    profile,
    structure: STRUCTURES[(flags >> 3) & 0x03] || "unknown",
    dose: DOSES[(flags >> 5) & 0x03] || "unknown",
    tags: hasMultiTagHeader
      ? normalizeIntensityTags(bytes[7])
      : intensityTagBit(profile),
    classifierVersion: hasMultiTagHeader
      ? (bytes[7] >> 6) & 0x03
      : Number(bytes[7] || 0)
  };
}
