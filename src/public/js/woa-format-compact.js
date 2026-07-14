import { DEFAULT_GPS_SAMPLE_RATE_SECONDS, normalizeGpsSampleRateSeconds } from "../../shared/gpsSampling.js";

const textEncoder = new TextEncoder();
const UINT8_NAN = 0xFF;
const UINT16_NAN = 0xFFFF;
const UINT32_NAN = 0xFFFFFFFF;
const INT16_NAN = -0x8000;
const INT32_NAN = -0x80000000;
const DISTANCE_ENCODING_DEFAULT = "default";
const DISTANCE_ENCODING_UINT8_Q05M = "uint8-q05m";
const DISTANCE_ENCODING_UINT8_Q02_LEGACY = "uint8-q02";
const MICRO_DEGREES = 1e6;
const GPS_TRACK_COORDINATE_SCALE = 1e5;
const GPS_DELTA_ESCAPE = -0x8000;
const GPS_TIERED_INT16_MARKER = 126;
const GPS_TIERED_EXTENDED_MARKER = 127;
const GPS_TIERED_MISSING_SUBTYPE = 0;
const GPS_TIERED_ABSOLUTE_SUBTYPE = 1;
const DELTA_BLOCK_SIZE = 128;
const DEFAULT_DISTANCE_BLOCK_SIZE = 999999;
const DEFAULT_GPS_BLOCK_SIZE = 999999;
const DEFAULT_STREAM_CODEC = "gzip";
const DEFAULT_GPS_TRACK_CODEC = "gzip";
const DEFAULT_STREAM_GZIP_LEVEL = 4;
const DEFAULT_GPS_GZIP_LEVEL = 4;
const SESSION_BLOCK_VERSION = 1;
const SESSION_TIME_SCALE = 100;
const SESSION_DISTANCE_SCALE = 10;
const SESSION_ASCENT_SCALE = 10;
const SESSION_SPEED_SCALE = 100;
const SESSION_COORD_SCALE = 1e7;
const SESSION_SPEC = [
  { key: "timestamp", type: "time" },
  { key: "start_time", type: "time" },
  { key: "total_elapsed_time", type: "scaled-uint32", scale: SESSION_TIME_SCALE },
  { key: "total_timer_time", type: "scaled-uint32", scale: SESSION_TIME_SCALE },
  { key: "total_distance", type: "scaled-uint32", scale: SESSION_DISTANCE_SCALE },
  { key: "total_cycles", type: "uint32" },
  { key: "total_work", type: "uint32" },
  { key: "total_calories", type: "uint32" },
  { key: "total_ascent", type: "scaled-uint32", scale: SESSION_ASCENT_SCALE },
  { key: "total_descent", type: "scaled-uint32", scale: SESSION_ASCENT_SCALE },
  { key: "avg_speed", type: "scaled-uint16", scale: SESSION_SPEED_SCALE },
  { key: "avg_power", type: "uint16" },
  { key: "avg_heart_rate", type: "uint8" },
  { key: "avg_cadence", type: "uint8" },
  { key: "normalized_power", type: "uint16" },
  { key: "max_speed", type: "scaled-uint16", scale: SESSION_SPEED_SCALE },
  { key: "max_power", type: "uint16" },
  { key: "max_heart_rate", type: "uint8" },
  { key: "max_cadence", type: "uint8" },
  { key: "nec_lat", type: "coord" },
  { key: "nec_long", type: "coord" },
  { key: "swc_lat", type: "coord" },
  { key: "swc_long", type: "coord" },
  { key: "woa_manual_gps", type: "bool" }
];

function nowMs() {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function getCompactTimestampSecAt(compactRecords, index) {
  const timestampSec = Number(compactRecords?.timestampsSec?.[index]);
  return Number.isFinite(timestampSec) && timestampSec !== UINT32_NAN
    ? timestampSec
    : Number.NaN;
}

function getCompactTimestampMsAt(compactRecords, index) {
  const timestampSec = getCompactTimestampSecAt(compactRecords, index);
  return Number.isFinite(timestampSec) ? timestampSec * 1000 : Number.NaN;
}

function getCompactBaseTimestampSec(compactRecords, recordCount) {
  const explicitBaseTimestampSec = Number(compactRecords?.baseTimestampSec);
  if (Number.isFinite(explicitBaseTimestampSec) && explicitBaseTimestampSec !== UINT32_NAN) {
    return Math.round(explicitBaseTimestampSec);
  }
  if (!(recordCount > 0)) {
    return 0;
  }
  const timestampSec = getCompactTimestampSecAt(compactRecords, 0);
  return Number.isFinite(timestampSec) ? Math.round(timestampSec) : 0;
}

function getCompactLastTimestampSec(compactRecords, recordCount) {
  const explicitLastTimestampSec = Number(compactRecords?.lastTimestampSec);
  if (Number.isFinite(explicitLastTimestampSec) && explicitLastTimestampSec !== UINT32_NAN) {
    return Math.round(explicitLastTimestampSec);
  }
  if (!(recordCount > 0)) {
    return 0;
  }
  const timestampSec = getCompactTimestampSecAt(compactRecords, recordCount - 1);
  return Number.isFinite(timestampSec) ? Math.round(timestampSec) : 0;
}

function getCompactBaseTimestampMs(compactRecords, recordCount) {
  return getCompactBaseTimestampSec(compactRecords, recordCount) * 1000;
}

function getCompactLastTimestampMs(compactRecords, recordCount) {
  return getCompactLastTimestampSec(compactRecords, recordCount) * 1000;
}

function encodeJson(value) {
  return textEncoder.encode(JSON.stringify(value));
}

function encodeSessionTime(value) {
  const timestampMs = typeof value === "string" || value instanceof Date
    ? new Date(value).getTime()
    : Number(value);
  if (!Number.isFinite(timestampMs) || timestampMs < 0) {
    return UINT32_NAN;
  }
  return Math.max(0, Math.min(UINT32_NAN - 1, Math.round(timestampMs / 1000)));
}

function encodeScaledUint32(value, scale) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return UINT32_NAN;
  }
  return Math.max(0, Math.min(UINT32_NAN - 1, Math.round(numeric * scale)));
}

function encodeScaledUint16(value, scale) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return UINT16_NAN;
  }
  return Math.max(0, Math.min(UINT16_NAN - 1, Math.round(numeric * scale)));
}

function encodeSessionCoord(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return INT32_NAN;
  }
  return Math.max(INT32_NAN + 1, Math.min(0x7FFFFFFF, Math.round(numeric * SESSION_COORD_SCALE)));
}

function getSessionRecordSize() {
  return SESSION_SPEC.reduce((size, field) => {
    switch (field.type) {
      case "uint8":
      case "bool":
        return size + 1;
      case "uint16":
      case "scaled-uint16":
        return size + 2;
      case "uint32":
      case "scaled-uint32":
      case "time":
      case "coord":
        return size + 4;
      default:
        return size;
    }
  }, 0);
}

function encodeSessionBlock(sessions = []) {
  const normalizedSessions = Array.isArray(sessions) ? sessions : [];
  const recordSize = getSessionRecordSize();
  const headerBytes = 12;
  const buffer = new ArrayBuffer(headerBytes + (normalizedSessions.length * recordSize));
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  bytes.set(textEncoder.encode("SES1"), 0);
  view.setUint16(4, SESSION_BLOCK_VERSION, true);
  view.setUint16(6, recordSize, true);
  view.setUint32(8, normalizedSessions.length, true);

  let offset = headerBytes;
  for (const session of normalizedSessions) {
    for (const field of SESSION_SPEC) {
      const value = session?.[field.key];
      switch (field.type) {
        case "time":
          view.setUint32(offset, encodeSessionTime(value), true);
          offset += 4;
          break;
        case "scaled-uint32":
          view.setUint32(offset, encodeScaledUint32(value, field.scale), true);
          offset += 4;
          break;
        case "uint32": {
          const numeric = Number(value);
          view.setUint32(offset, Number.isFinite(numeric) && numeric >= 0
            ? Math.max(0, Math.min(UINT32_NAN - 1, Math.round(numeric)))
            : UINT32_NAN, true);
          offset += 4;
          break;
        }
        case "scaled-uint16":
          view.setUint16(offset, encodeScaledUint16(value, field.scale), true);
          offset += 2;
          break;
        case "uint16": {
          const numeric = Number(value);
          view.setUint16(offset, Number.isFinite(numeric) && numeric >= 0
            ? Math.max(0, Math.min(UINT16_NAN - 1, Math.round(numeric)))
            : UINT16_NAN, true);
          offset += 2;
          break;
        }
        case "uint8": {
          const numeric = Number(value);
          view.setUint8(offset, Number.isFinite(numeric) && numeric >= 0
            ? Math.max(0, Math.min(UINT8_NAN - 1, Math.round(numeric)))
            : UINT8_NAN);
          offset += 1;
          break;
        }
        case "coord":
          view.setInt32(offset, encodeSessionCoord(value), true);
          offset += 4;
          break;
        case "bool":
          view.setUint8(offset, value === true || Number(value) === 1 ? 1 : 0);
          offset += 1;
          break;
        default:
          break;
      }
    }
  }

  return bytes;
}

function buildDistancePayloadCompact(records, recordCount) {
  const values = records.distancesQ;
  const toTenths = (value) => value === UINT32_NAN
    ? UINT32_NAN
    : Math.min(UINT32_NAN - 1, value * 5);
  const chunks = [];
  let totalBytes = 0;
  for (let start = 0; start < recordCount; start += DELTA_BLOCK_SIZE) {
    const count = Math.min(DELTA_BLOCK_SIZE, recordCount - start);
    let canDeltaEncode = count > 0;
    for (let offset = 0; offset < count; offset += 1) {
      const current = values[start + offset];
      if (current === UINT32_NAN) {
        canDeltaEncode = false;
        break;
      }
      if (offset > 0) {
        const previous = values[start + offset - 1];
        const delta = (current - previous) * 5;
        if (delta < -32767 || delta > 32767) {
          canDeltaEncode = false;
          break;
        }
      }
    }

    if (canDeltaEncode) {
      const chunk = new Uint8Array(1 + 2 + 4 + Math.max(0, count - 1) * 2);
      const view = new DataView(chunk.buffer);
      chunk[0] = 1;
      view.setUint16(1, count, true);
      view.setUint32(3, toTenths(values[start]), true);
      let offset = 7;
      for (let index = 1; index < count; index += 1) {
        view.setInt16(offset, (values[start + index] - values[start + index - 1]) * 5, true);
        offset += 2;
      }
      chunks.push(chunk);
      totalBytes += chunk.byteLength;
      continue;
    }

    const chunk = new Uint8Array(1 + 2 + count * 4);
    const view = new DataView(chunk.buffer);
    chunk[0] = 0;
    view.setUint16(1, count, true);
    let offset = 3;
    for (let index = 0; index < count; index += 1) {
      view.setUint32(offset, toTenths(values[start + index]), true);
      offset += 4;
    }
    chunks.push(chunk);
    totalBytes += chunk.byteLength;
  }

  const payload = new Uint8Array(totalBytes);
  let writeOffset = 0;
  for (const chunk of chunks) {
    payload.set(chunk, writeOffset);
    writeOffset += chunk.byteLength;
  }
  return payload;
}

