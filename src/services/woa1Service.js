import Workout from "../shared/Workout.js";
import FitProcessor, { mapAggregatedToFileRow } from "./fitService.js";

const UINT8_NAN = 0xFF;
const UINT16_NAN = 0xFFFF;
const UINT32_NAN = 0xFFFFFFFF;
const INT16_NAN = -0x8000;
const INT32_NAN = -0x80000000;
const WOA_RLE_DELTA_ESCAPE = 127;
const MICRO_DEGREES = 1e6;
const ALTITUDE_SCALE = 4;
const DISTANCE_SCALE = 4;
const TEXT_DECODER = new TextDecoder();
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

function readJsonBlock(bytes, offset, length) {
  const slice = bytes.subarray(offset, offset + length);
  return JSON.parse(TEXT_DECODER.decode(slice));
}

function decodeSessionBlock(bytes, offset, length) {
  if (length <= 0) {
    return [];
  }

  const slice = bytes.subarray(offset, offset + length);
  const magic = TEXT_DECODER.decode(slice.subarray(0, Math.min(4, slice.byteLength)));
  if (magic !== "SES1") {
    const parsed = JSON.parse(TEXT_DECODER.decode(slice));
    return Array.isArray(parsed) ? parsed : [];
  }

  const view = new DataView(slice.buffer, slice.byteOffset, slice.byteLength);
  const recordSize = view.getUint16(6, true);
  const sessionCount = view.getUint32(8, true);
  let readOffset = 12;
  const sessions = [];

  for (let index = 0; index < sessionCount; index += 1) {
    const session = {};
    for (const field of SESSION_SPEC) {
      switch (field.type) {
        case "time": {
          const raw = view.getUint32(readOffset, true);
          readOffset += 4;
          session[field.key] = raw === UINT32_NAN ? null : new Date(raw * 1000).toISOString();
          break;
        }
        case "scaled-uint32": {
          const raw = view.getUint32(readOffset, true);
          readOffset += 4;
          session[field.key] = raw === UINT32_NAN ? null : raw / field.scale;
          break;
        }
        case "uint32": {
          const raw = view.getUint32(readOffset, true);
          readOffset += 4;
          session[field.key] = raw === UINT32_NAN ? null : raw;
          break;
        }
        case "scaled-uint16": {
          const raw = view.getUint16(readOffset, true);
          readOffset += 2;
          session[field.key] = raw === UINT16_NAN ? null : raw / field.scale;
          break;
        }
        case "uint16": {
          const raw = view.getUint16(readOffset, true);
          readOffset += 2;
          session[field.key] = raw === UINT16_NAN ? null : raw;
          break;
        }
        case "uint8": {
          const raw = view.getUint8(readOffset);
          readOffset += 1;
          session[field.key] = raw === UINT8_NAN ? null : raw;
          break;
        }
        case "coord": {
          const raw = view.getInt32(readOffset, true);
          readOffset += 4;
          session[field.key] = raw === INT32_NAN ? null : raw / SESSION_COORD_SCALE;
          break;
        }
        case "bool":
          session[field.key] = view.getUint8(readOffset) === 1;
          readOffset += 1;
          break;
        default:
          break;
      }
    }

    sessions.push(session);
    const expectedOffset = 12 + ((index + 1) * recordSize);
    if (readOffset < expectedOffset) {
      readOffset = expectedOffset;
    }
  }

  return sessions;
}

export function inspectWoa1Header(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = TEXT_DECODER.decode(bytes.subarray(0, 4));
  if (magic !== "WOA1") {
    throw new Error(`Unsupported WOA container: ${magic}`);
  }

  return {
    magic,
    majorVersion: view.getUint8(4),
    minorVersion: view.getUint8(5),
    metaLength: view.getUint32(8, true),
    sessionLength: view.getUint32(12, true),
    workoutStreamLength: view.getUint32(16, true),
    gpsTrackLength: view.getUint32(20, true),
    headerLength: 24
  };
}

