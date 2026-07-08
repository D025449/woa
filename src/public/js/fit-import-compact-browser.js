import { FIT } from "/vendor/fit-file-parser-fast/dist/fit.js";

const GARMIN_TIME_OFFSET_MS = 631065600000;
const SEMICIRCLES_TO_DEGREES = 180 / 0x80000000;
const COMPACT_SENTINELS = {
  uint8: 0xff,
  uint16: 0xffff,
  uint32: 0xffffffff,
  int16: -0x8000,
  int32: -0x80000000,
};
const SESSION_FIELDS = new Set([
  "timestamp",
  "start_time",
  "total_elapsed_time",
  "total_timer_time",
  "total_distance",
  "total_cycles",
  "total_work",
  "total_calories",
  "total_ascent",
  "total_descent",
  "avg_speed",
  "avg_power",
  "avg_heart_rate",
  "avg_cadence",
  "normalized_power",
  "max_speed",
  "max_power",
  "max_heart_rate",
  "max_cadence",
  "nec_lat",
  "nec_long",
  "swc_lat",
  "swc_long",
  "woa_manual_gps",
]);

function normalizeExcludeStartTimeSet(excludeStartTimes) {
  if (excludeStartTimes instanceof Set) {
    return excludeStartTimes.size > 0 ? excludeStartTimes : null;
  }
  if (!Array.isArray(excludeStartTimes) || excludeStartTimes.length === 0) {
    return null;
  }
  const values = excludeStartTimes.filter((value) => typeof value === "string" && value);
  return values.length > 0 ? new Set(values) : null;
}

function toIsoStartTimeKey(timestampMs) {
  return Number.isFinite(timestampMs) ? new Date(timestampMs).toISOString() : null;
}