function buildWorkoutStreamBlockFromCompact(compactRecords) {
  const recordCount = Number(compactRecords.recordCount || 0);
  let hasCompleteDistanceSeries = recordCount > 0;
  for (let index = 0; index < recordCount; index += 1) {
    if (compactRecords.distancesQ[index] === UINT32_NAN) {
      hasCompleteDistanceSeries = false;
      break;
    }
  }
  const usesSpeedFallback = !hasCompleteDistanceSeries;
  const headerBytes = 4 + 4 + 8 + 4 + 6 * 4;
  const distancePayload = buildDistancePayloadCompact(compactRecords, recordCount);
  const distancesBytes = distancePayload.byteLength;
  const powersBytes = recordCount * 2;
  const heartRatesBytes = recordCount;
  const cadencesBytes = recordCount;
  const speedsBytes = hasCompleteDistanceSeries ? 0 : recordCount * 2;
  const altitudesBytes = recordCount * 2;
  const payloadBytes = distancesBytes + powersBytes + heartRatesBytes + cadencesBytes + speedsBytes + altitudesBytes;
  const buffer = new ArrayBuffer(headerBytes + payloadBytes);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  bytes.set(textEncoder.encode("WST3"), 0);
  view.setUint32(4, recordCount, true);
  const baseTimestampMs = getCompactBaseTimestampMs(compactRecords, recordCount);
  view.setFloat64(8, baseTimestampMs, true);
  view.setUint32(16, 1000, true);

  let headerOffset = 20;
  for (const length of [distancesBytes, powersBytes, heartRatesBytes, cadencesBytes, speedsBytes, altitudesBytes]) {
    view.setUint32(headerOffset, length, true);
    headerOffset += 4;
  }

  let payloadOffset = headerBytes;
  bytes.set(distancePayload, payloadOffset);
  payloadOffset += distancesBytes;
  bytes.set(new Uint8Array(compactRecords.powersW.buffer, compactRecords.powersW.byteOffset, powersBytes), payloadOffset);
  payloadOffset += powersBytes;
  bytes.set(compactRecords.heartRatesBpm, payloadOffset);
  payloadOffset += heartRatesBytes;
  bytes.set(compactRecords.cadencesRpm, payloadOffset);
  payloadOffset += cadencesBytes;
  if (speedsBytes > 0) {
    bytes.set(new Uint8Array(compactRecords.speedsCmS.buffer, compactRecords.speedsCmS.byteOffset, speedsBytes), payloadOffset);
    payloadOffset += speedsBytes;
  }
  bytes.set(new Uint8Array(compactRecords.altitudesQ.buffer, compactRecords.altitudesQ.byteOffset, altitudesBytes), payloadOffset);

  return {
    bytes,
    distancePayloadBytes: distancePayload,
    powerPayloadBytes: new Uint8Array(compactRecords.powersW.buffer, compactRecords.powersW.byteOffset, powersBytes),
    heartRatePayloadBytes: compactRecords.heartRatesBpm,
    cadencePayloadBytes: compactRecords.cadencesRpm,
    speedPayloadBytes: speedsBytes > 0
      ? new Uint8Array(compactRecords.speedsCmS.buffer, compactRecords.speedsCmS.byteOffset, speedsBytes)
      : new Uint8Array(0),
    altitudePayloadBytes: new Uint8Array(compactRecords.altitudesQ.buffer, compactRecords.altitudesQ.byteOffset, altitudesBytes),
    stats: {
      recordCount,
      usesSpeedFallback,
      speedFallbackRecordCount: usesSpeedFallback ? recordCount : 0
    }
  };
}

function buildPowerDeltaPayloadFromCompact(compactRecords, recordCount) {
  const ESCAPE_DELTA = INT16_NAN;
  if (recordCount <= 0) {
    return {
      bytes: new Uint8Array(0),
      stats: {
        powerEncoding: "delta16",
        powerEscapeCount: 0,
        powerAbsoluteCount: 0
      }
    };
  }

  const powers = compactRecords.powersW;
  const deltaBytes = new Uint8Array(Math.max(0, recordCount - 1) * 2);
  const absoluteTailBytes = new Uint8Array(Math.max(0, recordCount - 1) * 2);
  const firstValueBytes = new Uint8Array(2);
  const firstView = new DataView(firstValueBytes.buffer);
  firstView.setUint16(0, powers[0], true);

  let prev = powers[0];
  let deltaOffset = 0;
  let absoluteOffset = 0;
  let escapeCount = 0;

  for (let index = 1; index < recordCount; index += 1) {
    const current = powers[index];
    const prevValid = prev !== UINT16_NAN;
    const currentValid = current !== UINT16_NAN;
    const delta = currentValid && prevValid ? current - prev : Number.NaN;

    if (!Number.isFinite(delta) || delta < -32767 || delta > 32767) {
      const deltaView = new DataView(deltaBytes.buffer);
      deltaView.setInt16(deltaOffset, ESCAPE_DELTA, true);
      deltaOffset += 2;
      const absoluteView = new DataView(absoluteTailBytes.buffer);
      absoluteView.setUint16(absoluteOffset, current, true);
      absoluteOffset += 2;
      escapeCount += 1;
      prev = current;
      continue;
    }

    const deltaView = new DataView(deltaBytes.buffer);
    deltaView.setInt16(deltaOffset, delta, true);
    deltaOffset += 2;
    prev = current;
  }

  const bytes = new Uint8Array(firstValueBytes.byteLength + deltaOffset + absoluteOffset);
  let offset = 0;
  bytes.set(firstValueBytes, offset);
  offset += firstValueBytes.byteLength;
  bytes.set(deltaBytes.subarray(0, deltaOffset), offset);
  offset += deltaOffset;
  bytes.set(absoluteTailBytes.subarray(0, absoluteOffset), offset);

  return {
    bytes,
    stats: {
      powerEncoding: "delta16",
      powerEscapeCount: escapeCount,
      powerAbsoluteCount: 1 + escapeCount
    }
  };
}

function buildPowerDeltaInt8Q4PayloadFromCompact(compactRecords, recordCount) {
  const ESCAPE_DELTA = 127;
  const POWER_STEP = 4;
  if (recordCount <= 0) {
    return {
      bytes: new Uint8Array(0),
      stats: {
        powerEncoding: "delta8-q4w",
        powerEscapeCount: 0,
        powerAbsoluteCount: 0
      }
    };
  }

  const powers = compactRecords.powersW;
  const tokenBytes = new Int8Array(Math.max(0, recordCount - 1));
  const absoluteTailBytes = new Uint8Array(Math.max(0, recordCount - 1) * 2);
  const firstValueBytes = new Uint8Array(2);
  new DataView(firstValueBytes.buffer).setUint16(0, powers[0], true);

  let prev = powers[0];
  let absoluteOffset = 0;
  let escapeCount = 0;

  for (let index = 1; index < recordCount; index += 1) {
    const current = powers[index];
    const prevValid = prev !== UINT16_NAN;
    const currentValid = current !== UINT16_NAN;
    const delta = currentValid && prevValid ? current - prev : Number.NaN;
    const stepDelta = Number.isFinite(delta) ? delta / POWER_STEP : Number.NaN;

    if (
      !Number.isFinite(stepDelta)
      || !Number.isInteger(stepDelta)
      || stepDelta < -128
      || stepDelta >= ESCAPE_DELTA
    ) {
      tokenBytes[index - 1] = ESCAPE_DELTA;
      new DataView(absoluteTailBytes.buffer).setUint16(absoluteOffset, current, true);
      absoluteOffset += 2;
      escapeCount += 1;
      prev = current;
      continue;
    }

    tokenBytes[index - 1] = stepDelta;
    prev = current;
  }

  const bytes = new Uint8Array(firstValueBytes.byteLength + tokenBytes.byteLength + absoluteOffset);
  let offset = 0;
  bytes.set(firstValueBytes, offset);
  offset += firstValueBytes.byteLength;
  bytes.set(new Uint8Array(tokenBytes.buffer, tokenBytes.byteOffset, tokenBytes.byteLength), offset);
  offset += tokenBytes.byteLength;
  bytes.set(absoluteTailBytes.subarray(0, absoluteOffset), offset);

  return {
    bytes,
    stats: {
      powerEncoding: "delta8-q4w",
      powerEscapeCount: escapeCount,
      powerAbsoluteCount: 1 + escapeCount
    }
  };
}

function buildAltitudeDeltaPayloadFromCompact(compactRecords, recordCount) {
  const ESCAPE_DELTA = 127;
  const ALTITUDE_DIVISOR = 4; // internal 0.25m units -> 1m encoded units
  if (recordCount <= 0) {
    return {
      bytes: new Uint8Array(0),
      stats: {
        altitudeEncoding: "delta8-q1m",
        altitudeEscapeCount: 0,
        altitudeAbsoluteCount: 0
      }
    };
  }

  const altitudes = compactRecords.altitudesQ;
  const tokenBytes = new Int8Array(Math.max(0, recordCount - 1));
  const absoluteTailBytes = new Uint8Array(Math.max(0, recordCount - 1) * 2);
  const firstValueBytes = new Uint8Array(2);
  const firstValue = altitudes[0] === INT16_NAN ? INT16_NAN : Math.round(altitudes[0] / ALTITUDE_DIVISOR);
  new DataView(firstValueBytes.buffer).setInt16(0, firstValue, true);

  let prev = firstValue;
  let absoluteOffset = 0;
  let escapeCount = 0;

  for (let index = 1; index < recordCount; index += 1) {
    const currentRaw = altitudes[index];
    const current = currentRaw === INT16_NAN ? INT16_NAN : Math.round(currentRaw / ALTITUDE_DIVISOR);
    const prevValid = prev !== INT16_NAN;
    const currentValid = current !== INT16_NAN;
    const delta = currentValid && prevValid ? current - prev : Number.NaN;

    if (!Number.isFinite(delta) || delta < -128 || delta >= ESCAPE_DELTA) {
      tokenBytes[index - 1] = ESCAPE_DELTA;
      new DataView(absoluteTailBytes.buffer).setInt16(absoluteOffset, current, true);
      absoluteOffset += 2;
      escapeCount += 1;
      prev = current;
      continue;
    }

    tokenBytes[index - 1] = delta;
    prev = current;
  }

  const bytes = new Uint8Array(firstValueBytes.byteLength + tokenBytes.byteLength + absoluteOffset);
  let offset = 0;
  bytes.set(firstValueBytes, offset);
  offset += firstValueBytes.byteLength;
  bytes.set(new Uint8Array(tokenBytes.buffer, tokenBytes.byteOffset, tokenBytes.byteLength), offset);
  offset += tokenBytes.byteLength;
  bytes.set(absoluteTailBytes.subarray(0, absoluteOffset), offset);

  return {
    bytes,
    stats: {
      altitudeEncoding: "delta8-q1m",
      altitudeEscapeCount: escapeCount,
      altitudeAbsoluteCount: 1 + escapeCount
    }
  };
}

function buildUint8RunLengthPayloadColumnDelta(values, sentinel, encoding = "rle-col-delta8") {
  if (!values || values.length <= 0) {
    return {
      bytes: new Uint8Array(0),
      stats: {
        encoding,
        runCount: 0,
        escapeCount: 0,
        absoluteCount: 0
      }
    };
  }

  const runLengths = [];
  const runValues = [];
  let runCount = 0;
  let escapeCount = 0;
  let previous = values[0];
  let runLength = 1;

  const flushRun = (value, count) => {
    let remaining = count;
    while (remaining > 0) {
      const chunkLength = Math.min(255, remaining);
      runLengths.push(chunkLength);
      runValues.push(value);
      runCount += 1;
      remaining -= chunkLength;
    }
  };

  for (let index = 1; index < values.length; index += 1) {
    const current = values[index];
    if (current === previous) {
      runLength += 1;
      continue;
    }
    flushRun(previous, runLength);
    previous = current;
    runLength = 1;
  }
  flushRun(previous, runLength);

  const valueTokens = new Int8Array(Math.max(0, runCount - 1));
  const absoluteTailValues = [];
  let prevValue = runValues[0];
  for (let index = 1; index < runCount; index += 1) {
    const current = runValues[index];
    const delta = current - prevValue;
    if (delta < -128 || delta >= 127) {
      valueTokens[index - 1] = 127;
      absoluteTailValues.push(current);
      escapeCount += 1;
    } else {
      valueTokens[index - 1] = delta;
    }
    prevValue = current;
  }

  const bytes = new Uint8Array(4 + runCount + 1 + valueTokens.byteLength + absoluteTailValues.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, runCount, true);
  let offset = 4;
  for (let index = 0; index < runCount; index += 1) {
    bytes[offset] = runLengths[index];
    offset += 1;
  }
  bytes[offset] = runValues[0];
  offset += 1;
  bytes.set(new Uint8Array(valueTokens.buffer, valueTokens.byteOffset, valueTokens.byteLength), offset);
  offset += valueTokens.byteLength;
  for (let index = 0; index < absoluteTailValues.length; index += 1) {
    bytes[offset] = absoluteTailValues[index];
    offset += 1;
  }

  return {
    bytes,
    stats: {
      encoding,
      runCount,
      escapeCount,
      absoluteCount: 1 + escapeCount
    }
  };
}