function decodeDistancePayload(bytes, recordCount) {
  const values = new Float64Array(recordCount);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  let writeIndex = 0;
  const DISTANCE_ESCAPE = 255;

  while (offset < bytes.byteLength && writeIndex < recordCount) {
    const mode = view.getUint8(offset);
    const count = view.getUint16(offset + 1, true);
    offset += 3;

    if (mode === 1) {
      let current = view.getUint32(offset, true);
      offset += 4;
      values[writeIndex] = current === UINT32_NAN ? Number.NaN : current / DISTANCE_SCALE;
      writeIndex += 1;

      for (let i = 1; i < count && writeIndex < recordCount; i += 1) {
        const delta = view.getInt16(offset, true);
        offset += 2;
        current += delta;
        values[writeIndex] = current === UINT32_NAN ? Number.NaN : current / DISTANCE_SCALE;
        writeIndex += 1;
      }
      continue;
    }

    if (mode === 2) {
      let current = view.getUint32(offset, true);
      offset += 4;
      values[writeIndex] = current === UINT32_NAN ? Number.NaN : current / 5;
      writeIndex += 1;

      for (let i = 1; i < count && writeIndex < recordCount; i += 1) {
        const delta = view.getUint8(offset);
        offset += 1;
        current += delta;
        values[writeIndex] = current === UINT32_NAN ? Number.NaN : current / 5;
        writeIndex += 1;
      }
      continue;
    }

    if (mode === 3) {
      let current = view.getUint32(offset, true);
      offset += 4;
      values[writeIndex] = current === UINT32_NAN ? Number.NaN : current / 5;
      writeIndex += 1;

      const tokenStart = offset;
      const tokenCount = Math.max(0, count - 1);
      const absoluteTailStart = tokenStart + tokenCount;
      let absoluteTailOffset = absoluteTailStart;

      for (let i = 1; i < count && writeIndex < recordCount; i += 1) {
        const token = view.getUint8(tokenStart + i - 1);
        if (token === DISTANCE_ESCAPE) {
          current = view.getUint32(absoluteTailOffset, true);
          absoluteTailOffset += 4;
        } else {
          current += token;
        }
        values[writeIndex] = current === UINT32_NAN ? Number.NaN : current / 5;
        writeIndex += 1;
      }

      offset = absoluteTailOffset;
      continue;
    }

    for (let i = 0; i < count && writeIndex < recordCount; i += 1) {
      const raw = view.getUint32(offset, true);
      offset += 4;
      values[writeIndex] = raw === UINT32_NAN ? Number.NaN : raw / DISTANCE_SCALE;
      writeIndex += 1;
    }
  }

  return values;
}

function decodeUint8RunLengthDeltaBlock(view, offset, blockLength, recordCount, output) {
  const blockEnd = offset + blockLength;
  const runCount = view.getUint32(offset, true);
  offset += 4;
  const lengthsOffset = offset;
  const valuesOffset = lengthsOffset + runCount;
  const tokenOffset = valuesOffset + 1;
  let absoluteOffset = tokenOffset + Math.max(0, runCount - 1);
  let currentValue = runCount > 0 ? view.getUint8(valuesOffset) : UINT8_NAN;
  let writeIndex = 0;
  for (let runIndex = 0; runIndex < runCount && writeIndex < recordCount; runIndex += 1) {
    if (runIndex > 0) {
      const token = view.getInt8(tokenOffset + runIndex - 1);
      if (token === WOA_RLE_DELTA_ESCAPE) {
        if (absoluteOffset + 1 > blockEnd) {
          throw new Error("Corrupt WST9 uint8 RLE block: missing absolute fallback value");
        }
        currentValue = view.getUint8(absoluteOffset);
        absoluteOffset += 1;
      } else if (currentValue !== UINT8_NAN) {
        currentValue += token;
      } else {
        currentValue = UINT8_NAN;
      }
    }
    const runLength = view.getUint8(lengthsOffset + runIndex);
    for (let i = 0; i < runLength && writeIndex < recordCount; i += 1) {
      output[writeIndex] = currentValue === UINT8_NAN ? Number.NaN : currentValue;
      writeIndex += 1;
    }
  }
  return blockEnd;
}

