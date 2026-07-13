import { FIT } from "../../../vendor/fit-file-parser-fast/dist/fit.js";

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

function compactTimestampSecFromGarmin(rawTimestampSec) {
  if (!Number.isFinite(rawTimestampSec) || rawTimestampSec < 0) {
    return COMPACT_SENTINELS.uint32;
  }
  const unixTimestampSec = Math.round(rawTimestampSec + (GARMIN_TIME_OFFSET_MS / 1000));
  return Math.max(0, Math.min(COMPACT_SENTINELS.uint32 - 1, unixTimestampSec));
}

function compactTimestampMsFromSec(timestampSec) {
  return Number.isFinite(Number(timestampSec)) && Number(timestampSec) !== COMPACT_SENTINELS.uint32
    ? Number(timestampSec) * 1000
    : Number.NaN;
}

const INITIAL_RECORD_BUFFER_CAPACITY = 7200;

function createCompactRecordBuffer(initialCapacity = INITIAL_RECORD_BUFFER_CAPACITY) {
  const capacity = Math.max(1, Number(initialCapacity) || INITIAL_RECORD_BUFFER_CAPACITY);
  return {
    length: 0,
    capacity,
    timestampsSec: new Uint32Array(capacity),
    distancesQ: new Uint32Array(capacity),
    powersW: new Uint16Array(capacity),
    heartRatesBpm: new Uint8Array(capacity),
    cadencesRpm: new Uint8Array(capacity),
    speedsCmS: new Uint16Array(capacity),
    altitudesQ: new Int16Array(capacity),
    positionLatsE6: new Int32Array(capacity),
    positionLongsE6: new Int32Array(capacity),
  };
}

function growCompactRecordBuffer(buffer, minimumCapacity = 0) {
  const nextCapacity = Math.max(
    Math.max(1, buffer?.capacity || 0) * 2,
    Number(minimumCapacity) || 0,
    INITIAL_RECORD_BUFFER_CAPACITY
  );
  const next = createCompactRecordBuffer(nextCapacity);
  next.length = Number(buffer?.length || 0);
  next.timestampsSec.set(buffer.timestampsSec.subarray(0, next.length));
  next.distancesQ.set(buffer.distancesQ.subarray(0, next.length));
  next.powersW.set(buffer.powersW.subarray(0, next.length));
  next.heartRatesBpm.set(buffer.heartRatesBpm.subarray(0, next.length));
  next.cadencesRpm.set(buffer.cadencesRpm.subarray(0, next.length));
  next.speedsCmS.set(buffer.speedsCmS.subarray(0, next.length));
  next.altitudesQ.set(buffer.altitudesQ.subarray(0, next.length));
  next.positionLatsE6.set(buffer.positionLatsE6.subarray(0, next.length));
  next.positionLongsE6.set(buffer.positionLongsE6.subarray(0, next.length));
  return next;
}

function ensureCompactRecordCapacity(buffer, requiredLength) {
  if (requiredLength <= buffer.capacity) {
    return buffer;
  }
  return growCompactRecordBuffer(buffer, requiredLength);
}

function appendCompactRecord(buffer, {
  timestampSec,
  distance,
  power,
  heartRate,
  cadence,
  speed,
  altitude,
  lat,
  lng,
}) {
  const nextLength = buffer.length + 1;
  const target = ensureCompactRecordCapacity(buffer, nextLength);
  const index = target.length;
  target.timestampsSec[index] = timestampSec;
  target.distancesQ[index] = distance;
  target.powersW[index] = power;
  target.heartRatesBpm[index] = heartRate;
  target.cadencesRpm[index] = cadence;
  target.speedsCmS[index] = speed;
  target.altitudesQ[index] = altitude;
  target.positionLatsE6[index] = lat;
  target.positionLongsE6[index] = lng;
  target.length = nextLength;
  return target;
}

function finalizeCompactRecordBuffer(buffer, baseTimestampSec) {
  const recordCount = Number(buffer?.length || 0);
  return {
    recordCount,
    baseTimestampSec: baseTimestampSec === COMPACT_SENTINELS.uint32 ? 0 : baseTimestampSec,
    lastTimestampSec: recordCount > 0 ? buffer.timestampsSec[recordCount - 1] : 0,
    timestampsSec: buffer.timestampsSec.slice(0, recordCount),
    distancesQ: buffer.distancesQ.slice(0, recordCount),
    powersW: buffer.powersW.slice(0, recordCount),
    heartRatesBpm: buffer.heartRatesBpm.slice(0, recordCount),
    cadencesRpm: buffer.cadencesRpm.slice(0, recordCount),
    speedsCmS: buffer.speedsCmS.slice(0, recordCount),
    altitudesQ: dropAllZeroAltitudeColumn(buffer.altitudesQ.slice(0, recordCount)),
    positionLatsE6: buffer.positionLatsE6.slice(0, recordCount),
    positionLongsE6: buffer.positionLongsE6.slice(0, recordCount),
  };
}