function buildAltitudeRunLengthPayloadFromCompact(compactRecords, recordCount) {
  const ALTITUDE_DIVISOR = 4;
  if (recordCount <= 0) {
    return {
      bytes: new Uint8Array(0),
      stats: {
        altitudeEncoding: "rle-col-delta8-q1m",
        altitudeRunCount: 0,
        altitudeEscapeCount: 0,
        altitudeAbsoluteCount: 0
      }
    };
  }

  const altitudes = compactRecords.altitudesQ;
  const runLengths = [];
  const runValues = [];
  let runCount = 0;
  let escapeCount = 0;
  let previous = altitudes[0] === INT16_NAN ? INT16_NAN : Math.round(altitudes[0] / ALTITUDE_DIVISOR);
  let runLength = 1;

  const flushRun = (value, count) => {
    let remaining = count;
    while (remaining > 0) {
      const chunkLength = Math.min(255, remaining);
      runLengths.push(chunkLength);
      runValues.push(value);
      runCount += 1;
      remaining -= chunkLength;
    }
  };

  for (let index = 1; index < recordCount; index += 1) {
    const currentRaw = altitudes[index];
    const current = currentRaw === INT16_NAN ? INT16_NAN : Math.round(currentRaw / ALTITUDE_DIVISOR);
    if (current === previous) {
      runLength += 1;
      continue;
    }
    flushRun(previous, runLength);
    previous = current;
    runLength = 1;
  }
  flushRun(previous, runLength);

  const valueTokens = new Int8Array(Math.max(0, runCount - 1));
  const absoluteTailValues = [];
  let prevValue = runValues[0];
  for (let index = 1; index < runCount; index += 1) {
    const current = runValues[index];
    const prevValid = prevValue !== INT16_NAN;
    const currentValid = current !== INT16_NAN;
    const delta = currentValid && prevValid ? current - prevValue : Number.NaN;
    if (!Number.isFinite(delta) || delta < -128 || delta >= 127) {
      valueTokens[index - 1] = 127;
      absoluteTailValues.push(current);
      escapeCount += 1;
    } else {
      valueTokens[index - 1] = delta;
    }
    prevValue = current;
  }

  const bytes = new Uint8Array(4 + runCount + 2 + valueTokens.byteLength + absoluteTailValues.length * 2);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, runCount, true);
  let offset = 4;
  for (let index = 0; index < runCount; index += 1) {
    bytes[offset] = runLengths[index];
    offset += 1;
  }
  view.setInt16(offset, runValues[0], true);
  offset += 2;
  bytes.set(new Uint8Array(valueTokens.buffer, valueTokens.byteOffset, valueTokens.byteLength), offset);
  offset += valueTokens.byteLength;
  for (let index = 0; index < absoluteTailValues.length; index += 1) {
    view.setInt16(offset, absoluteTailValues[index], true);
    offset += 2;
  }

  return {
    bytes,
    stats: {
      altitudeEncoding: "rle-col-delta8-q1m",
      altitudeRunCount: runCount,
      altitudeEscapeCount: escapeCount,
      altitudeAbsoluteCount: 1 + escapeCount
    }
  };
}


function buildWorkoutStreamBlockFromCompactDelta16Power(compactRecords) {
  const recordCount = Number(compactRecords.recordCount || 0);
  let hasCompleteDistanceSeries = recordCount > 0;
  for (let index = 0; index < recordCount; index += 1) {
    if (compactRecords.distancesQ[index] === UINT32_NAN) {
      hasCompleteDistanceSeries = false;
      break;
    }
  }
  const usesSpeedFallback = !hasCompleteDistanceSeries;
  const headerBytes = 4 + 4 + 8 + 4 + 6 * 4;
  const distancePayload = buildDistancePayloadCompact(compactRecords, recordCount);
  const powerPayload = buildPowerDeltaPayloadFromCompact(compactRecords, recordCount);
  const distancesBytes = distancePayload.byteLength;
  const powersBytes = powerPayload.bytes.byteLength;
  const heartRatesBytes = recordCount;
  const cadencesBytes = recordCount;
  const speedsBytes = hasCompleteDistanceSeries ? 0 : recordCount * 2;
  const altitudesBytes = recordCount * 2;
  const payloadBytes = distancesBytes + powersBytes + heartRatesBytes + cadencesBytes + speedsBytes + altitudesBytes;
  const buffer = new ArrayBuffer(headerBytes + payloadBytes);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  bytes.set(textEncoder.encode("WST4"), 0);
  view.setUint32(4, recordCount, true);
  const baseTimestampMs = getCompactBaseTimestampMs(compactRecords, recordCount);
  view.setFloat64(8, baseTimestampMs, true);
  view.setUint32(16, 1000, true);

  let headerOffset = 20;
  for (const length of [distancesBytes, powersBytes, heartRatesBytes, cadencesBytes, speedsBytes, altitudesBytes]) {
    view.setUint32(headerOffset, length, true);
    headerOffset += 4;
  }

  let payloadOffset = headerBytes;
  bytes.set(distancePayload, payloadOffset);
  payloadOffset += distancesBytes;
  bytes.set(powerPayload.bytes, payloadOffset);
  payloadOffset += powersBytes;
  bytes.set(compactRecords.heartRatesBpm, payloadOffset);
  payloadOffset += heartRatesBytes;
  bytes.set(compactRecords.cadencesRpm, payloadOffset);
  payloadOffset += cadencesBytes;
  if (speedsBytes > 0) {
    bytes.set(new Uint8Array(compactRecords.speedsCmS.buffer, compactRecords.speedsCmS.byteOffset, speedsBytes), payloadOffset);
    payloadOffset += speedsBytes;
  }
  bytes.set(new Uint8Array(compactRecords.altitudesQ.buffer, compactRecords.altitudesQ.byteOffset, altitudesBytes), payloadOffset);

  return {
    bytes,
    distancePayloadBytes: distancePayload,
    powerPayloadBytes: new Uint8Array(compactRecords.powersW.buffer, compactRecords.powersW.byteOffset, powersBytes),
    heartRatePayloadBytes: compactRecords.heartRatesBpm,
    cadencePayloadBytes: compactRecords.cadencesRpm,
    speedPayloadBytes: speedsBytes > 0
      ? new Uint8Array(compactRecords.speedsCmS.buffer, compactRecords.speedsCmS.byteOffset, speedsBytes)
      : new Uint8Array(0),
    altitudePayloadBytes: new Uint8Array(compactRecords.altitudesQ.buffer, compactRecords.altitudesQ.byteOffset, altitudesBytes),
    stats: {
      recordCount,
      usesSpeedFallback,
      speedFallbackRecordCount: usesSpeedFallback ? recordCount : 0,
      powerEncoding: powerPayload.stats.powerEncoding,
      powerEscapeCount: powerPayload.stats.powerEscapeCount,
      powerAbsoluteCount: powerPayload.stats.powerAbsoluteCount
    }
  };
}

function buildDistancePayloadCompactUint8Q05(compactRecords, recordCount, distanceBlockSize = DEFAULT_DISTANCE_BLOCK_SIZE) {
  const DISTANCE_ESCAPE = 255;
  const values = compactRecords.distancesQ;
  const chunks = [];
  let totalBytes = 0;
  const normalizedDistanceBlockSize = normalizeDistanceBlockSize(distanceBlockSize);

  for (let start = 0; start < recordCount; start += normalizedDistanceBlockSize) {
    const count = Math.min(normalizedDistanceBlockSize, recordCount - start);
    let canUint8Encode = count > 0 && values[start] !== UINT32_NAN;

    if (canUint8Encode) {
      const tokenBytes = new Uint8Array(Math.max(0, count - 1));
      const absoluteTailValues = [];
      let previousScaled = values[start];

      for (let offset = 1; offset < count; offset += 1) {
        const current = values[start + offset];
        if (current === UINT32_NAN) {
          canUint8Encode = false;
          break;
        }

        const currentScaled = current;
        const delta = currentScaled - previousScaled;
        if (delta >= 0 && delta < DISTANCE_ESCAPE) {
          tokenBytes[offset - 1] = delta;
        } else {
          tokenBytes[offset - 1] = DISTANCE_ESCAPE;
          absoluteTailValues.push(currentScaled);
        }
        previousScaled = currentScaled;
      }

      if (canUint8Encode) {
        const chunk = new Uint8Array(1 + 2 + 4 + tokenBytes.byteLength + (absoluteTailValues.length * 4));
        const view = new DataView(chunk.buffer);
        chunk[0] = 3;
        view.setUint16(1, count, true);
        view.setUint32(3, values[start], true);
        chunk.set(tokenBytes, 7);
        let tailOffset = 7 + tokenBytes.byteLength;
        for (const absoluteValue of absoluteTailValues) {
          view.setUint32(tailOffset, absoluteValue, true);
          tailOffset += 4;
        }
        chunks.push(chunk);
        totalBytes += chunk.byteLength;
        continue;
      }
    }

    const chunk = new Uint8Array(1 + 2 + count * 4);
    chunk[0] = 0;
    const view = new DataView(chunk.buffer);
    view.setUint16(1, count, true);
    let writeOffset = 3;
    for (let index = 0; index < count; index += 1) {
      const value = values[start + index];
      view.setUint32(
        writeOffset,
        value === UINT32_NAN ? UINT32_NAN : Math.min(UINT32_NAN - 1, value * 5),
        true
      );
      writeOffset += 4;
    }
    chunks.push(chunk);
    totalBytes += chunk.byteLength;
  }

  const payload = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    payload.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return payload;
}

function normalizeDistanceEncoding(distanceEncoding) {
  if (distanceEncoding === DISTANCE_ENCODING_DEFAULT) {
    return DISTANCE_ENCODING_DEFAULT;
  }
  if (
    distanceEncoding === DISTANCE_ENCODING_UINT8_Q05M
    || distanceEncoding === DISTANCE_ENCODING_UINT8_Q02_LEGACY
  ) {
    return DISTANCE_ENCODING_UINT8_Q05M;
  }
  return distanceEncoding || DISTANCE_ENCODING_UINT8_Q05M;
}

function normalizeDistanceBlockSize(distanceBlockSize) {
  const numeric = Number(distanceBlockSize);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return DEFAULT_DISTANCE_BLOCK_SIZE;
  }
  return numeric;
}

function normalizeGpsBlockSize(gpsBlockSize) {
  const numeric = Number(gpsBlockSize);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return 0xFFFF;
  }
  return Math.min(0xFFFF, numeric);
}

