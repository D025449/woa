const textEncoder = new TextEncoder();
const UINT8_NAN = 0xFF;
const UINT16_NAN = 0xFFFF;
const UINT32_NAN = 0xFFFFFFFF;
const INT16_NAN = -0x8000;
const INT32_NAN = -0x80000000;
const MICRO_DEGREES = 1e6;
const DELTA_BLOCK_SIZE = 128;
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
        const delta = current - previous;
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
      view.setUint32(3, values[start], true);
      let offset = 7;
      for (let index = 1; index < count; index += 1) {
        view.setInt16(offset, values[start + index] - values[start + index - 1], true);
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
      view.setUint32(offset, values[start + index], true);
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
  const baseTimestampMs = recordCount > 0 && Number.isFinite(Number(compactRecords.timestampsMs[0]))
    ? Math.round(Number(compactRecords.timestampsMs[0]))
    : 0;
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
  const baseTimestampMs = recordCount > 0 && Number.isFinite(Number(compactRecords.timestampsMs[0]))
    ? Math.round(Number(compactRecords.timestampsMs[0]))
    : 0;
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

function buildDistancePayloadCompactUint8Q02(compactRecords, recordCount) {
  const DISTANCE_DIVISOR = 2;
  const values = compactRecords.distancesQ;
  const chunks = [];
  let totalBytes = 0;

  for (let start = 0; start < recordCount; start += DELTA_BLOCK_SIZE) {
    const count = Math.min(DELTA_BLOCK_SIZE, recordCount - start);
    let canUint8Encode = count > 0;
    for (let offset = 0; offset < count; offset += 1) {
      const current = values[start + offset];
      if (current === UINT32_NAN) {
        canUint8Encode = false;
        break;
      }
      if (offset > 0) {
        const previous = values[start + offset - 1];
        const delta = Math.round(current / DISTANCE_DIVISOR) - Math.round(previous / DISTANCE_DIVISOR);
        if (delta < 0 || delta > 255) {
          canUint8Encode = false;
          break;
        }
      }
    }

    if (canUint8Encode) {
      const firstScaled = Math.round(values[start] / DISTANCE_DIVISOR);
      const chunk = new Uint8Array(1 + 2 + 4 + Math.max(0, count - 1));
      chunk[0] = 2;
      new DataView(chunk.buffer).setUint16(1, count, true);
      new DataView(chunk.buffer).setUint32(3, firstScaled, true);
      let writeOffset = 7;
      for (let index = 1; index < count; index += 1) {
        const delta = Math.round(values[start + index] / DISTANCE_DIVISOR) - Math.round(values[start + index - 1] / DISTANCE_DIVISOR);
        chunk[writeOffset] = delta;
        writeOffset += 1;
      }
      chunks.push(chunk);
      totalBytes += chunk.byteLength;
      continue;
    }

    const chunk = new Uint8Array(1 + 2 + count * 4);
    chunk[0] = 0;
    new DataView(chunk.buffer).setUint16(1, count, true);
    let writeOffset = 3;
    for (let index = 0; index < count; index += 1) {
      new DataView(chunk.buffer).setUint32(writeOffset, values[start + index], true);
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

function buildWorkoutStreamBlockCompactDistanceUint8Q02(compactRecords) {
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
  const distancePayload = buildDistancePayloadCompactUint8Q02(compactRecords, recordCount);
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
  const baseTimestampMs = recordCount > 0 && Number.isFinite(Number(compactRecords.timestampsMs[0]))
    ? Math.round(Number(compactRecords.timestampsMs[0]))
    : 0;
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
    stats: {
      recordCount,
      usesSpeedFallback,
      speedFallbackRecordCount: usesSpeedFallback ? recordCount : 0,
      distanceEncoding: "uint8-q02"
    }
  };
}

function buildWorkoutStreamBlockCompactDelta16PowerDistanceUint8Q02(compactRecords) {
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
  const distancePayload = buildDistancePayloadCompactUint8Q02(compactRecords, recordCount);
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
  const baseTimestampMs = recordCount > 0 && Number.isFinite(Number(compactRecords.timestampsMs[0]))
    ? Math.round(Number(compactRecords.timestampsMs[0]))
    : 0;
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
    stats: {
      recordCount,
      usesSpeedFallback,
      speedFallbackRecordCount: usesSpeedFallback ? recordCount : 0,
      powerEncoding: powerPayload.stats.powerEncoding,
      powerEscapeCount: powerPayload.stats.powerEscapeCount,
      powerAbsoluteCount: powerPayload.stats.powerAbsoluteCount,
      distanceEncoding: "uint8-q02"
    }
  };
}

function buildGpsCoordinatePayload(points) {
  const quantized = points.map((point) => ({
    lat: Number.isFinite(Number(point.lat)) ? Math.round(Number(point.lat) * MICRO_DEGREES) : INT32_NAN,
    lng: Number.isFinite(Number(point.lng)) ? Math.round(Number(point.lng) * MICRO_DEGREES) : INT32_NAN
  }));

  const chunks = [];
  let totalBytes = 0;
  for (let start = 0; start < quantized.length; start += DELTA_BLOCK_SIZE) {
    const count = Math.min(DELTA_BLOCK_SIZE, quantized.length - start);
    let canDeltaEncode = count > 0;
    for (let offset = 0; offset < count; offset += 1) {
      const current = quantized[start + offset];
      if (current.lat === INT32_NAN || current.lng === INT32_NAN) {
        canDeltaEncode = false;
        break;
      }
      if (offset > 0) {
        const previous = quantized[start + offset - 1];
        const deltaLat = current.lat - previous.lat;
        const deltaLng = current.lng - previous.lng;
        if (deltaLat < -32767 || deltaLat > 32767 || deltaLng < -32767 || deltaLng > 32767) {
          canDeltaEncode = false;
          break;
        }
      }
    }

    if (canDeltaEncode) {
      const chunk = new Uint8Array(1 + 2 + 4 + Math.max(0, count - 1) * 2 + 4 + Math.max(0, count - 1) * 2);
      const view = new DataView(chunk.buffer);
      chunk[0] = 1;
      view.setUint16(1, count, true);
      view.setInt32(3, quantized[start].lat, true);
      let offset = 7;
      for (let index = 1; index < count; index += 1) {
        const current = quantized[start + index];
        const previous = quantized[start + index - 1];
        view.setInt16(offset, current.lat - previous.lat, true);
        offset += 2;
      }
      view.setInt32(offset, quantized[start].lng, true);
      offset += 4;
      for (let index = 1; index < count; index += 1) {
        const current = quantized[start + index];
        const previous = quantized[start + index - 1];
        view.setInt16(offset, current.lng - previous.lng, true);
        offset += 2;
      }
      chunks.push(chunk);
      totalBytes += chunk.byteLength;
      continue;
    }

    const chunk = new Uint8Array(1 + 2 + count * 8);
    const view = new DataView(chunk.buffer);
    chunk[0] = 0;
    view.setUint16(1, count, true);
    let offset = 3;
    for (let index = 0; index < count; index += 1) {
      view.setInt32(offset, quantized[start + index].lat, true);
      offset += 4;
    }
    for (let index = 0; index < count; index += 1) {
      view.setInt32(offset, quantized[start + index].lng, true);
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

function buildReducedGpsTrackCompact(compactRecords, sampleRateSeconds = 5) {
  const MAX_STEP_DISTANCE_METERS = 40;
  const MIN_RELOCK_SEQUENCE = 3;
  const MAX_INTERPOLATION_GAP = 8;
  const DEG_TO_RAD = Math.PI / 180;
  const EARTH_RADIUS_METERS = 6371000;
  const sampleRate = Math.max(1, Math.round(Number(sampleRateSeconds) || 1));
  const precision = 5;
  const recordCount = Number(compactRecords?.recordCount || 0);

  function haversine(latA, lngA, latB, lngB) {
    const dLat = (latB - latA) * DEG_TO_RAD;
    const dLng = (lngB - lngA) * DEG_TO_RAD;
    const lat1 = latA * DEG_TO_RAD;
    const lat2 = latB * DEG_TO_RAD;
    const aVal = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(aVal), Math.sqrt(1 - aVal));
  }

  const timestamps = new Array(recordCount);
  const rawLatitudes = new Array(recordCount);
  const rawLongitudes = new Array(recordCount);
  const latitudes = new Array(recordCount);
  const longitudes = new Array(recordCount);

  for (let index = 0; index < recordCount; index += 1) {
    const latRaw = Number(compactRecords.positionLatsE6[index]);
    const lngRaw = Number(compactRecords.positionLongsE6[index]);
    const lat = Number.isFinite(latRaw) && latRaw !== INT32_NAN ? latRaw / MICRO_DEGREES : null;
    const lng = Number.isFinite(lngRaw) && lngRaw !== INT32_NAN ? lngRaw / MICRO_DEGREES : null;
    const timestamp = Number(compactRecords.timestampsMs[index]);
    timestamps[index] = Number.isFinite(timestamp) ? timestamp : null;
    rawLatitudes[index] = lat;
    rawLongitudes[index] = lng;
    latitudes[index] = lat;
    longitudes[index] = lng;
  }

  let lastValidIndex = -1;
  const relockCandidateIndexes = [];
  for (let i = 0; i < recordCount; i += 1) {
    const lat = latitudes[i];
    const lng = longitudes[i];
    const invalid = !Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0);
    if (invalid) {
      latitudes[i] = null;
      longitudes[i] = null;
      continue;
    }
    if (lastValidIndex < 0) {
      lastValidIndex = i;
      continue;
    }
    const dist = haversine(latitudes[lastValidIndex], longitudes[lastValidIndex], lat, lng);
    if (dist <= MAX_STEP_DISTANCE_METERS) {
      lastValidIndex = i;
      relockCandidateIndexes.length = 0;
      continue;
    }
    latitudes[i] = null;
    longitudes[i] = null;
    const rawLat = rawLatitudes[i];
    const rawLng = rawLongitudes[i];
    if (rawLat == null || rawLng == null) {
      relockCandidateIndexes.length = 0;
      continue;
    }
    if (relockCandidateIndexes.length === 0) {
      relockCandidateIndexes.push(i);
      continue;
    }
    const previousCandidateIndex = relockCandidateIndexes[relockCandidateIndexes.length - 1];
    const candidateDist = haversine(rawLatitudes[previousCandidateIndex], rawLongitudes[previousCandidateIndex], rawLat, rawLng);
    if (candidateDist <= MAX_STEP_DISTANCE_METERS) {
      relockCandidateIndexes.push(i);
    } else {
      relockCandidateIndexes.length = 0;
      relockCandidateIndexes.push(i);
    }
    if (relockCandidateIndexes.length >= MIN_RELOCK_SEQUENCE) {
      for (const candidateIndex of relockCandidateIndexes) {
        latitudes[candidateIndex] = rawLatitudes[candidateIndex];
        longitudes[candidateIndex] = rawLongitudes[candidateIndex];
      }
      lastValidIndex = relockCandidateIndexes[relockCandidateIndexes.length - 1];
      relockCandidateIndexes.length = 0;
    }
  }

  const prevValidIndex = new Array(recordCount).fill(-1);
  const nextValidIndex = new Array(recordCount).fill(-1);
  let previousValidIndex = -1;
  for (let i = 0; i < recordCount; i += 1) {
    prevValidIndex[i] = previousValidIndex;
    if (Number.isFinite(latitudes[i]) && Number.isFinite(longitudes[i])) {
      previousValidIndex = i;
    }
  }
  let nextIndex = -1;
  for (let i = recordCount - 1; i >= 0; i -= 1) {
    nextValidIndex[i] = nextIndex;
    if (Number.isFinite(latitudes[i]) && Number.isFinite(longitudes[i])) {
      nextIndex = i;
    }
  }

  let currentGapLength = 0;
  for (let i = 0; i < recordCount; i += 1) {
    if (Number.isFinite(latitudes[i]) && Number.isFinite(longitudes[i])) {
      currentGapLength = 0;
      continue;
    }
    currentGapLength += 1;
    const prevIndex = prevValidIndex[i];
    const nextValid = nextValidIndex[i];
    const prevLat = prevIndex >= 0 ? latitudes[prevIndex] : null;
    const prevLng = prevIndex >= 0 ? longitudes[prevIndex] : null;
    const nextLat = nextValid >= 0 ? latitudes[nextValid] : null;
    const nextLng = nextValid >= 0 ? longitudes[nextValid] : null;
    if (!Number.isFinite(prevLat) || !Number.isFinite(prevLng) || !Number.isFinite(nextLat) || !Number.isFinite(nextLng) || currentGapLength > MAX_INTERPOLATION_GAP) {
      continue;
    }
    latitudes[i] = (prevLat + nextLat) / 2;
    longitudes[i] = (prevLng + nextLng) / 2;
  }

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  const points = [];

  for (let i = 0; i < recordCount; i += 1) {
    const latValue = latitudes[i];
    const lngValue = longitudes[i];
    if (!Number.isFinite(latValue) || !Number.isFinite(lngValue)) {
      continue;
    }
    const lat = Number(latValue.toFixed(precision));
    const lng = Number(lngValue.toFixed(precision));
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (i % sampleRate === 0) {
      points.push({
        lat,
        lng,
        timestampMs: Number.isFinite(Number(timestamps[i])) ? Number(timestamps[i]) : 0
      });
    }
  }

  if (!points.length) {
    return { sampleRateSeconds: sampleRate, pointCount: 0, bbox: null, startPoint: null, endPoint: null, points };
  }

  return {
    sampleRateSeconds: sampleRate,
    pointCount: points.length,
    bbox: points.length >= 2 ? { minLat, maxLat, minLng, maxLng } : null,
    startPoint: { lat: points[0].lat, lng: points[0].lng },
    endPoint: { lat: points[points.length - 1].lat, lng: points[points.length - 1].lng },
    points
  };
}

function buildGpsTrackBlock(gpsTrack) {
  const pointCount = Number(gpsTrack?.pointCount || 0);
  const firstTimestampMs = pointCount > 0 && Number.isFinite(Number(gpsTrack?.points?.[0]?.timestampMs))
    ? Math.round(Number(gpsTrack.points[0].timestampMs))
    : 0;
  const headerBytes = 4 + 2 + 2 + 4 + 8;
  const coordinatePayload = buildGpsCoordinatePayload(gpsTrack?.points || []);
  const payloadBytes = coordinatePayload.byteLength;
  const buffer = new ArrayBuffer(headerBytes + payloadBytes);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  bytes.set(textEncoder.encode("GPS2"), 0);
  view.setUint16(4, 2, true);
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
  const firstTimestamp = recordCount > 0 ? Number(compactRecords.timestampsMs[0]) : Number.NaN;
  const lastTimestamp = recordCount > 0 ? Number(compactRecords.timestampsMs[recordCount - 1]) : Number.NaN;
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
  sampleRateSeconds = 5,
  compressWorkoutStream = null,
  compressGpsTrack = null,
  powerEncoding = "delta16",
  distanceEncoding = "uint8-q02"
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
  const useDeltaPower = powerEncoding === "delta16";
  const useDistanceUint8Q02 = distanceEncoding === "uint8-q02";
  let workoutStreamBlock;
  if (useDeltaPower && useDistanceUint8Q02) {
    workoutStreamBlock = buildWorkoutStreamBlockCompactDelta16PowerDistanceUint8Q02(parsedCompact?.compactRecords || {});
  } else if (useDeltaPower) {
    workoutStreamBlock = buildWorkoutStreamBlockFromCompactDelta16Power(parsedCompact?.compactRecords || {});
  } else if (useDistanceUint8Q02) {
    workoutStreamBlock = buildWorkoutStreamBlockCompactDistanceUint8Q02(parsedCompact?.compactRecords || {});
  } else {
    workoutStreamBlock = buildWorkoutStreamBlockFromCompact(parsedCompact?.compactRecords || {});
  }
  const workoutStreamRawBytes = workoutStreamBlock.bytes;
  timings.buildWorkoutStreamBlockMs = nowMs() - stepStartedAt;

  stepStartedAt = nowMs();
  const gpsTrackRawBytes = buildGpsTrackBlock(gpsTrack);
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

  const usesCompressedBlocks = !!(compressWorkoutStream && compressGpsTrack);

  stepStartedAt = nowMs();
  const summary = deriveSummaryFromCompact(parsedCompact, gpsTrack, sourceName);
  timings.deriveSummaryMs = nowMs() - stepStartedAt;
  if (summary?.persistedRow) {
    summary.persistedRow.stream_codec = usesCompressedBlocks ? DEFAULT_STREAM_CODEC : "identity";
    summary.persistedRow.gps_track_blob_codec = usesCompressedBlocks ? DEFAULT_GPS_TRACK_CODEC : "identity";
  }
  summary.blockCodecs = {
    workout_stream: usesCompressedBlocks ? DEFAULT_STREAM_CODEC : "identity",
    gps_track: usesCompressedBlocks ? DEFAULT_GPS_TRACK_CODEC : "identity"
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
    workoutStreamBytes,
    gpsTrackBytes,
    timings,
    stats: {
      workoutStream: workoutStreamBlock.stats
    }
  };
}