function readU16LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32LE(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function readI32LE(bytes, offset) {
  return readU32LE(bytes, offset) | 0;
}

function readU16BE(bytes, offset) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readU32BE(bytes, offset) {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function readI32BE(bytes, offset) {
  return readU32BE(bytes, offset) | 0;
}

function readRawFitValue(view, offset, size, baseType, littleEndian) {
  const type = baseType & 0x1f;
  switch (type) {
    case 0x00:
    case 0x02:
    case 0x0d:
      return view.getUint8(offset);
    case 0x01:
      return view.getInt8(offset);
    case 0x83:
    case 0x03:
      return view.getInt16(offset, littleEndian);
    case 0x84:
    case 0x04:
      return view.getUint16(offset, littleEndian);
    case 0x85:
    case 0x05:
      return view.getInt32(offset, littleEndian);
    case 0x86:
    case 0x06:
      return view.getUint32(offset, littleEndian);
    case 0x88:
    case 0x08:
      return view.getFloat32(offset, littleEndian);
    default:
      return null;
  }
}

function isInvalidRawValue(rawValue, size, baseType) {
  const type = baseType & 0x1f;
  if (type === 0x01) return rawValue === 0x7f;
  if (type === 0x83 || type === 0x03) return rawValue === 0x7fff;
  if (type === 0x85 || type === 0x05) return rawValue === 0x7fffffff;
  if (type === 0x02 || type === 0x00 || type === 0x0d) return rawValue === 0xff;
  if (type === 0x84 || type === 0x04) return rawValue === 0xffff;
  if (type === 0x86 || type === 0x06) return rawValue === 0xffffffff;
  if (size === 1) return rawValue === 0xff;
  if (size === 2) return rawValue === 0xffff;
  if (size === 4) return rawValue === 0xffffffff;
  return false;
}

function compactDistance(value) {
  return Number.isFinite(value) && value >= 0
    ? Math.max(0, Math.min(0xfffffffe, Math.round(value * 4)))
    : COMPACT_SENTINELS.uint32;
}

function compactAltitude(value) {
  return Number.isFinite(value)
    ? Math.max(-32767, Math.min(32767, Math.round(value * 4)))
    : COMPACT_SENTINELS.int16;
}

function dropAllZeroAltitudeColumn(altitudesQ) {
  if (!altitudesQ || altitudesQ.length <= 0) return altitudesQ;
  let validCount = 0;
  for (let index = 0; index < altitudesQ.length; index += 1) {
    const value = altitudesQ[index];
    if (value === COMPACT_SENTINELS.int16) continue;
    validCount += 1;
    if (value !== 0) return altitudesQ;
  }
  if (validCount <= 0) return altitudesQ;
  const dropped = new Int16Array(altitudesQ.length);
  dropped.fill(COMPACT_SENTINELS.int16);
  return dropped;
}

function compactCoordFromSemicircles(raw) {
  return Math.max(-0x7fffffff, Math.min(0x7fffffff, Math.round(raw * 180000000 / 0x80000000)));
}

function makeCompactRecordOps(fields, littleEndian) {
  const ops = [];
  let offset = 0;
  for (const field of fields) {
    const number = field.number;
    const size = field.size;
    let kind = 0;
    if (number === 253 && size === 4) kind = 1;
    else if (number === 0 && size === 4) kind = 2;
    else if (number === 1 && size === 4) kind = 3;
    else if ((number === 2 || number === 78) && size === 2) kind = number === 78 ? 12 : 4;
    else if (number === 3 && size === 1) kind = 5;
    else if (number === 4 && size === 1) kind = 6;
    else if (number === 5 && size === 4) kind = 7;
    else if ((number === 6 || number === 73) && size === 2) kind = number === 73 ? 11 : 8;
    else if (number === 7 && size === 2) kind = 9;
    if (kind !== 0) {
      ops.push({ kind, offset, littleEndian });
    }
    offset += size;
  }
  return { ops, messageBytes: offset };
}

function makeSessionOps(fields, littleEndian) {
  const message = FIT.messages[18] || {};
  const ops = [];
  let offset = 0;
  for (const field of fields) {
    const definition = message[field.number] || {};
    if (SESSION_FIELDS.has(definition.field)) {
      ops.push({
        field: definition.field,
        type: definition.type || "byte",
        scale: definition.scale ?? null,
        valueOffset: definition.offset || 0,
        size: field.size,
        baseType: field.baseType,
        littleEndian,
        offset,
      });
    }
    offset += field.size;
  }
  return ops;
}

function decodeSessionValue(rawValue, op) {
  if (rawValue == null || isInvalidRawValue(rawValue, op.size, op.baseType)) {
    return null;
  }
  switch (op.field) {
    case "timestamp":
    case "start_time":
      return (rawValue * 1000) + GARMIN_TIME_OFFSET_MS;
    case "nec_lat":
    case "nec_long":
    case "swc_lat":
    case "swc_long":
      return rawValue * SEMICIRCLES_TO_DEGREES;
    default:
      return op.scale ? (rawValue / op.scale) + op.valueOffset : rawValue;
  }
}

export function parseFitBufferCompactBrowser(buffer, { excludeStartTimes = null } = {}) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length < 12 || (bytes[0] !== 12 && bytes[0] !== 14)) {
    throw new Error("Invalid FIT header");
  }
  if (bytes[8] !== 46 || bytes[9] !== 70 || bytes[10] !== 73 || bytes[11] !== 84) {
    throw new Error("Missing .FIT in FIT header");
  }

  const excluded = normalizeExcludeStartTimeSet(excludeStartTimes);
  const headerLength = bytes[0];
  const dataLength = readU32LE(bytes, 4);
  const end = headerLength + dataLength;
  const definitions = [];
  const timestampsMs = [];
  const distancesQ = [];
  const powersW = [];
  const heartRatesBpm = [];
  const cadencesRpm = [];
  const speedsCmS = [];
  const altitudesQ = [];
  const positionLatsE6 = [];
  const positionLongsE6 = [];
  const sessions = [];
  let baseTimestampMs = -1;
  let cursor = headerLength;

  while (cursor < end) {
    const header = bytes[cursor];
    const compressed = (header & 0x80) !== 0;
    const localMessage = compressed ? ((header & 0x60) >> 5) : (header & 0x0f);

    if (!compressed && (header & 0x40) !== 0) {
      const hasDeveloper = (header & 0x20) !== 0;
      const littleEndian = bytes[cursor + 2] === 0;
      const globalMessage = littleEndian ? readU16LE(bytes, cursor + 3) : readU16BE(bytes, cursor + 3);
      const fieldCount = bytes[cursor + 5];
      const fields = new Array(fieldCount);
      let offset = cursor + 6;
      for (let index = 0; index < fieldCount; index += 1) {
        fields[index] = {
          number: bytes[offset],
          size: bytes[offset + 1],
          baseType: bytes[offset + 2],
        };
        offset += 3;
      }
      if (hasDeveloper) {
        const developerCount = bytes[offset];
        offset += 1 + developerCount * 3;
      }
      definitions[localMessage] = {
        globalMessage,
        ...(globalMessage === 20 ? makeCompactRecordOps(fields, littleEndian) : { ops: null, messageBytes: fields.reduce((sum, field) => sum + field.size, 0) }),
        sessionOps: globalMessage === 18 ? makeSessionOps(fields, littleEndian) : null,
      };
      cursor = offset;
      continue;
    }

    const definition = definitions[localMessage];
    if (!definition) {
      throw new Error(`Missing FIT message definition for local message type ${localMessage}`);
    }

    const dataOffset = cursor + 1;
    if (definition.globalMessage === 20) {
      let timestampMs = Number.NaN;
      let distance = COMPACT_SENTINELS.uint32;
      let power = COMPACT_SENTINELS.uint16;
      let heartRate = COMPACT_SENTINELS.uint8;
      let cadence = COMPACT_SENTINELS.uint8;
      let speed = COMPACT_SENTINELS.uint16;
      let altitude = COMPACT_SENTINELS.int16;
      let lat = COMPACT_SENTINELS.int32;
      let lng = COMPACT_SENTINELS.int32;

      for (const op of definition.ops || []) {
        const o = dataOffset + op.offset;
        switch (op.kind) {
          case 1: {
            const raw = op.littleEndian ? readU32LE(bytes, o) : readU32BE(bytes, o);
            if (raw !== 0xffffffff) {
              timestampMs = raw * 1000 + GARMIN_TIME_OFFSET_MS;
              if (baseTimestampMs < 0) baseTimestampMs = timestampMs;
            }
            break;
          }
          case 2: {
            const raw = op.littleEndian ? readI32LE(bytes, o) : readI32BE(bytes, o);
            if (raw !== 0x7fffffff) lat = compactCoordFromSemicircles(raw);
            break;
          }
          case 3: {
            const raw = op.littleEndian ? readI32LE(bytes, o) : readI32BE(bytes, o);
            if (raw !== 0x7fffffff) lng = compactCoordFromSemicircles(raw);
            break;
          }
          case 4:
          case 12: {
            const raw = op.littleEndian ? readU16LE(bytes, o) : readU16BE(bytes, o);
            if (raw !== 0xffff) altitude = compactAltitude(raw / 5 - 500);
            break;
          }
          case 5:
            if (bytes[o] !== 0xff) heartRate = bytes[o];
            break;
          case 6:
            if (bytes[o] !== 0xff) cadence = bytes[o];
            break;
          case 7: {
            const raw = op.littleEndian ? readU32LE(bytes, o) : readU32BE(bytes, o);
            if (raw !== 0xffffffff) distance = compactDistance(raw / 100);
            break;
          }
          case 8:
          case 11: {
            const raw = op.littleEndian ? readU16LE(bytes, o) : readU16BE(bytes, o);
            if (raw !== 0xffff) speed = Math.min(0xfffe, Math.round(raw / 10));
            break;
          }
          case 9: {
            const raw = op.littleEndian ? readU16LE(bytes, o) : readU16BE(bytes, o);
            if (raw !== 0xffff) power = Math.min(0xfffe, raw);
            break;
          }
          default:
            break;
        }
      }

      timestampsMs.push(Number.isFinite(timestampMs) ? timestampMs : Number.NaN);
      distancesQ.push(distance);
      powersW.push(power);
      heartRatesBpm.push(heartRate);
      cadencesRpm.push(cadence);
      speedsCmS.push(speed);
      altitudesQ.push(altitude);
      positionLatsE6.push(lat);
      positionLongsE6.push(lng);
    } else if (definition.globalMessage === 18) {
      const session = {};
      const view = new DataView(bytes.buffer, bytes.byteOffset + dataOffset);
      for (const op of definition.sessionOps || []) {
        const raw = readRawFitValue(view, op.offset, op.size, op.baseType, op.littleEndian);
        session[op.field] = decodeSessionValue(raw, op);
      }
      sessions.push(session);
    }

    cursor += 1 + definition.messageBytes;
  }

  let minStartTimeMs = Number.POSITIVE_INFINITY;
  for (const session of sessions) {
    const value = Number(session?.start_time);
    if (Number.isFinite(value) && value < minStartTimeMs) {
      minStartTimeMs = value;
    }
  }
  const startTimeKey = toIsoStartTimeKey(minStartTimeMs);
  if (excluded && startTimeKey && excluded.has(startTimeKey)) {
    return {
      skippedExisting: true,
      skippedStartTime: startTimeKey,
      sessions,
      compactRecords: null,
    };
  }

  return {
    skippedExisting: false,
    skippedStartTime: null,
    sessions,
    compactRecords: {
      recordCount: timestampsMs.length,
      baseTimestampMs: baseTimestampMs < 0 ? 0 : baseTimestampMs,
      timestampsMs: Float64Array.from(timestampsMs),
      distancesQ: Uint32Array.from(distancesQ),
      powersW: Uint16Array.from(powersW),
      heartRatesBpm: Uint8Array.from(heartRatesBpm),
      cadencesRpm: Uint8Array.from(cadencesRpm),
      speedsCmS: Uint16Array.from(speedsCmS),
      altitudesQ: dropAllZeroAltitudeColumn(Int16Array.from(altitudesQ)),
      positionLatsE6: Int32Array.from(positionLatsE6),
      positionLongsE6: Int32Array.from(positionLongsE6),
    },
  };
}