function buildWorkoutStreamBlockCompactDistanceUint8Q02(compactRecords, { distanceBlockSize = DEFAULT_DISTANCE_BLOCK_SIZE } = {}) {
  const recordCount = Number(compactRecords.recordCount || 0);
  let hasCompleteDistanceSeries = recordCount > 0;
  for (let index = 0; index < recordCount; index += 1) {
    if (compactRecords.distancesQ[index] === UINT32_NAN) {
      hasCompleteDistanceSeries = false;
      break;
    }
  }
  const usesSpeedFallback = !hasCompleteDistanceSeries;
  const headerBytes = 4 + 4 + 8 + 4 + 6 * 4;
  const normalizedDistanceBlockSize = normalizeDistanceBlockSize(distanceBlockSize);
  const distancePayload = buildDistancePayloadCompactUint8Q05(compactRecords, recordCount, normalizedDistanceBlockSize);
  const distancesBytes = distancePayload.byteLength;
  const powersBytes = recordCount * 2;
  const heartRatesBytes = recordCount;
  const cadencesBytes = recordCount;
  const speedsBytes = hasCompleteDistanceSeries ? 0 : recordCount * 2;
  const altitudesBytes = recordCount * 2;
  const payloadBytes = distancesBytes + powersBytes + heartRatesBytes + cadencesBytes + speedsBytes + altitudesBytes;
  const buffer = new ArrayBuffer(headerBytes + payloadBytes);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  bytes.set(textEncoder.encode("WST5"), 0);
  view.setUint32(4, recordCount, true);
  const baseTimestampMs = getCompactBaseTimestampMs(compactRecords, recordCount);
  view.setFloat64(8, baseTimestampMs, true);
  view.setUint32(16, 1000, true);

  let headerOffset = 20;
  for (const length of [distancesBytes, powersBytes, heartRatesBytes, cadencesBytes, speedsBytes, altitudesBytes]) {
    view.setUint32(headerOffset, length, true);
    headerOffset += 4;
  }

  let payloadOffset = headerBytes;
  bytes.set(distancePayload, payloadOffset);
  payloadOffset += distancesBytes;
  bytes.set(new Uint8Array(compactRecords.powersW.buffer, compactRecords.powersW.byteOffset, powersBytes), payloadOffset);
  payloadOffset += powersBytes;
  bytes.set(compactRecords.heartRatesBpm, payloadOffset);
  payloadOffset += heartRatesBytes;
  bytes.set(compactRecords.cadencesRpm, payloadOffset);
  payloadOffset += cadencesBytes;
  if (speedsBytes > 0) {
    bytes.set(new Uint8Array(compactRecords.speedsCmS.buffer, compactRecords.speedsCmS.byteOffset, speedsBytes), payloadOffset);
    payloadOffset += speedsBytes;
  }
  bytes.set(new Uint8Array(compactRecords.altitudesQ.buffer, compactRecords.altitudesQ.byteOffset, altitudesBytes), payloadOffset);

  return {
    bytes,
    distancePayloadBytes: distancePayload,
    powerPayloadBytes: new Uint8Array(compactRecords.powersW.buffer, compactRecords.powersW.byteOffset, powersBytes),
    heartRatePayloadBytes: compactRecords.heartRatesBpm,
    cadencePayloadBytes: compactRecords.cadencesRpm,
    speedPayloadBytes: speedsBytes > 0
      ? new Uint8Array(compactRecords.speedsCmS.buffer, compactRecords.speedsCmS.byteOffset, speedsBytes)
      : new Uint8Array(0),
    altitudePayloadBytes: new Uint8Array(compactRecords.altitudesQ.buffer, compactRecords.altitudesQ.byteOffset, altitudesBytes),
    stats: {
      recordCount,
      usesSpeedFallback,
      speedFallbackRecordCount: usesSpeedFallback ? recordCount : 0,
      distanceEncoding: DISTANCE_ENCODING_UINT8_Q05M,
      distanceBlockSize: normalizedDistanceBlockSize
    }
  };
}

function buildWorkoutStreamBlockCompactDelta16PowerDistanceUint8Q02(compactRecords, { distanceBlockSize = DEFAULT_DISTANCE_BLOCK_SIZE } = {}) {
  const recordCount = Number(compactRecords.recordCount || 0);
  let hasCompleteDistanceSeries = recordCount > 0;
  for (let index = 0; index < recordCount; index += 1) {
    if (compactRecords.distancesQ[index] === UINT32_NAN) {
      hasCompleteDistanceSeries = false;
      break;
    }
  }
  const usesSpeedFallback = !hasCompleteDistanceSeries;
  const headerBytes = 4 + 4 + 8 + 4 + 6 * 4;
  const normalizedDistanceBlockSize = normalizeDistanceBlockSize(distanceBlockSize);
  const distancePayload = buildDistancePayloadCompactUint8Q05(compactRecords, recordCount, normalizedDistanceBlockSize);
  const powerPayload = buildPowerDeltaPayloadFromCompact(compactRecords, recordCount);
  const distancesBytes = distancePayload.byteLength;
  const powersBytes = powerPayload.bytes.byteLength;
  const heartRatesBytes = recordCount;
  const cadencesBytes = recordCount;
  const speedsBytes = hasCompleteDistanceSeries ? 0 : recordCount * 2;
  const altitudesBytes = recordCount * 2;
  const payloadBytes = distancesBytes + powersBytes + heartRatesBytes + cadencesBytes + speedsBytes + altitudesBytes;
  const buffer = new ArrayBuffer(headerBytes + payloadBytes);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  bytes.set(textEncoder.encode("WST6"), 0);
  view.setUint32(4, recordCount, true);
  const baseTimestampMs = getCompactBaseTimestampMs(compactRecords, recordCount);
  view.setFloat64(8, baseTimestampMs, true);
  view.setUint32(16, 1000, true);

  let headerOffset = 20;
  for (const length of [distancesBytes, powersBytes, heartRatesBytes, cadencesBytes, speedsBytes, altitudesBytes]) {
    view.setUint32(headerOffset, length, true);
    headerOffset += 4;
  }

  let payloadOffset = headerBytes;
  bytes.set(distancePayload, payloadOffset);
  payloadOffset += distancesBytes;
  bytes.set(powerPayload.bytes, payloadOffset);
  payloadOffset += powersBytes;
  bytes.set(compactRecords.heartRatesBpm, payloadOffset);
  payloadOffset += heartRatesBytes;
  bytes.set(compactRecords.cadencesRpm, payloadOffset);
  payloadOffset += cadencesBytes;
  if (speedsBytes > 0) {
    bytes.set(new Uint8Array(compactRecords.speedsCmS.buffer, compactRecords.speedsCmS.byteOffset, speedsBytes), payloadOffset);
    payloadOffset += speedsBytes;
  }
  bytes.set(new Uint8Array(compactRecords.altitudesQ.buffer, compactRecords.altitudesQ.byteOffset, altitudesBytes), payloadOffset);

  return {
    bytes,
    distancePayloadBytes: distancePayload,
    powerPayloadBytes: powerPayload.bytes,
    heartRatePayloadBytes: compactRecords.heartRatesBpm,
    cadencePayloadBytes: compactRecords.cadencesRpm,
    speedPayloadBytes: speedsBytes > 0
      ? new Uint8Array(compactRecords.speedsCmS.buffer, compactRecords.speedsCmS.byteOffset, speedsBytes)
      : new Uint8Array(0),
    altitudePayloadBytes: new Uint8Array(compactRecords.altitudesQ.buffer, compactRecords.altitudesQ.byteOffset, altitudesBytes),
    stats: {
      recordCount,
      usesSpeedFallback,
      speedFallbackRecordCount: usesSpeedFallback ? recordCount : 0,
      powerEncoding: powerPayload.stats.powerEncoding,
      powerEscapeCount: powerPayload.stats.powerEscapeCount,
      powerAbsoluteCount: powerPayload.stats.powerAbsoluteCount,
      distanceEncoding: DISTANCE_ENCODING_UINT8_Q05M,
      distanceBlockSize: normalizedDistanceBlockSize
    }
  };
}

function buildWorkoutStreamBlockCompactDelta16PowerDistanceUint8Q02AltitudeDeltaQ1m(compactRecords, { distanceBlockSize = DEFAULT_DISTANCE_BLOCK_SIZE } = {}) {
  const recordCount = Number(compactRecords.recordCount || 0);
  let hasCompleteDistanceSeries = recordCount > 0;
  for (let index = 0; index < recordCount; index += 1) {
    if (compactRecords.distancesQ[index] === UINT32_NAN) {
      hasCompleteDistanceSeries = false;
      break;
    }
  }
  const usesSpeedFallback = !hasCompleteDistanceSeries;
  const headerBytes = 4 + 4 + 8 + 4 + 6 * 4;
  const normalizedDistanceBlockSize = normalizeDistanceBlockSize(distanceBlockSize);
  const distancePayload = buildDistancePayloadCompactUint8Q05(compactRecords, recordCount, normalizedDistanceBlockSize);
  const powerPayload = buildPowerDeltaPayloadFromCompact(compactRecords, recordCount);
  const altitudePayload = buildAltitudeDeltaPayloadFromCompact(compactRecords, recordCount);
  const distancesBytes = distancePayload.byteLength;
  const powersBytes = powerPayload.bytes.byteLength;
  const heartRatesBytes = recordCount;
  const cadencesBytes = recordCount;
  const speedsBytes = hasCompleteDistanceSeries ? 0 : recordCount * 2;
  const altitudesBytes = altitudePayload.bytes.byteLength;
  const payloadBytes = distancesBytes + powersBytes + heartRatesBytes + cadencesBytes + speedsBytes + altitudesBytes;
  const buffer = new ArrayBuffer(headerBytes + payloadBytes);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  bytes.set(textEncoder.encode("WST7"), 0);
  view.setUint32(4, recordCount, true);
  const baseTimestampMs = getCompactBaseTimestampMs(compactRecords, recordCount);
  view.setFloat64(8, baseTimestampMs, true);
  view.setUint32(16, 1000, true);

  let headerOffset = 20;
  for (const length of [distancesBytes, powersBytes, heartRatesBytes, cadencesBytes, speedsBytes, altitudesBytes]) {
    view.setUint32(headerOffset, length, true);
    headerOffset += 4;
  }

  let payloadOffset = headerBytes;
  bytes.set(distancePayload, payloadOffset);
  payloadOffset += distancesBytes;
  bytes.set(powerPayload.bytes, payloadOffset);
  payloadOffset += powersBytes;
  bytes.set(compactRecords.heartRatesBpm, payloadOffset);
  payloadOffset += heartRatesBytes;
  bytes.set(compactRecords.cadencesRpm, payloadOffset);
  payloadOffset += cadencesBytes;
  if (speedsBytes > 0) {
    bytes.set(new Uint8Array(compactRecords.speedsCmS.buffer, compactRecords.speedsCmS.byteOffset, speedsBytes), payloadOffset);
    payloadOffset += speedsBytes;
  }
  bytes.set(altitudePayload.bytes, payloadOffset);

  return {
    bytes,
    distancePayloadBytes: distancePayload,
    powerPayloadBytes: powerPayload.bytes,
    heartRatePayloadBytes: compactRecords.heartRatesBpm,
    cadencePayloadBytes: compactRecords.cadencesRpm,
    speedPayloadBytes: speedsBytes > 0
      ? new Uint8Array(compactRecords.speedsCmS.buffer, compactRecords.speedsCmS.byteOffset, speedsBytes)
      : new Uint8Array(0),
    altitudePayloadBytes: altitudePayload.bytes,
    stats: {
      recordCount,
      usesSpeedFallback,
      speedFallbackRecordCount: usesSpeedFallback ? recordCount : 0,
      powerEncoding: powerPayload.stats.powerEncoding,
      powerEscapeCount: powerPayload.stats.powerEscapeCount,
      powerAbsoluteCount: powerPayload.stats.powerAbsoluteCount,
      distanceEncoding: DISTANCE_ENCODING_UINT8_Q05M,
      distanceBlockSize: normalizedDistanceBlockSize,
      altitudeEncoding: altitudePayload.stats.altitudeEncoding,
      altitudeEscapeCount: altitudePayload.stats.altitudeEscapeCount,
      altitudeAbsoluteCount: altitudePayload.stats.altitudeAbsoluteCount,
      blockBytes: {
        distances: distancesBytes,
        powers: powersBytes,
        heartRates: heartRatesBytes,
        cadences: cadencesBytes,
        speeds: speedsBytes,
        altitudes: altitudesBytes
      }
    }
  };
}