function fillGapsCompactRecords(compactRecords) {
  const recordCount = Number(compactRecords?.recordCount || 0);
  const timestampsSec = compactRecords?.timestampsSec;
  if (!(recordCount > 1) || !timestampsSec || timestampsSec.length !== recordCount) {
    return compactRecords;
  }

  const maxGap = 5;

  const lerp = (left, right, ratio, fallback = Number.NaN) => {
    const leftValid = Number.isFinite(left);
    const rightValid = Number.isFinite(right);
    if (!leftValid && !rightValid) return fallback;
    if (!leftValid) return right;
    if (!rightValid) return left;
    return left + ((right - left) * ratio);
  };

  const decodeUint32Sentinel = (value) => value !== COMPACT_SENTINELS.uint32 ? Number(value) : Number.NaN;
  const decodeUint16Sentinel = (value) => value !== COMPACT_SENTINELS.uint16 ? Number(value) : Number.NaN;
  const decodeUint8Sentinel = (value) => value !== COMPACT_SENTINELS.uint8 ? Number(value) : Number.NaN;
  const decodeInt16Sentinel = (value) => value !== COMPACT_SENTINELS.int16 ? Number(value) : Number.NaN;

  const encodeUint32 = (value) => Number.isFinite(value)
    ? Math.max(0, Math.min(COMPACT_SENTINELS.uint32 - 1, Math.round(value)))
    : COMPACT_SENTINELS.uint32;
  const encodeUint16 = (value) => Number.isFinite(value)
    ? Math.max(0, Math.min(COMPACT_SENTINELS.uint16 - 1, Math.round(value)))
    : COMPACT_SENTINELS.uint16;
  const encodeUint8 = (value) => Number.isFinite(value)
    ? Math.max(0, Math.min(COMPACT_SENTINELS.uint8 - 1, Math.round(value)))
    : COMPACT_SENTINELS.uint8;
  const encodeInt16 = (value) => Number.isFinite(value)
    ? Math.max(-32767, Math.min(32767, Math.round(value)))
    : COMPACT_SENTINELS.int16;

  const countInterpolatedSteps = () => {
    let interpolatedCount = 0;
    for (let index = 0; index < recordCount - 1; index += 1) {
      const t0Sec = Number(timestampsSec[index]);
      const t1Sec = Number(timestampsSec[index + 1]);
      if (!Number.isFinite(t0Sec) || !Number.isFinite(t1Sec) || t0Sec === COMPACT_SENTINELS.uint32 || t1Sec === COMPACT_SENTINELS.uint32) {
        continue;
      }

      const gap = t1Sec - t0Sec;
      if (gap > 1 && gap <= maxGap) {
        interpolatedCount += gap - 1;
      }
    }
    return interpolatedCount;
  };

  const outputRecordCount = recordCount + countInterpolatedSteps();
  if (outputRecordCount === recordCount) {
    return compactRecords;
  }

  const outTimestampsSec = new Uint32Array(outputRecordCount);
  const outDistancesQ = new Uint32Array(outputRecordCount);
  const outPowersW = new Uint16Array(outputRecordCount);
  const outHeartRatesBpm = new Uint8Array(outputRecordCount);
  const outCadencesRpm = new Uint8Array(outputRecordCount);
  const outSpeedsCmS = new Uint16Array(outputRecordCount);
  const outAltitudesQ = new Int16Array(outputRecordCount);
  const outPositionLatsE6 = new Int32Array(outputRecordCount);
  const outPositionLongsE6 = new Int32Array(outputRecordCount);

  const pushRecord = (writeIndex, sourceIndex) => {
    outTimestampsSec[writeIndex] = Number(timestampsSec[sourceIndex]);
    outDistancesQ[writeIndex] = Number(compactRecords.distancesQ[sourceIndex]);
    outPowersW[writeIndex] = Number(compactRecords.powersW[sourceIndex]);
    outHeartRatesBpm[writeIndex] = Number(compactRecords.heartRatesBpm[sourceIndex]);
    outCadencesRpm[writeIndex] = Number(compactRecords.cadencesRpm[sourceIndex]);
    outSpeedsCmS[writeIndex] = Number(compactRecords.speedsCmS[sourceIndex]);
    outAltitudesQ[writeIndex] = Number(compactRecords.altitudesQ[sourceIndex]);
    outPositionLatsE6[writeIndex] = Number(compactRecords.positionLatsE6[sourceIndex]);
    outPositionLongsE6[writeIndex] = Number(compactRecords.positionLongsE6[sourceIndex]);
    return writeIndex + 1;
  };

  let writeIndex = 0;
  for (let index = 0; index < recordCount - 1; index += 1) {
    writeIndex = pushRecord(writeIndex, index);

    const t0Sec = Number(timestampsSec[index]);
    const t1Sec = Number(timestampsSec[index + 1]);
    if (!Number.isFinite(t0Sec) || !Number.isFinite(t1Sec) || t0Sec === COMPACT_SENTINELS.uint32 || t1Sec === COMPACT_SENTINELS.uint32) {
      continue;
    }

    const gap = t1Sec - t0Sec;
    if (gap > 1 && gap <= maxGap) {
      const steps = gap - 1;
      for (let step = 1; step <= steps; step += 1) {
        const ratio = step / gap;
        outTimestampsSec[writeIndex] = t0Sec + step;
        outDistancesQ[writeIndex] = encodeUint32(lerp(
          decodeUint32Sentinel(compactRecords.distancesQ[index]),
          decodeUint32Sentinel(compactRecords.distancesQ[index + 1]),
          ratio,
          Number.NaN
        ));
        outPowersW[writeIndex] = encodeUint16(lerp(
          decodeUint16Sentinel(compactRecords.powersW[index]),
          decodeUint16Sentinel(compactRecords.powersW[index + 1]),
          ratio,
          0
        ));
        outHeartRatesBpm[writeIndex] = encodeUint8(lerp(
          decodeUint8Sentinel(compactRecords.heartRatesBpm[index]),
          decodeUint8Sentinel(compactRecords.heartRatesBpm[index + 1]),
          ratio,
          Number.NaN
        ));
        outCadencesRpm[writeIndex] = encodeUint8(lerp(
          decodeUint8Sentinel(compactRecords.cadencesRpm[index]),
          decodeUint8Sentinel(compactRecords.cadencesRpm[index + 1]),
          ratio,
          Number.NaN
        ));
        outSpeedsCmS[writeIndex] = encodeUint16(lerp(
          decodeUint16Sentinel(compactRecords.speedsCmS[index]),
          decodeUint16Sentinel(compactRecords.speedsCmS[index + 1]),
          ratio,
          Number.NaN
        ));
        outAltitudesQ[writeIndex] = encodeInt16(lerp(
          decodeInt16Sentinel(compactRecords.altitudesQ[index]),
          decodeInt16Sentinel(compactRecords.altitudesQ[index + 1]),
          ratio,
          Number.NaN
        ));
        outPositionLatsE6[writeIndex] = COMPACT_SENTINELS.int32;
        outPositionLongsE6[writeIndex] = COMPACT_SENTINELS.int32;
        writeIndex += 1;
      }
    }
  }

  writeIndex = pushRecord(writeIndex, recordCount - 1);

  return {
    ...compactRecords,
    recordCount: writeIndex,
    baseTimestampSec: writeIndex > 0 ? outTimestampsSec[0] : 0,
    lastTimestampSec: writeIndex > 0 ? outTimestampsSec[writeIndex - 1] : 0,
    timestampsSec: outTimestampsSec,
    distancesQ: outDistancesQ,
    powersW: outPowersW,
    heartRatesBpm: outHeartRatesBpm,
    cadencesRpm: outCadencesRpm,
    speedsCmS: outSpeedsCmS,
    altitudesQ: dropAllZeroAltitudeColumn(outAltitudesQ),
    positionLatsE6: outPositionLatsE6,
    positionLongsE6: outPositionLongsE6
  };
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
  let compactRecordBuffer = createCompactRecordBuffer();
  const sessions = [];
  let baseTimestampSec = COMPACT_SENTINELS.uint32;
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
      let timestampSec = COMPACT_SENTINELS.uint32;
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
              timestampSec = compactTimestampSecFromGarmin(raw);
              if (baseTimestampSec === COMPACT_SENTINELS.uint32) baseTimestampSec = timestampSec;
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

      compactRecordBuffer = appendCompactRecord(compactRecordBuffer, {
        timestampSec,
        distance,
        power,
        heartRate,
        cadence,
        speed,
        altitude,
        lat,
        lng,
      });
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
    compactRecords: fillGapsCompactRecords(
      finalizeCompactRecordBuffer(compactRecordBuffer, baseTimestampSec)
    ),
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