export function materializeCompactToParsed(parsedCompact) {
  const compact = parsedCompact?.compactRecords;
  if (!compact) {
    return {
      sessions: Array.isArray(parsedCompact?.sessions) ? parsedCompact.sessions : [],
      recordsTyped: {
        recordCount: 0,
        timestampsMs: new Float64Array(0),
        distancesM: new Float64Array(0),
        powersW: new Float64Array(0),
        heartRatesBpm: new Float64Array(0),
        cadencesRpm: new Float64Array(0),
        speedsMps: new Float64Array(0),
        altitudesM: new Float64Array(0),
        positionLatsDeg: new Float64Array(0),
        positionLongsDeg: new Float64Array(0),
      },
      recordsAreSorted: true,
    };
  }

  const recordCount = Number(compact.recordCount || 0);
  const distancesM = new Float64Array(recordCount);
  const powers = new Float64Array(recordCount);
  const heartRates = new Float64Array(recordCount);
  const cadences = new Float64Array(recordCount);
  const speeds = new Float64Array(recordCount);
  const altitudes = new Float64Array(recordCount);
  const lats = new Float64Array(recordCount);
  const lngs = new Float64Array(recordCount);

  for (let index = 0; index < recordCount; index += 1) {
    distancesM[index] = compact.distancesQ[index] === COMPACT_SENTINELS.uint32 ? Number.NaN : compact.distancesQ[index] / 4;
    powers[index] = compact.powersW[index] === COMPACT_SENTINELS.uint16 ? Number.NaN : compact.powersW[index];
    heartRates[index] = compact.heartRatesBpm[index] === COMPACT_SENTINELS.uint8 ? Number.NaN : compact.heartRatesBpm[index];
    cadences[index] = compact.cadencesRpm[index] === COMPACT_SENTINELS.uint8 ? Number.NaN : compact.cadencesRpm[index];
    speeds[index] = compact.speedsCmS[index] === COMPACT_SENTINELS.uint16 ? Number.NaN : compact.speedsCmS[index] / 100;
    altitudes[index] = compact.altitudesQ[index] === COMPACT_SENTINELS.int16 ? Number.NaN : compact.altitudesQ[index] / 4;
    lats[index] = compact.positionLatsE6[index] === COMPACT_SENTINELS.int32 ? Number.NaN : compact.positionLatsE6[index] / 1000000;
    lngs[index] = compact.positionLongsE6[index] === COMPACT_SENTINELS.int32 ? Number.NaN : compact.positionLongsE6[index] / 1000000;
  }

  return {
    sessions: Array.isArray(parsedCompact?.sessions) ? parsedCompact.sessions : [],
    recordsTyped: {
      recordCount,
      timestampsMs: compact.timestampsMs,
      distancesM,
      powersW: powers,
      heartRatesBpm: heartRates,
      cadencesRpm: cadences,
      speedsMps: speeds,
      altitudesM: altitudes,
      positionLatsDeg: lats,
      positionLongsDeg: lngs,
    },
    recordsAreSorted: true,
  };
}