function buildWorkoutStreamBlockCompactDelta8Q4PowerDistanceUint8Q02AltitudeDeltaQ1m(compactRecords, { distanceBlockSize = DEFAULT_DISTANCE_BLOCK_SIZE } = {}) {
  const recordCount = Number(compactRecords.recordCount || 0);
  let hasCompleteDistanceSeries = recordCount > 0;
  for (let index = 0; index < recordCount; index += 1) {
    if (compactRecords.distancesQ[index] === UINT32_NAN) {
      hasCompleteDistanceSeries = false;
      break;
    }
  }
  const usesSpeedFallback = !hasCompleteDistanceSeries;
  const headerBytes = 4 + 4 + 8 + 4 + 6 * 4;
  const normalizedDistanceBlockSize = normalizeDistanceBlockSize(distanceBlockSize);
  const distancePayload = buildDistancePayloadCompactUint8Q05(compactRecords, recordCount, normalizedDistanceBlockSize);
  const powerPayload = buildPowerDeltaInt8Q4PayloadFromCompact(compactRecords, recordCount);
  const altitudePayload = buildAltitudeDeltaPayloadFromCompact(compactRecords, recordCount);
  const distancesBytes = distancePayload.byteLength;
  const powersBytes = powerPayload.bytes.byteLength;
  const heartRatesBytes = recordCount;
  const cadencesBytes = recordCount;
  const speedsBytes = hasCompleteDistanceSeries ? 0 : recordCount * 2;
  const altitudesBytes = altitudePayload.bytes.byteLength;
  const payloadBytes = distancesBytes + powersBytes + heartRatesBytes + cadencesBytes + speedsBytes + altitudesBytes;
  const buffer = new ArrayBuffer(headerBytes + payloadBytes);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  bytes.set(textEncoder.encode("WST8"), 0);
  view.setUint32(4, recordCount, true);
  const baseTimestampMs = getCompactBaseTimestampMs(compactRecords, recordCount);
  view.setFloat64(8, baseTimestampMs, true);
  view.setUint32(16, 1000, true);

  let headerOffset = 20;
  for (const length of [distancesBytes, powersBytes, heartRatesBytes, cadencesBytes, speedsBytes, altitudesBytes]) {
    view.setUint32(headerOffset, length, true);
    headerOffset += 4;
  }

  let payloadOffset = headerBytes;
  bytes.set(distancePayload, payloadOffset);
  payloadOffset += distancesBytes;
  bytes.set(powerPayload.bytes, payloadOffset);
  payloadOffset += powersBytes;
  bytes.set(compactRecords.heartRatesBpm, payloadOffset);
  payloadOffset += heartRatesBytes;
  bytes.set(compactRecords.cadencesRpm, payloadOffset);
  payloadOffset += cadencesBytes;
  if (speedsBytes > 0) {
    bytes.set(new Uint8Array(compactRecords.speedsCmS.buffer, compactRecords.speedsCmS.byteOffset, speedsBytes), payloadOffset);
    payloadOffset += speedsBytes;
  }
  bytes.set(altitudePayload.bytes, payloadOffset);

  return {
    bytes,
    distancePayloadBytes: distancePayload,
    powerPayloadBytes: powerPayload.bytes,
    heartRatePayloadBytes: compactRecords.heartRatesBpm,
    cadencePayloadBytes: compactRecords.cadencesRpm,
    speedPayloadBytes: speedsBytes > 0
      ? new Uint8Array(compactRecords.speedsCmS.buffer, compactRecords.speedsCmS.byteOffset, speedsBytes)
      : new Uint8Array(0),
    altitudePayloadBytes: altitudePayload.bytes,
    stats: {
      recordCount,
      usesSpeedFallback,
      speedFallbackRecordCount: usesSpeedFallback ? recordCount : 0,
      powerEncoding: powerPayload.stats.powerEncoding,
      powerEscapeCount: powerPayload.stats.powerEscapeCount,
      powerAbsoluteCount: powerPayload.stats.powerAbsoluteCount,
      distanceEncoding: DISTANCE_ENCODING_UINT8_Q05M,
      altitudeEncoding: altitudePayload.stats.altitudeEncoding,
      altitudeEscapeCount: altitudePayload.stats.altitudeEscapeCount,
      altitudeAbsoluteCount: altitudePayload.stats.altitudeAbsoluteCount,
      blockBytes: {
        distances: distancesBytes,
        powers: powersBytes,
        heartRates: heartRatesBytes,
        cadences: cadencesBytes,
        speeds: speedsBytes,
        altitudes: altitudesBytes
      }
    }
  };
}

function buildWorkoutStreamBlockCompactDelta8Q4PowerDistanceUint8Q02RleDeltaQ1m(compactRecords, { distanceBlockSize = DEFAULT_DISTANCE_BLOCK_SIZE } = {}) {
  const recordCount = Number(compactRecords.recordCount || 0);
  let hasCompleteDistanceSeries = recordCount > 0;
  for (let index = 0; index < recordCount; index += 1) {
    if (compactRecords.distancesQ[index] === UINT32_NAN) {
      hasCompleteDistanceSeries = false;
      break;
    }
  }
  const usesSpeedFallback = !hasCompleteDistanceSeries;
  const headerBytes = 4 + 4 + 8 + 4 + 6 * 4;
  const normalizedDistanceBlockSize = normalizeDistanceBlockSize(distanceBlockSize);
  const distancePayload = buildDistancePayloadCompactUint8Q05(compactRecords, recordCount, normalizedDistanceBlockSize);
  const powerPayload = buildPowerDeltaInt8Q4PayloadFromCompact(compactRecords, recordCount);
  const heartRatePayload = buildUint8RunLengthPayloadColumnDelta(compactRecords.heartRatesBpm, UINT8_NAN, "hr-rle-col-delta8");
  const cadencePayload = buildUint8RunLengthPayloadColumnDelta(compactRecords.cadencesRpm, UINT8_NAN, "cad-rle-col-delta8");
  const altitudePayload = buildAltitudeRunLengthPayloadFromCompact(compactRecords, recordCount);
  const distancesBytes = distancePayload.byteLength;
  const powersBytes = powerPayload.bytes.byteLength;
  const heartRatesBytes = heartRatePayload.bytes.byteLength;
  const cadencesBytes = cadencePayload.bytes.byteLength;
  const speedsBytes = hasCompleteDistanceSeries ? 0 : recordCount * 2;
  const altitudesBytes = altitudePayload.bytes.byteLength;
  const payloadBytes = distancesBytes + powersBytes + heartRatesBytes + cadencesBytes + speedsBytes + altitudesBytes;
  const buffer = new ArrayBuffer(headerBytes + payloadBytes);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  bytes.set(textEncoder.encode("WST9"), 0);
  view.setUint32(4, recordCount, true);
  const baseTimestampMs = getCompactBaseTimestampMs(compactRecords, recordCount);
  view.setFloat64(8, baseTimestampMs, true);
  view.setUint32(16, 1000, true);

  let headerOffset = 20;
  for (const length of [distancesBytes, powersBytes, heartRatesBytes, cadencesBytes, speedsBytes, altitudesBytes]) {
    view.setUint32(headerOffset, length, true);
    headerOffset += 4;
  }

  let payloadOffset = headerBytes;
  bytes.set(distancePayload, payloadOffset);
  payloadOffset += distancesBytes;
  bytes.set(powerPayload.bytes, payloadOffset);
  payloadOffset += powersBytes;
  bytes.set(heartRatePayload.bytes, payloadOffset);
  payloadOffset += heartRatesBytes;
  bytes.set(cadencePayload.bytes, payloadOffset);
  payloadOffset += cadencesBytes;
  if (speedsBytes > 0) {
    bytes.set(new Uint8Array(compactRecords.speedsCmS.buffer, compactRecords.speedsCmS.byteOffset, speedsBytes), payloadOffset);
    payloadOffset += speedsBytes;
  }
  bytes.set(altitudePayload.bytes, payloadOffset);

  return {
    bytes,
    distancePayloadBytes: distancePayload,
    powerPayloadBytes: powerPayload.bytes,
    heartRatePayloadBytes: heartRatePayload.bytes,
    cadencePayloadBytes: cadencePayload.bytes,
    speedPayloadBytes: speedsBytes > 0
      ? new Uint8Array(compactRecords.speedsCmS.buffer, compactRecords.speedsCmS.byteOffset, speedsBytes)
      : new Uint8Array(0),
    altitudePayloadBytes: altitudePayload.bytes,
    stats: {
      recordCount,
      usesSpeedFallback,
      speedFallbackRecordCount: usesSpeedFallback ? recordCount : 0,
      powerEncoding: powerPayload.stats.powerEncoding,
      powerEscapeCount: powerPayload.stats.powerEscapeCount,
      powerAbsoluteCount: powerPayload.stats.powerAbsoluteCount,
      distanceEncoding: DISTANCE_ENCODING_UINT8_Q05M,
      distanceBlockSize: normalizedDistanceBlockSize,
      heartRateEncoding: heartRatePayload.stats.encoding,
      heartRateRunCount: heartRatePayload.stats.runCount,
      cadenceEncoding: cadencePayload.stats.encoding,
      cadenceRunCount: cadencePayload.stats.runCount,
      altitudeEncoding: altitudePayload.stats.altitudeEncoding,
      altitudeRunCount: altitudePayload.stats.altitudeRunCount,
      altitudeEscapeCount: altitudePayload.stats.altitudeEscapeCount,
      altitudeAbsoluteCount: altitudePayload.stats.altitudeAbsoluteCount,
      blockBytes: {
        distances: distancesBytes,
        powers: powersBytes,
        heartRates: heartRatesBytes,
        cadences: cadencesBytes,
        speeds: speedsBytes,
        altitudes: altitudesBytes
      }
    }
  };
}

function buildGpsCoordinatePayload(points, gpsBlockSize = DEFAULT_GPS_BLOCK_SIZE) {
  const quantized = points.map((point) => ({
    lat: Number.isFinite(Number(point.lat)) ? Math.round(Number(point.lat) * GPS_TRACK_COORDINATE_SCALE) : INT32_NAN,
    lng: Number.isFinite(Number(point.lng)) ? Math.round(Number(point.lng) * GPS_TRACK_COORDINATE_SCALE) : INT32_NAN
  }));

  const chunks = [];
  let totalBytes = 0;
  const normalizedGpsBlockSize = normalizeGpsBlockSize(gpsBlockSize);
  for (let start = 0; start < quantized.length; start += normalizedGpsBlockSize) {
    const count = Math.min(normalizedGpsBlockSize, quantized.length - start);
    let escapeCount = 0;
    for (let index = 1; index < count; index += 1) {
      const current = quantized[start + index];
      const previous = quantized[start + index - 1];
      const currentValid = current.lat !== INT32_NAN && current.lng !== INT32_NAN;
      const previousValid = previous.lat !== INT32_NAN && previous.lng !== INT32_NAN;
      const deltaLat = currentValid && previousValid ? current.lat - previous.lat : Number.NaN;
      const deltaLng = currentValid && previousValid ? current.lng - previous.lng : Number.NaN;
      if (
        currentValid
        && (!Number.isFinite(deltaLat)
        || !Number.isFinite(deltaLng)
        || deltaLat <= GPS_DELTA_ESCAPE
        || deltaLat > 32767
        || deltaLng <= GPS_DELTA_ESCAPE
        || deltaLng > 32767)
      ) {
        escapeCount += 1;
      }
    }

    const tokenCount = Math.max(0, count - 1);
    const chunk = new Uint8Array(1 + 2 + 8 + (tokenCount * 4) + (escapeCount * 8));
    const view = new DataView(chunk.buffer);
    chunk[0] = 2;
    view.setUint16(1, count, true);
    view.setInt32(3, quantized[start].lat, true);
    view.setInt32(7, quantized[start].lng, true);
    let tokenOffset = 11;
    let absoluteOffset = tokenOffset + (tokenCount * 4);
    for (let index = 1; index < count; index += 1) {
      const current = quantized[start + index];
      const previous = quantized[start + index - 1];
      const currentValid = current.lat !== INT32_NAN && current.lng !== INT32_NAN;
      const previousValid = previous.lat !== INT32_NAN && previous.lng !== INT32_NAN;
      const deltaLat = currentValid && previousValid ? current.lat - previous.lat : Number.NaN;
      const deltaLng = currentValid && previousValid ? current.lng - previous.lng : Number.NaN;
      const needsAbsolute = currentValid && (!Number.isFinite(deltaLat)
        || !Number.isFinite(deltaLng)
        || deltaLat <= GPS_DELTA_ESCAPE
        || deltaLat > 32767
        || deltaLng <= GPS_DELTA_ESCAPE
        || deltaLng > 32767);

      if (!currentValid) {
        view.setInt16(tokenOffset, GPS_DELTA_ESCAPE, true);
        view.setInt16(tokenOffset + 2, GPS_DELTA_ESCAPE, true);
      } else if (needsAbsolute) {
        view.setInt16(tokenOffset, GPS_DELTA_ESCAPE, true);
        view.setInt16(tokenOffset + 2, 0, true);
        view.setInt32(absoluteOffset, current.lat, true);
        view.setInt32(absoluteOffset + 4, current.lng, true);
        absoluteOffset += 8;
      } else {
        view.setInt16(tokenOffset, deltaLat, true);
        view.setInt16(tokenOffset + 2, deltaLng, true);
      }
      tokenOffset += 4;
    }
    chunks.push(chunk);
    totalBytes += chunk.byteLength;
  }

  const payload = new Uint8Array(totalBytes);
  let writeOffset = 0;
  for (const chunk of chunks) {
    payload.set(chunk, writeOffset);
    writeOffset += chunk.byteLength;
  }
  return payload;
}