function decodeInt16RunLengthDeltaBlock(view, offset, blockLength, recordCount, output) {
  const blockEnd = offset + blockLength;
  const runCount = view.getUint32(offset, true);
  offset += 4;
  const lengthsOffset = offset;
  const valuesOffset = lengthsOffset + runCount;
  const tokenOffset = valuesOffset + 2;
  let absoluteOffset = tokenOffset + Math.max(0, runCount - 1);
  let currentValue = runCount > 0 ? view.getInt16(valuesOffset, true) : INT16_NAN;
  let writeIndex = 0;
  for (let runIndex = 0; runIndex < runCount && writeIndex < recordCount; runIndex += 1) {
    if (runIndex > 0) {
      const token = view.getInt8(tokenOffset + runIndex - 1);
      if (token === WOA_RLE_DELTA_ESCAPE) {
        if (absoluteOffset + 2 > blockEnd) {
          throw new Error("Corrupt WST9 altitude block: missing absolute fallback value");
        }
        currentValue = view.getInt16(absoluteOffset, true);
        absoluteOffset += 2;
      } else if (currentValue !== INT16_NAN) {
        currentValue += token;
      } else {
        currentValue = INT16_NAN;
      }
    }
    const runLength = view.getUint8(lengthsOffset + runIndex);
    for (let i = 0; i < runLength && writeIndex < recordCount; i += 1) {
      output[writeIndex] = currentValue === INT16_NAN ? Number.NaN : currentValue;
      writeIndex += 1;
    }
  }
  return blockEnd;
}

function decodeDistanceDeltaRlePayload(bytes, recordCount) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values = new Float64Array(recordCount);
  if (recordCount <= 0) {
    return values;
  }
  let offset = 0;
  const totalCount = view.getUint32(offset, true);
  offset += 4;
  let current = view.getUint32(offset, true);
  offset += 4;
  values[0] = current === UINT32_NAN ? Number.NaN : current / 5;
  const deltaCount = Math.max(0, Math.min(totalCount, recordCount) - 1);
  const runLengthsOffset = offset;
  const tokenOffset = runLengthsOffset + deltaCount;
  let absoluteOffset = tokenOffset + deltaCount;
  let writeIndex = 1;
  for (let runIndex = 0; runIndex < deltaCount && writeIndex < recordCount; runIndex += 1) {
    const runLength = view.getUint8(runLengthsOffset + runIndex);
    const token = view.getUint8(tokenOffset + runIndex);
    const delta = token === 255 ? view.getUint32(absoluteOffset, true) : token;
    if (token === 255) {
      absoluteOffset += 4;
    }
    for (let i = 0; i < runLength && writeIndex < recordCount; i += 1) {
      current += delta;
      values[writeIndex] = current === UINT32_NAN ? Number.NaN : current / 5;
      writeIndex += 1;
    }
  }
  return values;
}

function decodePowerDeltaRleInt8Q4Payload(bytes, recordCount, output) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (recordCount <= 0) {
    return;
  }
  let offset = 0;
  output[0] = view.getUint16(offset, true);
  offset += 2;
  const runCount = view.getUint32(offset, true);
  offset += 4;
  const lengthsOffset = offset;
  const tokenOffset = lengthsOffset + runCount;
  let absoluteOffset = tokenOffset + runCount;
  let writeIndex = 1;
  let currentValue = output[0];
  for (let runIndex = 0; runIndex < runCount && writeIndex < recordCount; runIndex += 1) {
    const runLength = view.getUint8(lengthsOffset + runIndex);
    const token = view.getInt8(tokenOffset + runIndex);
    let nextValue;
    if (token === WOA_RLE_DELTA_ESCAPE) {
      nextValue = view.getUint16(absoluteOffset, true);
      absoluteOffset += 2;
    } else if (Number.isFinite(currentValue)) {
      nextValue = currentValue + (token * 4);
    } else {
      nextValue = Number.NaN;
    }
    for (let i = 0; i < runLength && writeIndex < recordCount; i += 1) {
      output[writeIndex] = nextValue;
      writeIndex += 1;
    }
    currentValue = nextValue;
  }
}