function quantizeCompactUintArray(sourceArray, step, sentinel, maxValue) {
  const normalizedStep = Math.max(1, Number.parseInt(String(step ?? 1), 10) || 1);
  if (normalizedStep <= 1 || !sourceArray) {
    return sourceArray;
  }

  const quantizedValues = new sourceArray.constructor(sourceArray.length);
  for (let index = 0; index < sourceArray.length; index += 1) {
    const value = Number(sourceArray[index]);
    if (!Number.isFinite(value) || value === sentinel) {
      quantizedValues[index] = sentinel;
      continue;
    }
    quantizedValues[index] = Math.max(0, Math.min(maxValue, Math.round(value / normalizedStep) * normalizedStep));
  }
  return quantizedValues;
}

export function applyCompactEncodingOptions(parsedCompact, encodingOptions = {}) {
  const compact = parsedCompact?.compactRecords;
  if (!compact || !Number.isFinite(Number(compact.recordCount))) {
    return parsedCompact;
  }

  const powerStep = Math.max(1, Number.parseInt(String(encodingOptions.powerStep ?? 4), 10) || 4);
  const cadenceStep = Math.max(1, Number.parseInt(String(encodingOptions.cadenceStep ?? 2), 10) || 2);
  const hrStep = Math.max(1, Number.parseInt(String(encodingOptions.hrStep ?? 2), 10) || 2);

  return {
    ...parsedCompact,
    compactRecords: {
      ...compact,
      powersW: quantizeCompactUintArray(compact.powersW, powerStep, COMPACT_SENTINELS.uint16, COMPACT_SENTINELS.uint16 - 1),
      cadencesRpm: quantizeCompactUintArray(compact.cadencesRpm, cadenceStep, COMPACT_SENTINELS.uint8, COMPACT_SENTINELS.uint8 - 1),
      heartRatesBpm: quantizeCompactUintArray(compact.heartRatesBpm, hrStep, COMPACT_SENTINELS.uint8, COMPACT_SENTINELS.uint8 - 1),
    },
  };
}