function buildGpsCoordinatePayloadTiered(points, gpsBlockSize = DEFAULT_GPS_BLOCK_SIZE) {
  const quantized = points.map((point) => ({
    lat: Number.isFinite(Number(point.lat)) ? Math.round(Number(point.lat) * GPS_TRACK_COORDINATE_SCALE) : INT32_NAN,
    lng: Number.isFinite(Number(point.lng)) ? Math.round(Number(point.lng) * GPS_TRACK_COORDINATE_SCALE) : INT32_NAN
  }));
  const chunks = [];
  let totalBytes = 0;
  const normalizedGpsBlockSize = normalizeGpsBlockSize(gpsBlockSize);

  for (let start = 0; start < quantized.length; start += normalizedGpsBlockSize) {
    const count = Math.min(normalizedGpsBlockSize, quantized.length - start);
    let payloadBytes = 8;
    for (let index = 1; index < count; index += 1) {
      const current = quantized[start + index];
      const previous = quantized[start + index - 1];
      const currentValid = current.lat !== INT32_NAN && current.lng !== INT32_NAN;
      const previousValid = previous.lat !== INT32_NAN && previous.lng !== INT32_NAN;
      if (!currentValid) {
        payloadBytes += 2;
        continue;
      }
      const deltaLat = previousValid ? current.lat - previous.lat : Number.NaN;
      const deltaLng = previousValid ? current.lng - previous.lng : Number.NaN;
      if (deltaLat >= -128 && deltaLat <= 125 && deltaLng >= -128 && deltaLng <= 127) {
        payloadBytes += 2;
      } else if (deltaLat >= -32768 && deltaLat <= 32767 && deltaLng >= -32768 && deltaLng <= 32767) {
        payloadBytes += 5;
      } else {
        payloadBytes += 10;
      }
    }

    const chunk = new Uint8Array(3 + payloadBytes);
    const view = new DataView(chunk.buffer);
    chunk[0] = 3;
    view.setUint16(1, count, true);
    view.setInt32(3, quantized[start].lat, true);
    view.setInt32(7, quantized[start].lng, true);
    let offset = 11;

    for (let index = 1; index < count; index += 1) {
      const current = quantized[start + index];
      const previous = quantized[start + index - 1];
      const currentValid = current.lat !== INT32_NAN && current.lng !== INT32_NAN;
      const previousValid = previous.lat !== INT32_NAN && previous.lng !== INT32_NAN;
      if (!currentValid) {
        view.setUint8(offset, GPS_TIERED_EXTENDED_MARKER);
        view.setUint8(offset + 1, GPS_TIERED_MISSING_SUBTYPE);
        offset += 2;
        continue;
      }

      const deltaLat = previousValid ? current.lat - previous.lat : Number.NaN;
      const deltaLng = previousValid ? current.lng - previous.lng : Number.NaN;
      if (deltaLat >= -128 && deltaLat <= 125 && deltaLng >= -128 && deltaLng <= 127) {
        view.setInt8(offset, deltaLat);
        view.setInt8(offset + 1, deltaLng);
        offset += 2;
      } else if (deltaLat >= -32768 && deltaLat <= 32767 && deltaLng >= -32768 && deltaLng <= 32767) {
        view.setUint8(offset, GPS_TIERED_INT16_MARKER);
        view.setInt16(offset + 1, deltaLat, true);
        view.setInt16(offset + 3, deltaLng, true);
        offset += 5;
      } else {
        view.setUint8(offset, GPS_TIERED_EXTENDED_MARKER);
        view.setUint8(offset + 1, GPS_TIERED_ABSOLUTE_SUBTYPE);
        view.setInt32(offset + 2, current.lat, true);
        view.setInt32(offset + 6, current.lng, true);
        offset += 10;
      }
    }

    chunks.push(chunk);
    totalBytes += chunk.byteLength;
  }

  const payload = new Uint8Array(totalBytes);
  let writeOffset = 0;
  for (const chunk of chunks) {
    payload.set(chunk, writeOffset);
    writeOffset += chunk.byteLength;
  }
  return payload;
}

function buildGpsBitmapCoordinateColumn(quantized, key) {
  let payloadBytes = 0;
  for (let index = 0; index < quantized.length; index += 1) {
    const current = quantized[index];
    if (!current) continue;
    const previous = index > 0 ? quantized[index - 1] : null;
    if (!previous) {
      payloadBytes += 4;
      continue;
    }
    const delta = current[key] - previous[key];
    if (delta >= -128 && delta <= 125) payloadBytes += 1;
    else if (delta >= -32768 && delta <= 32767) payloadBytes += 3;
    else payloadBytes += 5;
  }

  const bytes = new Uint8Array(payloadBytes);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  for (let index = 0; index < quantized.length; index += 1) {
    const current = quantized[index];
    if (!current) continue;
    const previous = index > 0 ? quantized[index - 1] : null;
    if (!previous) {
      view.setInt32(offset, current[key], true);
      offset += 4;
      continue;
    }
    const delta = current[key] - previous[key];
    if (delta >= -128 && delta <= 125) {
      view.setInt8(offset, delta);
      offset += 1;
    } else if (delta >= -32768 && delta <= 32767) {
      view.setUint8(offset, GPS_TIERED_INT16_MARKER);
      view.setInt16(offset + 1, delta, true);
      offset += 3;
    } else {
      view.setUint8(offset, GPS_TIERED_EXTENDED_MARKER);
      view.setInt32(offset + 1, current[key], true);
      offset += 5;
    }
  }
  return bytes;
}

function buildGpsBitmapColumnarPayload(points) {
  const quantized = points.map((point) => (
    Number.isFinite(Number(point?.lat)) && Number.isFinite(Number(point?.lng))
      ? {
          lat: Math.round(Number(point.lat) * GPS_TRACK_COORDINATE_SCALE),
          lng: Math.round(Number(point.lng) * GPS_TRACK_COORDINATE_SCALE)
        }
      : null
  ));
  const bitmap = new Uint8Array(Math.ceil(quantized.length / 8));
  for (let index = 0; index < quantized.length; index += 1) {
    if (quantized[index]) bitmap[index >> 3] |= 1 << (index & 7);
  }
  return {
    bitmap,
    latitudes: buildGpsBitmapCoordinateColumn(quantized, "lat"),
    longitudes: buildGpsBitmapCoordinateColumn(quantized, "lng")
  };
}

export function buildReducedGpsTrackCompact(compactRecords, sampleRateSeconds = DEFAULT_GPS_SAMPLE_RATE_SECONDS) {
  const MAX_STEP_DISTANCE_METERS = 40;
  const MIN_RELOCK_SEQUENCE = 3;
  const MAX_INTERPOLATION_GAP = 8;
  const DEG_TO_RAD = Math.PI / 180;
  const EARTH_RADIUS_METERS = 6371000;
  const METERS_PER_MICRO_DEGREE = EARTH_RADIUS_METERS * DEG_TO_RAD / MICRO_DEGREES;
  const MAX_STEP_DISTANCE_SQUARED = MAX_STEP_DISTANCE_METERS ** 2;
  const sampleRate = normalizeGpsSampleRateSeconds(sampleRateSeconds, DEFAULT_GPS_SAMPLE_RATE_SECONDS);
  const recordCount = Number(compactRecords?.recordCount || 0);
  const firstTimestampMs = getCompactBaseTimestampMs(compactRecords, recordCount);
  const rawLatitudesE6 = compactRecords?.positionLatsE6;
  const rawLongitudesE6 = compactRecords?.positionLongsE6;

  function hasRawCoordinateAt(index) {
    const latE6 = rawLatitudesE6?.[index];
    const lngE6 = rawLongitudesE6?.[index];
    return Number.isFinite(latE6)
      && Number.isFinite(lngE6)
      && latE6 !== INT32_NAN
      && lngE6 !== INT32_NAN
      && (latE6 !== 0 || lngE6 !== 0);
  }

  function isWithinMaxStep(indexA, indexB) {
    const latAE6 = rawLatitudesE6[indexA];
    const lngAE6 = rawLongitudesE6[indexA];
    const latBE6 = rawLatitudesE6[indexB];
    const lngBE6 = rawLongitudesE6[indexB];
    const dLatMeters = (latBE6 - latAE6) * METERS_PER_MICRO_DEGREE;
    const dLngUpperBoundMeters = (lngBE6 - lngAE6) * METERS_PER_MICRO_DEGREE;

    // Longitude degrees are never longer than at the equator. If this
    // conservative bound fits, the exact great-circle distance fits as well.
    if (
      (dLatMeters * dLatMeters) + (dLngUpperBoundMeters * dLngUpperBoundMeters)
      <= MAX_STEP_DISTANCE_SQUARED
    ) {
      return true;
    }

    let dLngE6 = lngBE6 - lngAE6;
    if (dLngE6 > 180 * MICRO_DEGREES) dLngE6 -= 360 * MICRO_DEGREES;
    if (dLngE6 < -180 * MICRO_DEGREES) dLngE6 += 360 * MICRO_DEGREES;

    const meanLatRadians = ((latAE6 + latBE6) / (2 * MICRO_DEGREES)) * DEG_TO_RAD;
    const dLngMeters = dLngE6 * METERS_PER_MICRO_DEGREE * Math.cos(meanLatRadians);
    return (dLatMeters * dLatMeters) + (dLngMeters * dLngMeters) <= MAX_STEP_DISTANCE_SQUARED;
  }

  const validCoordinates = new Uint8Array(recordCount);
  let lastValidIndex = -1;
  const relockCandidateIndexes = new Int32Array(MIN_RELOCK_SEQUENCE);
  let relockCandidateCount = 0;
  for (let i = 0; i < recordCount; i += 1) {
    if (!hasRawCoordinateAt(i)) continue;

    if (lastValidIndex < 0) {
      validCoordinates[i] = 1;
      lastValidIndex = i;
      continue;
    }

    if (isWithinMaxStep(lastValidIndex, i)) {
      validCoordinates[i] = 1;
      lastValidIndex = i;
      relockCandidateCount = 0;
      continue;
    }

    if (relockCandidateCount === 0) {
      relockCandidateIndexes[0] = i;
      relockCandidateCount = 1;
      continue;
    }

    const previousCandidateIndex = relockCandidateIndexes[relockCandidateCount - 1];
    if (isWithinMaxStep(previousCandidateIndex, i)) {
      relockCandidateIndexes[relockCandidateCount] = i;
      relockCandidateCount += 1;
    } else {
      relockCandidateIndexes[0] = i;
      relockCandidateCount = 1;
    }

    if (relockCandidateCount >= MIN_RELOCK_SEQUENCE) {
      for (let candidate = 0; candidate < relockCandidateCount; candidate += 1) {
        validCoordinates[relockCandidateIndexes[candidate]] = 1;
      }
      lastValidIndex = relockCandidateIndexes[relockCandidateCount - 1];
      relockCandidateCount = 0;
    }
  }

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  const slots = [];
  const points = [];
  const segments = [];
  let currentSegment = null;

  function appendInvalidSlot(recordIndex) {
    slots.push({
      lat: Number.NaN,
      lng: Number.NaN,
      valid: false,
      slotIndex: slots.length,
      recordIndex
    });
    currentSegment = null;
  }

  function appendValidSlot(recordIndex, latE6, lngE6) {
    const lat = Math.round(latE6 / 10) / GPS_TRACK_COORDINATE_SCALE;
    const lng = Math.round(lngE6 / 10) / GPS_TRACK_COORDINATE_SCALE;
    const slot = {
      lat,
      lng,
      valid: true,
      slotIndex: slots.length,
      recordIndex
    };

    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;

    slots.push(slot);
    points.push(slot);
    if (!currentSegment) {
      currentSegment = [];
      segments.push(currentSegment);
    }
    currentSegment.push(slot);
  }

  let index = 0;
  while (index < recordCount) {
    if (validCoordinates[index]) {
      if (index % sampleRate === 0) {
        appendValidSlot(index, rawLatitudesE6[index], rawLongitudesE6[index]);
      }
      index += 1;
      continue;
    }

    const gapStart = index;
    while (index < recordCount && !validCoordinates[index]) index += 1;
    const gapEnd = index;
    const previousValidIndex = gapStart - 1;
    const nextValidIndex = gapEnd < recordCount ? gapEnd : -1;
    const canInterpolate = previousValidIndex >= 0 && nextValidIndex >= 0;
    const interpolatedEnd = canInterpolate
      ? Math.min(gapEnd, gapStart + MAX_INTERPOLATION_GAP)
      : gapStart;
    const interpolatedLatE6 = canInterpolate
      ? (rawLatitudesE6[previousValidIndex] + rawLatitudesE6[nextValidIndex]) / 2
      : 0;
    const interpolatedLngE6 = canInterpolate
      ? (rawLongitudesE6[previousValidIndex] + rawLongitudesE6[nextValidIndex]) / 2
      : 0;

    for (let gapIndex = gapStart; gapIndex < gapEnd; gapIndex += 1) {
      if (gapIndex % sampleRate !== 0) continue;
      if (gapIndex < interpolatedEnd) {
        appendValidSlot(gapIndex, interpolatedLatE6, interpolatedLngE6);
      } else {
        appendInvalidSlot(gapIndex);
      }
    }
  }

  if (!slots.length || !points.length) {
    return {
      sampleRateSeconds: sampleRate,
      firstTimestampMs,
      slotCount: slots.length,
      pointCount: points.length,
      bbox: null,
      startPoint: null,
      endPoint: null,
      slots,
      points,
      segments
    };
  }

  return {
    sampleRateSeconds: sampleRate,
    firstTimestampMs,
    slotCount: slots.length,
    pointCount: points.length,
    bbox: points.length >= 2 ? { minLat, maxLat, minLng, maxLng } : null,
    startPoint: { lat: points[0].lat, lng: points[0].lng },
    endPoint: { lat: points[points.length - 1].lat, lng: points[points.length - 1].lng },
    slots,
    points,
    segments
  };
}

