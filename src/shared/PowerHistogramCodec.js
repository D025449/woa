const MAGIC = [0x50, 0x48, 0x44, 0x31]; // PHD1

export const DEFAULT_POWER_HISTOGRAM_BIN_WIDTH_WATTS = 5;

function writeVarUint(target, value) {
  let remaining = Math.max(0, Math.floor(Number(value) || 0));
  do {
    let byte = remaining % 128;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) byte |= 0x80;
    target.push(byte);
  } while (remaining > 0);
}

function readVarUint(bytes, state) {
  let value = 0;
  let multiplier = 1;
  for (let count = 0; count < 5; count += 1) {
    if (state.offset >= bytes.byteLength) throw new Error("Power histogram is truncated");
    const byte = bytes[state.offset++];
    value += (byte & 0x7f) * multiplier;
    if ((byte & 0x80) === 0) return value;
    multiplier *= 128;
  }
  throw new Error("Power histogram varint exceeds uint32");
}

/**
 * @param {{
 *   totalSeconds?: number,
 *   zeroSeconds?: number,
 *   missingSeconds?: number,
 *   bins?: Iterable<[number, number]>,
 *   binWidthWatts?: number
 * }} [options]
 */
export function encodePowerHistogramBins({
  totalSeconds,
  zeroSeconds = 0,
  missingSeconds = 0,
  bins = [],
  binWidthWatts = DEFAULT_POWER_HISTOGRAM_BIN_WIDTH_WATTS
} = {}) {
  const binWidth = Math.max(1, Math.min(255, Math.floor(Number(binWidthWatts) || 0)));
  const occupiedBins = Array.from(bins, ([binIndex, seconds]) => ({
    binIndex: Math.max(0, Math.floor(Number(binIndex) || 0)),
    seconds: Math.max(0, Math.floor(Number(seconds) || 0))
  }))
    .filter((entry) => entry.seconds > 0)
    .sort((left, right) => left.binIndex - right.binIndex);
  if (occupiedBins.length === 0) return null;

  const bytes = [...MAGIC, binWidth];
  writeVarUint(bytes, totalSeconds);
  writeVarUint(bytes, zeroSeconds);
  writeVarUint(bytes, missingSeconds);
  writeVarUint(bytes, occupiedBins.length);

  let previousBin = 0;
  occupiedBins.forEach(({ binIndex, seconds }, index) => {
    writeVarUint(bytes, index === 0 ? binIndex : binIndex - previousBin);
    writeVarUint(bytes, seconds);
    previousBin = binIndex;
  });
  return Uint8Array.from(bytes);
}

/**
 * @param {{
 *   recordCount?: number,
 *   powerAtIndex?: (index: number) => number,
 *   powers?: ArrayLike<number>,
 *   missingValue?: number,
 *   binWidthWatts?: number,
 *   sampleDurationSeconds?: number
 * }} [options]
 */
export function encodePowerHistogram({
  recordCount,
  powerAtIndex,
  powers,
  missingValue = 0xffff,
  binWidthWatts = DEFAULT_POWER_HISTOGRAM_BIN_WIDTH_WATTS,
  sampleDurationSeconds = 1
} = {}) {
  const count = Math.max(0, Math.floor(Number(recordCount ?? powers?.length) || 0));
  const binWidth = Math.max(1, Math.min(255, Math.floor(Number(binWidthWatts) || 0)));
  const sampleDuration = Math.max(1, Math.floor(Number(sampleDurationSeconds) || 0));
  const readPower = typeof powerAtIndex === "function"
    ? powerAtIndex
    : (index) => powers?.[index];
  const bins = new Map();
  let zeroSeconds = 0;
  let missingSeconds = 0;

  for (let index = 0; index < count; index += 1) {
    const power = Number(readPower(index));
    if (!Number.isFinite(power) || power === missingValue || power < 0) {
      missingSeconds += sampleDuration;
      continue;
    }
    if (power === 0) {
      zeroSeconds += sampleDuration;
      continue;
    }
    const binIndex = Math.floor((power - 1) / binWidth);
    bins.set(binIndex, (bins.get(binIndex) || 0) + sampleDuration);
  }

  return encodePowerHistogramBins({
    totalSeconds: count * sampleDuration,
    zeroSeconds,
    missingSeconds,
    bins,
    binWidthWatts: binWidth
  });
}

function readPowerHistogram(inputBytes, visitBin = null, collectBins = false) {
  const bytes = inputBytes instanceof Uint8Array
    ? inputBytes
    : new Uint8Array(inputBytes || 0);
  if (bytes.byteLength < MAGIC.length + 5) return null;
  if (MAGIC.some((value, index) => bytes[index] !== value)) return null;

  const state = { offset: MAGIC.length };
  const binWidthWatts = bytes[state.offset++];
  if (binWidthWatts < 1) throw new Error("Power histogram bin width is invalid");
  const totalSeconds = readVarUint(bytes, state);
  const zeroSeconds = readVarUint(bytes, state);
  const missingSeconds = readVarUint(bytes, state);
  const binCount = readVarUint(bytes, state);
  const bins = collectBins ? [] : null;
  let binIndex = 0;
  let positiveSeconds = 0;

  for (let index = 0; index < binCount; index += 1) {
    const delta = readVarUint(bytes, state);
    if (index > 0 && delta === 0) throw new Error("Power histogram bins are not strictly increasing");
    binIndex = index === 0 ? delta : binIndex + delta;
    const seconds = readVarUint(bytes, state);
    if (seconds < 1) throw new Error("Power histogram contains an empty bin");
    positiveSeconds += seconds;
    visitBin?.(binIndex, binWidthWatts, seconds);
    bins?.push({
      binIndex,
      minWatts: (binIndex * binWidthWatts) + 1,
      maxWatts: (binIndex + 1) * binWidthWatts,
      seconds
    });
  }

  if (state.offset !== bytes.byteLength) throw new Error("Power histogram has trailing bytes");
  if (zeroSeconds + missingSeconds + positiveSeconds !== totalSeconds) {
    throw new Error("Power histogram duration totals do not match");
  }
  return {
    format: "PHD1",
    binWidthWatts,
    totalSeconds,
    zeroSeconds,
    missingSeconds,
    positiveSeconds,
    ...(bins ? { bins } : {})
  };
}

export function scanPowerHistogram(inputBytes, visitBin) {
  return readPowerHistogram(inputBytes, visitBin, false);
}

export function decodePowerHistogram(inputBytes) {
  return readPowerHistogram(inputBytes, null, true);
}