function decodeGpsCoordinatePayload(bytes, pointCount, layoutVersion = 1) {
  const latitudes = new Float64Array(pointCount);
  const longitudes = new Float64Array(pointCount);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  let writeIndex = 0;

  while (offset < bytes.byteLength && writeIndex < pointCount) {
    const mode = view.getUint8(offset);
    const count = view.getUint16(offset + 1, true);
    offset += 3;

    if (layoutVersion >= 2) {
      if (mode === 1) {
        let currentLat = view.getInt32(offset, true);
        offset += 4;
        latitudes[writeIndex] = currentLat === INT32_NAN ? Number.NaN : currentLat / MICRO_DEGREES;
        for (let i = 1; i < count && (writeIndex + i) < pointCount; i += 1) {
          currentLat += view.getInt16(offset, true);
          offset += 2;
          latitudes[writeIndex + i] = currentLat === INT32_NAN ? Number.NaN : currentLat / MICRO_DEGREES;
        }

        let currentLng = view.getInt32(offset, true);
        offset += 4;
        longitudes[writeIndex] = currentLng === INT32_NAN ? Number.NaN : currentLng / MICRO_DEGREES;
        for (let i = 1; i < count && (writeIndex + i) < pointCount; i += 1) {
          currentLng += view.getInt16(offset, true);
          offset += 2;
          longitudes[writeIndex + i] = currentLng === INT32_NAN ? Number.NaN : currentLng / MICRO_DEGREES;
        }

        writeIndex += count;
        continue;
      }

      for (let i = 0; i < count && (writeIndex + i) < pointCount; i += 1) {
        const rawLat = view.getInt32(offset, true);
        offset += 4;
        latitudes[writeIndex + i] = rawLat === INT32_NAN ? Number.NaN : rawLat / MICRO_DEGREES;
      }
      for (let i = 0; i < count && (writeIndex + i) < pointCount; i += 1) {
        const rawLng = view.getInt32(offset, true);
        offset += 4;
        longitudes[writeIndex + i] = rawLng === INT32_NAN ? Number.NaN : rawLng / MICRO_DEGREES;
      }
      writeIndex += count;
      continue;
    }

    if (mode === 1) {
      let currentLat = view.getInt32(offset, true);
      offset += 4;
      let currentLng = view.getInt32(offset, true);
      offset += 4;
      latitudes[writeIndex] = currentLat === INT32_NAN ? Number.NaN : currentLat / MICRO_DEGREES;
      longitudes[writeIndex] = currentLng === INT32_NAN ? Number.NaN : currentLng / MICRO_DEGREES;
      writeIndex += 1;

      for (let i = 1; i < count && writeIndex < pointCount; i += 1) {
        currentLat += view.getInt16(offset, true);
        offset += 2;
        currentLng += view.getInt16(offset, true);
        offset += 2;
        latitudes[writeIndex] = currentLat === INT32_NAN ? Number.NaN : currentLat / MICRO_DEGREES;
        longitudes[writeIndex] = currentLng === INT32_NAN ? Number.NaN : currentLng / MICRO_DEGREES;
        writeIndex += 1;
      }
      continue;
    }

    for (let i = 0; i < count && writeIndex < pointCount; i += 1) {
      const rawLat = view.getInt32(offset, true);
      offset += 4;
      const rawLng = view.getInt32(offset, true);
      offset += 4;
      latitudes[writeIndex] = rawLat === INT32_NAN ? Number.NaN : rawLat / MICRO_DEGREES;
      longitudes[writeIndex] = rawLng === INT32_NAN ? Number.NaN : rawLng / MICRO_DEGREES;
      writeIndex += 1;
    }
  }

  return { latitudes, longitudes };
}