export function buildGpsTrackBlock(gpsTrack, {
  gpsBlockSize = DEFAULT_GPS_BLOCK_SIZE,
  coordinateEncoding = "bitmap-columnar"
} = {}) {
  const slots = Array.isArray(gpsTrack?.slots) ? gpsTrack.slots : (Array.isArray(gpsTrack?.points) ? gpsTrack.points : []);
  const pointCount = Number(gpsTrack?.slotCount || slots.length || 0);
  const firstTimestampMs = Number.isFinite(Number(gpsTrack?.firstTimestampMs))
    ? Math.round(Number(gpsTrack.firstTimestampMs))
    : 0;
  const usesBitmapColumnarEncoding = coordinateEncoding === "bitmap-columnar";
  const headerBytes = usesBitmapColumnarEncoding ? 24 : 20;
  const usesTieredEncoding = coordinateEncoding === "tiered-int8";
  if (usesBitmapColumnarEncoding) {
    const payload = buildGpsBitmapColumnarPayload(slots);
    const buffer = new ArrayBuffer(
      headerBytes + payload.bitmap.byteLength + payload.latitudes.byteLength + payload.longitudes.byteLength
    );
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    bytes.set(textEncoder.encode("GPS2"), 0);
    view.setUint16(4, 5, true);
    view.setUint16(6, Number(gpsTrack?.sampleRateSeconds || 0), true);
    view.setUint32(8, pointCount, true);
    view.setFloat64(12, firstTimestampMs, true);
    view.setUint32(20, payload.latitudes.byteLength, true);
    let offset = headerBytes;
    bytes.set(payload.bitmap, offset);
    offset += payload.bitmap.byteLength;
    bytes.set(payload.latitudes, offset);
    offset += payload.latitudes.byteLength;
    bytes.set(payload.longitudes, offset);
    return bytes;
  }
  const coordinatePayload = usesTieredEncoding
    ? buildGpsCoordinatePayloadTiered(slots, gpsBlockSize)
    : buildGpsCoordinatePayload(slots, gpsBlockSize);
  const payloadBytes = coordinatePayload.byteLength;
  const buffer = new ArrayBuffer(headerBytes + payloadBytes);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  bytes.set(textEncoder.encode("GPS2"), 0);
  view.setUint16(4, usesTieredEncoding ? 4 : 3, true);
  view.setUint16(6, Number(gpsTrack?.sampleRateSeconds || 0), true);
  view.setUint32(8, pointCount, true);
  view.setFloat64(12, firstTimestampMs, true);
  bytes.set(coordinatePayload, headerBytes);
  return bytes;
}

function getISOWeekUTC(dateLike) {
  const date = new Date(dateLike);
  const utcDate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = utcDate.getUTCDay() || 7;
  utcDate.setUTCDate(utcDate.getUTCDate() + 4 - dayNum);
  const isoYear = utcDate.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const isoWeek = Math.ceil((((utcDate - yearStart) / 86400000) + 1) / 7);
  return { isoYear, isoWeek };
}

function aggregateSessions(sessions = []) {
  if (!Array.isArray(sessions) || sessions.length === 0) {
    return null;
  }
  const sum = (key) => sessions.reduce((acc, session) => acc + (Number(session?.[key]) || 0), 0);
  const weightedAvg = (key) => {
    const totalTime = sum("total_timer_time");
    if (!totalTime) return 0;
    return sessions.reduce((acc, session) => acc + ((Number(session?.[key]) || 0) * (Number(session?.total_timer_time) || 0)), 0) / totalTime;
  };
  const max = (key) => Math.max(...sessions.map((session) => Number(session?.[key]) || 0));
  const minDate = (key) => new Date(Math.min(...sessions.map((session) => new Date(session?.[key]).getTime()))).toISOString();
  const maxDate = (key) => new Date(Math.max(...sessions.map((session) => new Date(session?.[key]).getTime()))).toISOString();
  const validValues = (key) => sessions.map((session) => session?.[key]).filter((value) => value != null && Number.isFinite(Number(value)));

  return {
    start_time: minDate("start_time"),
    end_time: maxDate("timestamp"),
    total_elapsed_time: sum("total_elapsed_time"),
    total_timer_time: sum("total_timer_time"),
    total_distance: sum("total_distance"),
    total_cycles: sum("total_cycles"),
    total_work: sum("total_work"),
    total_calories: sum("total_calories"),
    total_ascent: sum("total_ascent"),
    total_descent: sum("total_descent"),
    avg_speed: weightedAvg("avg_speed"),
    avg_power: weightedAvg("avg_power"),
    avg_heart_rate: weightedAvg("avg_heart_rate"),
    avg_cadence: weightedAvg("avg_cadence"),
    max_speed: max("max_speed"),
    max_power: max("max_power"),
    max_heart_rate: max("max_heart_rate"),
    max_cadence: max("max_cadence"),
    nec_lat: Math.max(...validValues("nec_lat")),
    nec_long: Math.max(...validValues("nec_long")),
    swc_lat: Math.min(...validValues("swc_lat")),
    swc_long: Math.min(...validValues("swc_long"))
  };
}

function speedMsToKmh(value) {
  if (!Number.isFinite(Number(value))) return 0;
  return Number(value) * 3.6;
}

function derivePersistedRowFromCompact(parsedCompact, gpsTrack, sourceName = "") {
  const sessions = Array.isArray(parsedCompact?.sessions) ? parsedCompact.sessions : [];
  const aggregated = aggregateSessions(sessions);
  if (!aggregated) return null;
  const startDate = new Date(aggregated.start_time);
  const year = startDate.getUTCFullYear();
  const month = startDate.getUTCMonth() + 1;
  const quarter = Math.ceil(month / 3);
  const yearMonth = Number(`${year}${String(month).padStart(2, "0")}`);
  const { isoYear, isoWeek } = getISOWeekUTC(aggregated.start_time);
  const yearWeek = Number(`${isoYear}${String(isoWeek).padStart(2, "0")}`);
  const yearQuarter = year * 10 + quarter;
  const validGps = Number(gpsTrack?.pointCount || 0) > 1;
  const bbox = validGps ? (gpsTrack?.bbox || null) : null;
  const trackStart = validGps ? (gpsTrack?.startPoint || null) : null;
  const trackEnd = validGps ? (gpsTrack?.endPoint || null) : null;
  const firstSession = sessions[0] || {};
  return {
    source_name: sourceName,
    start_time: aggregated.start_time,
    end_time: aggregated.end_time,
    total_elapsed_time: aggregated.total_elapsed_time,
    total_timer_time: aggregated.total_timer_time,
    total_distance: aggregated.total_distance,
    total_cycles: aggregated.total_cycles,
    total_work: aggregated.total_work,
    total_calories: aggregated.total_calories,
    total_ascent: aggregated.total_ascent,
    total_descent: aggregated.total_descent,
    avg_speed: speedMsToKmh(aggregated.avg_speed),
    max_speed: speedMsToKmh(aggregated.max_speed),
    avg_power: aggregated.avg_power,
    max_power: aggregated.max_power,
    avg_normalized_power: Math.round(Number(firstSession?.normalized_power) || 0),
    avg_heart_rate: aggregated.avg_heart_rate,
    max_heart_rate: aggregated.max_heart_rate,
    avg_cadence: aggregated.avg_cadence,
    max_cadence: aggregated.max_cadence,
    validGps,
    year,
    month,
    week: isoWeek,
    year_quarter: yearQuarter,
    year_month: yearMonth,
    year_week: yearWeek,
    points_count: validGps ? Number(gpsTrack?.pointCount || 0) : 0,
    sampleRateGPS: validGps ? Number(gpsTrack?.sampleRateSeconds || 1) : 1,
    gps_source: validGps ? (firstSession?.woa_manual_gps ? "manual_lookup" : "recorded") : null,
    bounds: bbox ? { minLat: bbox.minLat, maxLat: bbox.maxLat, minLng: bbox.minLng, maxLng: bbox.maxLng } : null,
    track_start: trackStart ? { lat: trackStart.lat, lng: trackStart.lng } : null,
    track_end: trackEnd ? { lat: trackEnd.lat, lng: trackEnd.lng } : null,
    stream_codec: DEFAULT_STREAM_CODEC,
    gps_track_blob_codec: DEFAULT_GPS_TRACK_CODEC
  };
}

function deriveSummaryFromCompact(parsedCompact, gpsTrack, sourceName = "") {
  const sessions = Array.isArray(parsedCompact?.sessions) ? parsedCompact.sessions : [];
  const firstSession = sessions[0] || {};
  const compactRecords = parsedCompact?.compactRecords || {};
  const recordCount = Number(compactRecords.recordCount || 0);
  const firstTimestamp = recordCount > 0 ? getCompactBaseTimestampMs(compactRecords, recordCount) : Number.NaN;
  const lastTimestamp = recordCount > 0 ? getCompactLastTimestampMs(compactRecords, recordCount) : Number.NaN;
  const persistedRow = derivePersistedRowFromCompact(parsedCompact, gpsTrack, sourceName);
  return {
    sourceName,
    sourceFormat: "fit",
    recordCount,
    pointsCount: Number(gpsTrack?.pointCount || 0),
    sampleRateGps: Number(gpsTrack?.sampleRateSeconds || 0),
    validGps: Number(gpsTrack?.pointCount || 0) > 1,
    gpsSource: firstSession.woa_manual_gps ? "manual_lookup" : "recorded",
    startTime: Number.isFinite(firstTimestamp) ? new Date(firstTimestamp).toISOString() : null,
    endTime: Number.isFinite(lastTimestamp) ? new Date(lastTimestamp).toISOString() : null,
    totalElapsedTime: firstSession.total_elapsed_time ?? null,
    totalTimerTime: firstSession.total_timer_time ?? null,
    totalDistance: firstSession.total_distance ?? null,
    totalCycles: firstSession.total_cycles ?? null,
    totalWork: firstSession.total_work ?? null,
    totalCalories: firstSession.total_calories ?? null,
    totalAscent: firstSession.total_ascent ?? null,
    totalDescent: firstSession.total_descent ?? null,
    avgSpeed: firstSession.avg_speed ?? null,
    maxSpeed: firstSession.max_speed ?? null,
    avgPower: firstSession.avg_power ?? null,
    maxPower: firstSession.max_power ?? null,
    avgHeartRate: firstSession.avg_heart_rate ?? null,
    maxHeartRate: firstSession.max_heart_rate ?? null,
    avgCadence: firstSession.avg_cadence ?? null,
    maxCadence: firstSession.max_cadence ?? null,
    normalizedPower: firstSession.normalized_power ?? null,
    bbox: gpsTrack?.bbox || null,
    startPoint: gpsTrack?.startPoint || null,
    endPoint: gpsTrack?.endPoint || null,
    persistedRow
  };
}

export function createWoa1FileFromCompact(parsedCompact, {
  sourceName = "",
  sampleRateSeconds = DEFAULT_GPS_SAMPLE_RATE_SECONDS,
  compressWorkoutStream = null,
  compressGpsTrack = null,
  streamCodec = DEFAULT_STREAM_CODEC,
  gpsTrackBlobCodec = DEFAULT_GPS_TRACK_CODEC,
  powerEncoding = "delta8-q4w",
  distanceEncoding = DISTANCE_ENCODING_UINT8_Q05M,
  distanceBlockSize = DEFAULT_DISTANCE_BLOCK_SIZE,
  gpsBlockSize = DEFAULT_GPS_BLOCK_SIZE,
  gpsCoordinateEncoding = "bitmap-columnar",
  altitudeEncoding = "rle-delta-q1m"
} = {}) {
  const timings = {
    buildReducedGpsTrackMs: 0,
    buildWorkoutStreamBlockMs: 0,
    buildGpsTrackBlockMs: 0,
    compressWorkoutStreamMs: 0,
    compressGpsTrackMs: 0,
    deriveSummaryMs: 0,
    encodeMetaJsonMs: 0,
    encodeSessionsJsonMs: 0,
    assembleWoaFileMs: 0
  };

  let stepStartedAt = nowMs();
  const gpsTrack = buildReducedGpsTrackCompact(parsedCompact?.compactRecords || {}, sampleRateSeconds);
  timings.buildReducedGpsTrackMs = nowMs() - stepStartedAt;

  stepStartedAt = nowMs();
  const normalizedDistanceBlockSize = normalizeDistanceBlockSize(distanceBlockSize);
  const workoutStreamBlock = buildWorkoutStreamBlockCompactDelta8Q4PowerDistanceUint8Q02RleDeltaQ1m(
    parsedCompact?.compactRecords || {},
    { distanceBlockSize: normalizedDistanceBlockSize }
  );
  const workoutStreamRawBytes = workoutStreamBlock.bytes;
  timings.buildWorkoutStreamBlockMs = nowMs() - stepStartedAt;

  stepStartedAt = nowMs();
  const normalizedGpsBlockSize = normalizeGpsBlockSize(gpsBlockSize);
  const gpsTrackRawBytes = buildGpsTrackBlock(gpsTrack, {
    gpsBlockSize: normalizedGpsBlockSize,
    coordinateEncoding: gpsCoordinateEncoding
  });
  timings.buildGpsTrackBlockMs = nowMs() - stepStartedAt;

  stepStartedAt = nowMs();
  const workoutStreamBytes = compressWorkoutStream
    ? compressWorkoutStream(workoutStreamRawBytes, { level: DEFAULT_STREAM_GZIP_LEVEL })
    : workoutStreamRawBytes;
  timings.compressWorkoutStreamMs = nowMs() - stepStartedAt;

  stepStartedAt = nowMs();
  const gpsTrackBytes = compressGpsTrack
    ? compressGpsTrack(gpsTrackRawBytes, { level: DEFAULT_GPS_GZIP_LEVEL })
    : gpsTrackRawBytes;
  timings.compressGpsTrackMs = nowMs() - stepStartedAt;

  const workoutStreamCodec = compressWorkoutStream ? streamCodec : "identity";
  const gpsTrackCodec = compressGpsTrack ? gpsTrackBlobCodec : "identity";
  const usesCompressedBlocks = !!(compressWorkoutStream && compressGpsTrack);

  stepStartedAt = nowMs();
  const summary = deriveSummaryFromCompact(parsedCompact, gpsTrack, sourceName);
  timings.deriveSummaryMs = nowMs() - stepStartedAt;
  if (summary?.persistedRow) {
    summary.persistedRow.stream_codec = workoutStreamCodec;
    summary.persistedRow.gps_track_blob_codec = gpsTrackCodec;
  }
  summary.blockCodecs = {
    workout_stream: workoutStreamCodec,
    gps_track: gpsTrackCodec
  };
  summary.blockBytes = {
    workout_stream_raw: workoutStreamRawBytes.byteLength,
    workout_stream_compressed: workoutStreamBytes.byteLength,
    gps_track_raw: gpsTrackRawBytes.byteLength,
    gps_track_compressed: gpsTrackBytes.byteLength
  };
  summary.blockStats = {
    workout_stream: workoutStreamBlock.stats
  };

  stepStartedAt = nowMs();
  const metaBytes = encodeJson(summary);
  timings.encodeMetaJsonMs = nowMs() - stepStartedAt;

  stepStartedAt = nowMs();
  const sessionBytes = encodeSessionBlock(Array.isArray(parsedCompact?.sessions) ? parsedCompact.sessions : []);
  timings.encodeSessionsJsonMs = nowMs() - stepStartedAt;

  const headerLength = 24;
  const totalLength = headerLength + metaBytes.length + sessionBytes.length + workoutStreamBytes.length + gpsTrackBytes.length;

  stepStartedAt = nowMs();
  const buffer = new ArrayBuffer(totalLength);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  bytes.set(textEncoder.encode("WOA1"), 0);
  view.setUint8(4, usesCompressedBlocks ? 2 : 1);
  view.setUint8(5, 0);
  view.setUint16(6, 0, true);
  view.setUint32(8, metaBytes.length, true);
  view.setUint32(12, sessionBytes.length, true);
  view.setUint32(16, workoutStreamBytes.length, true);
  view.setUint32(20, gpsTrackBytes.length, true);
  let offset = headerLength;
  bytes.set(metaBytes, offset);
  offset += metaBytes.length;
  bytes.set(sessionBytes, offset);
  offset += sessionBytes.length;
  bytes.set(workoutStreamBytes, offset);
  offset += workoutStreamBytes.length;
  bytes.set(gpsTrackBytes, offset);
  timings.assembleWoaFileMs = nowMs() - stepStartedAt;

  return {
    bytes,
    meta: JSON.parse(new TextDecoder().decode(metaBytes)),
    gpsTrack,
    workoutStreamBlock,
    workoutStreamBytes,
    gpsTrackBytes,
    timings,
    stats: {
      workoutStream: workoutStreamBlock.stats
    }
  };
}

export async function createWoa1FileFromCompactAsync(parsedCompact, {
  sourceName = "",
  sampleRateSeconds = DEFAULT_GPS_SAMPLE_RATE_SECONDS,
  compressWorkoutStream = null,
  compressGpsTrack = null,
  streamCodec = DEFAULT_STREAM_CODEC,
  gpsTrackBlobCodec = DEFAULT_GPS_TRACK_CODEC,
  powerEncoding = "delta8-q4w",
  distanceEncoding = DISTANCE_ENCODING_UINT8_Q05M,
  distanceBlockSize = DEFAULT_DISTANCE_BLOCK_SIZE,
  gpsBlockSize = DEFAULT_GPS_BLOCK_SIZE,
  gpsCoordinateEncoding = "bitmap-columnar",
  altitudeEncoding = "rle-delta-q1m"
} = {}) {
  const timings = {
    buildReducedGpsTrackMs: 0,
    buildWorkoutStreamBlockMs: 0,
    buildGpsTrackBlockMs: 0,
    compressWorkoutStreamMs: 0,
    compressGpsTrackMs: 0,
    deriveSummaryMs: 0,
    encodeMetaJsonMs: 0,
    encodeSessionsJsonMs: 0,
    assembleWoaFileMs: 0
  };

  let stepStartedAt = nowMs();
  const gpsTrack = buildReducedGpsTrackCompact(parsedCompact?.compactRecords || {}, sampleRateSeconds);
  timings.buildReducedGpsTrackMs = nowMs() - stepStartedAt;

  stepStartedAt = nowMs();
  const normalizedDistanceBlockSize = normalizeDistanceBlockSize(distanceBlockSize);
  const workoutStreamBlock = buildWorkoutStreamBlockCompactDelta8Q4PowerDistanceUint8Q02RleDeltaQ1m(
    parsedCompact?.compactRecords || {},
    { distanceBlockSize: normalizedDistanceBlockSize }
  );
  const workoutStreamRawBytes = workoutStreamBlock.bytes;
  timings.buildWorkoutStreamBlockMs = nowMs() - stepStartedAt;

  stepStartedAt = nowMs();
  const normalizedGpsBlockSize = normalizeGpsBlockSize(gpsBlockSize);
  const gpsTrackRawBytes = buildGpsTrackBlock(gpsTrack, {
    gpsBlockSize: normalizedGpsBlockSize,
    coordinateEncoding: gpsCoordinateEncoding
  });
  timings.buildGpsTrackBlockMs = nowMs() - stepStartedAt;

  stepStartedAt = nowMs();
  const workoutStreamBytes = compressWorkoutStream
    ? await compressWorkoutStream(workoutStreamRawBytes, { level: DEFAULT_STREAM_GZIP_LEVEL })
    : workoutStreamRawBytes;
  timings.compressWorkoutStreamMs = nowMs() - stepStartedAt;

  stepStartedAt = nowMs();
  const gpsTrackBytes = compressGpsTrack
    ? await compressGpsTrack(gpsTrackRawBytes, { level: DEFAULT_GPS_GZIP_LEVEL })
    : gpsTrackRawBytes;
  timings.compressGpsTrackMs = nowMs() - stepStartedAt;

  const workoutStreamCodec = compressWorkoutStream ? streamCodec : "identity";
  const gpsTrackCodec = compressGpsTrack ? gpsTrackBlobCodec : "identity";
  const usesCompressedBlocks = !!(compressWorkoutStream && compressGpsTrack);

  stepStartedAt = nowMs();
  const summary = deriveSummaryFromCompact(parsedCompact, gpsTrack, sourceName);
  timings.deriveSummaryMs = nowMs() - stepStartedAt;
  if (summary?.persistedRow) {
    summary.persistedRow.stream_codec = workoutStreamCodec;
    summary.persistedRow.gps_track_blob_codec = gpsTrackCodec;
  }
  summary.blockCodecs = {
    workout_stream: workoutStreamCodec,
    gps_track: gpsTrackCodec
  };
  summary.blockBytes = {
    workout_stream_raw: workoutStreamRawBytes.byteLength,
    workout_stream_compressed: workoutStreamBytes.byteLength,
    gps_track_raw: gpsTrackRawBytes.byteLength,
    gps_track_compressed: gpsTrackBytes.byteLength
  };
  summary.blockStats = {
    workout_stream: workoutStreamBlock.stats
  };

  stepStartedAt = nowMs();
  const metaBytes = encodeJson(summary);
  timings.encodeMetaJsonMs = nowMs() - stepStartedAt;

  stepStartedAt = nowMs();
  const sessionBytes = encodeSessionBlock(Array.isArray(parsedCompact?.sessions) ? parsedCompact.sessions : []);
  timings.encodeSessionsJsonMs = nowMs() - stepStartedAt;

  const headerLength = 24;
  const totalLength = headerLength + metaBytes.length + sessionBytes.length + workoutStreamBytes.length + gpsTrackBytes.length;

  stepStartedAt = nowMs();
  const buffer = new ArrayBuffer(totalLength);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  bytes.set(textEncoder.encode("WOA1"), 0);
  view.setUint8(4, usesCompressedBlocks ? 2 : 1);
  view.setUint8(5, 0);
  view.setUint16(6, 0, true);
  view.setUint32(8, metaBytes.length, true);
  view.setUint32(12, sessionBytes.length, true);
  view.setUint32(16, workoutStreamBytes.length, true);
  view.setUint32(20, gpsTrackBytes.length, true);
  let offset = headerLength;
  bytes.set(metaBytes, offset);
  offset += metaBytes.length;
  bytes.set(sessionBytes, offset);
  offset += sessionBytes.length;
  bytes.set(workoutStreamBytes, offset);
  offset += workoutStreamBytes.length;
  bytes.set(gpsTrackBytes, offset);
  timings.assembleWoaFileMs = nowMs() - stepStartedAt;

  return {
    bytes,
    meta: JSON.parse(new TextDecoder().decode(metaBytes)),
    gpsTrack,
    workoutStreamBlock,
    workoutStreamBytes,
    gpsTrackBytes,
    timings,
    stats: {
      workoutStream: workoutStreamBlock.stats
    }
  };
}