function decodeWorkoutStreamBlock(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = TEXT_DECODER.decode(bytes.subarray(0, 4));
  if (magic !== "WST2" && magic !== "WST3" && magic !== "WST4" && magic !== "WST5" && magic !== "WST6" && magic !== "WST7" && magic !== "WST8" && magic !== "WST9") {
    throw new Error(`Unsupported workout stream block: ${magic}`);
  }
  const isWst3 = magic === "WST3";
  const isWst4 = magic === "WST4" || magic === "WST6" || magic === "WST7" || magic === "WST8" || magic === "WST9";
  const isWst7 = magic === "WST7" || magic === "WST8" || magic === "WST9";
  const isWst8 = magic === "WST8";
  const isWst9 = magic === "WST9";
  const usesInt8PowerDelta = isWst8 || isWst9;
  const compactHeader = isWst3 || isWst4 || magic === "WST5";

  const recordCount = view.getUint32(4, true);
  const baseTimestampMs = view.getFloat64(8, true);
  const sampleIntervalMs = view.getUint32(16, true);
  const lengths = [];
  let headerOffset = 20;
  for (let i = 0; i < (compactHeader ? 6 : 8); i += 1) {
    lengths.push(view.getUint32(headerOffset, true));
    headerOffset += 4;
  }

  let offset = headerOffset;
  const distancePayload = bytes.subarray(offset, offset + lengths[0]);
  offset += lengths[0];

  const distancesM = decodeDistancePayload(distancePayload, recordCount);

  const powersW = new Float64Array(recordCount);
  if (isWst4) {
    const powerBlockEnd = offset + lengths[1];
    let deltaOffset = offset;
    let absoluteOffset = offset + 2 + Math.max(0, recordCount - 1) * (usesInt8PowerDelta ? 1 : 2);
    if (recordCount > 0) {
      const firstRaw = view.getUint16(deltaOffset, true);
      powersW[0] = firstRaw === UINT16_NAN ? Number.NaN : firstRaw;
      deltaOffset += 2;
    }
    let prev = powersW[0];
    for (let i = 1; i < recordCount; i += 1) {
      const delta = usesInt8PowerDelta ? view.getInt8(deltaOffset) : view.getInt16(deltaOffset, true);
      deltaOffset += usesInt8PowerDelta ? 1 : 2;
      if ((usesInt8PowerDelta && delta === 127) || (!usesInt8PowerDelta && delta === INT16_NAN)) {
        if (absoluteOffset + 2 > powerBlockEnd) {
          throw new Error(`Corrupt ${usesInt8PowerDelta ? magic : "WST4"} power block: missing absolute fallback value`);
        }
        const absoluteRaw = view.getUint16(absoluteOffset, true);
        absoluteOffset += 2;
        powersW[i] = absoluteRaw === UINT16_NAN ? Number.NaN : absoluteRaw;
      } else if (Number.isFinite(prev)) {
        powersW[i] = prev + (usesInt8PowerDelta ? delta * 4 : delta);
      } else {
        powersW[i] = Number.NaN;
      }
      prev = powersW[i];
    }
  } else {
    for (let i = 0; i < recordCount; i += 1) {
      const raw = view.getUint16(offset + (i * 2), true);
      powersW[i] = raw === UINT16_NAN ? Number.NaN : raw;
    }
  }
  offset += lengths[1];

  const heartRatesBpm = new Float64Array(recordCount);
  if (isWst9) {
    offset = decodeUint8RunLengthDeltaBlock(view, offset, lengths[2], recordCount, heartRatesBpm);
  } else {
    for (let i = 0; i < recordCount; i += 1) {
      const raw = view.getUint8(offset + i);
      heartRatesBpm[i] = raw === UINT8_NAN ? Number.NaN : raw;
    }
    offset += lengths[2];
  }

  const cadencesRpm = new Float64Array(recordCount);
  if (isWst9) {
    offset = decodeUint8RunLengthDeltaBlock(view, offset, lengths[3], recordCount, cadencesRpm);
  } else {
    for (let i = 0; i < recordCount; i += 1) {
      const raw = view.getUint8(offset + i);
      cadencesRpm[i] = raw === UINT8_NAN ? Number.NaN : raw;
    }
    offset += lengths[3];
  }

  const hasSpeeds = lengths[4] > 0;
  const speedsMps = new Float64Array(recordCount);
  if (hasSpeeds) {
    for (let i = 0; i < recordCount; i += 1) {
      const raw = view.getUint16(offset + (i * 2), true);
      speedsMps[i] = raw === UINT16_NAN ? Number.NaN : raw / 100;
    }
  }
  offset += lengths[4];

  const altitudesM = new Float64Array(recordCount);
  if (isWst9) {
    offset = decodeInt16RunLengthDeltaBlock(view, offset, lengths[5], recordCount, altitudesM);
  } else if (isWst7) {
    const altitudeBlockEnd = offset + lengths[5];
    let deltaOffset = offset;
    let absoluteOffset = offset + 2 + Math.max(0, recordCount - 1);
    if (recordCount > 0) {
      const firstRaw = view.getInt16(deltaOffset, true);
      altitudesM[0] = firstRaw === INT16_NAN ? Number.NaN : firstRaw;
      deltaOffset += 2;
    }
    let prev = altitudesM[0];
    for (let i = 1; i < recordCount; i += 1) {
      const token = view.getInt8(deltaOffset);
      deltaOffset += 1;
      if (token === 127) {
        if (absoluteOffset + 2 > altitudeBlockEnd) {
          throw new Error("Corrupt WST7 altitude block: missing absolute fallback value");
        }
        const absoluteRaw = view.getInt16(absoluteOffset, true);
        absoluteOffset += 2;
        altitudesM[i] = absoluteRaw === INT16_NAN ? Number.NaN : absoluteRaw;
      } else if (Number.isFinite(prev)) {
        altitudesM[i] = prev + token;
      } else {
        altitudesM[i] = Number.NaN;
      }
      prev = altitudesM[i];
    }
  } else {
    for (let i = 0; i < recordCount; i += 1) {
      const raw = view.getInt16(offset + (i * 2), true);
      altitudesM[i] = raw === INT16_NAN ? Number.NaN : raw / ALTITUDE_SCALE;
    }
  }
  if (!isWst9) {
    offset += lengths[5];
  }

  let positionLatsDeg = null;
  let positionLongsDeg = null;
  if (!isWst3) {
    positionLatsDeg = new Float64Array(recordCount);
    for (let i = 0; i < recordCount; i += 1) {
      const raw = view.getInt32(offset + (i * 4), true);
      positionLatsDeg[i] = raw === INT32_NAN ? Number.NaN : raw / MICRO_DEGREES;
    }
    offset += lengths[6];

    positionLongsDeg = new Float64Array(recordCount);
    for (let i = 0; i < recordCount; i += 1) {
      const raw = view.getInt32(offset + (i * 4), true);
      positionLongsDeg[i] = raw === INT32_NAN ? Number.NaN : raw / MICRO_DEGREES;
    }
  }

  const timestampsMs = new Float64Array(recordCount);
  for (let i = 0; i < recordCount; i += 1) {
    timestampsMs[i] = baseTimestampMs + (i * sampleIntervalMs);
  }

  if (!hasSpeeds) {
    speedsMps[0] = Number.NaN;
    for (let i = 1; i < recordCount; i += 1) {
      const prev = distancesM[i - 1];
      const current = distancesM[i];
      speedsMps[i] = Number.isFinite(prev) && Number.isFinite(current)
        ? Math.max(0, current - prev)
        : Number.NaN;
    }
  }

  return {
    recordCount,
    timestampsMs,
    distancesM,
    powersW,
    heartRatesBpm,
    cadencesRpm,
    speedsMps,
    altitudesM,
    positionLatsDeg,
    positionLongsDeg
  };
}

function decodeGpsTrackBlock(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = TEXT_DECODER.decode(bytes.subarray(0, 4));
  if (magic !== "GPS2") {
    throw new Error(`Unsupported GPS track block: ${magic}`);
  }

  const layoutVersion = view.getUint16(4, true) || 1;
  const sampleRateSeconds = view.getUint16(6, true);
  const pointCount = view.getUint32(8, true);
  const firstTimestampMs = view.getFloat64(12, true);
  const payload = bytes.subarray(20);
  const { latitudes, longitudes } = decodeGpsCoordinatePayload(payload, pointCount, layoutVersion);
  const track = [];

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;

  for (let i = 0; i < pointCount; i += 1) {
    const lat = latitudes[i];
    const lng = longitudes[i];
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      continue;
    }
    track.push([lat, lng]);
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }

  return {
    validGps: track.length > 1,
    pointCount: track.length,
    sampleRate: sampleRateSeconds,
    bbox: track.length > 0 ? { minLat, maxLat, minLng, maxLng } : null,
    firstTimestampMs,
    track
  };
}

export async function decodeWoa1Buffer(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const header = inspectWoa1Header(bytes);
  const {
    majorVersion,
    metaLength,
    sessionLength,
    workoutStreamLength,
    gpsTrackLength,
    headerLength
  } = header;

  let offset = headerLength;
  const meta = readJsonBlock(bytes, offset, metaLength);
  offset += metaLength;
  const sessions = decodeSessionBlock(bytes, offset, sessionLength);
  offset += sessionLength;
  const workoutStreamStoredBytes = bytes.slice(offset, offset + workoutStreamLength);
  offset += workoutStreamLength;
  const gpsTrackStoredBytes = bytes.slice(offset, offset + gpsTrackLength);

  const workoutStreamCodec = String(
    meta?.blockCodecs?.workout_stream
    || meta?.persistedRow?.stream_codec
    || (majorVersion >= 2 ? "gzip" : "identity")
  ).trim().toLowerCase();
  const gpsTrackCodec = String(
    meta?.blockCodecs?.gps_track
    || meta?.persistedRow?.gps_track_blob_codec
    || (majorVersion >= 2 ? "gzip" : "identity")
  ).trim().toLowerCase();

  const workoutStreamBytes = workoutStreamCodec === "gzip" || workoutStreamCodec === "brotli"
    ? new Uint8Array(await Workout.decompress(workoutStreamStoredBytes, workoutStreamCodec))
    : workoutStreamStoredBytes;
  const gpsTrackBytes = gpsTrackCodec === "gzip" || gpsTrackCodec === "brotli"
    ? new Uint8Array(await Workout.decompress(gpsTrackStoredBytes, gpsTrackCodec))
    : gpsTrackStoredBytes;

  const workoutStream = decodeWorkoutStreamBlock(workoutStreamBytes);
  const gpsTrack = decodeGpsTrackBlock(gpsTrackBytes);

  const fitLike = {
    sessions: Array.isArray(sessions) ? sessions : [],
    recordsTyped: workoutStream
  };
  const aggregated = FitProcessor.aggregateSessions(fitLike);
  const workoutOptions = {
    startTimeMs: Number.isFinite(Number(workoutStream.timestampsMs[0])) ? Number(workoutStream.timestampsMs[0]) : Date.now(),
    validGps: !!gpsTrack.validGps
  };
  const workoutObject = Workout.fromTypedArrays(workoutStream, workoutOptions);
  const fileRow = mapAggregatedToFileRow(aggregated, {
    uid: null,
    gps_source: meta?.gpsSource === "manual_lookup" ? "manual_lookup" : null
  }, workoutObject.getNormalizedPower());

  return {
    meta,
    majorVersion,
    sessions: fitLike.sessions,
    recordsTyped: workoutStream,
    aggregated,
    fileRow,
    gpsTrack,
    workoutObject,
    workoutStreamStoredBytes,
    gpsTrackStoredBytes,
    workoutStreamBytes,
    gpsTrackBytes
  };
}

export function decodeWoa1BufferLight(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const header = inspectWoa1Header(bytes);
  const {
    majorVersion,
    minorVersion,
    metaLength,
    sessionLength,
    workoutStreamLength,
    gpsTrackLength,
    headerLength
  } = header;

  let offset = headerLength;
  const meta = readJsonBlock(bytes, offset, metaLength);
  offset += metaLength;
  const sessions = decodeSessionBlock(bytes, offset, sessionLength);
  offset += sessionLength;
  const workoutStreamStoredBytes = bytes.slice(offset, offset + workoutStreamLength);
  offset += workoutStreamLength;
  const gpsTrackStoredBytes = bytes.slice(offset, offset + gpsTrackLength);

  return {
    meta,
    majorVersion,
    minorVersion,
    sessions: Array.isArray(sessions) ? sessions : [],
    workoutStreamStoredBytes,
    gpsTrackStoredBytes
  };
}
