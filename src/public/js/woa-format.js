const textEncoder = new TextEncoder();
const UINT8_NAN = 0xFF;
const UINT16_NAN = 0xFFFF;
const UINT32_NAN = 0xFFFFFFFF;
const INT16_NAN = -0x8000;
const INT32_NAN = -0x80000000;
const MICRO_DEGREES = 1e7;
const DELTA_BLOCK_SIZE = 128;

function encodeJson(value) {
  return textEncoder.encode(JSON.stringify(value));
}

function buildDistancePayload(recordsTyped, recordCount) {
  const values = new Uint32Array(recordCount);
  for (let index = 0; index < recordCount; index += 1) {
    const value = Number(recordsTyped.distancesM[index]);
    values[index] = Number.isFinite(value)
      ? Math.max(0, Math.min(UINT32_NAN - 1, Math.round(value * 10)))
      : UINT32_NAN;
  }

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
        const delta = values[start + index] - values[start + index - 1];
        view.setInt16(offset, delta, true);
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
      const chunk = new Uint8Array(1 + 2 + 4 + 4 + Math.max(0, count - 1) * 4);
      const view = new DataView(chunk.buffer);
      chunk[0] = 1;
      view.setUint16(1, count, true);
      view.setInt32(3, quantized[start].lat, true);
      view.setInt32(7, quantized[start].lng, true);
      let offset = 11;
      for (let index = 1; index < count; index += 1) {
        const current = quantized[start + index];
        const previous = quantized[start + index - 1];
        view.setInt16(offset, current.lat - previous.lat, true);
        offset += 2;
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

function buildWorkoutStreamBlock(recordsTyped) {
  const recordCount = Number(recordsTyped.recordCount || 0);
  let hasCompleteDistanceSeries = recordCount > 0;
  for (let index = 0; index < recordCount; index += 1) {
    if (!Number.isFinite(Number(recordsTyped.distancesM[index]))) {
      hasCompleteDistanceSeries = false;
      break;
    }
  }

  const headerBytes = 4 + 4 + 8 + 4 + 8 * 4;
  const distancePayload = buildDistancePayload(recordsTyped, recordCount);
  const distancesBytes = distancePayload.byteLength;
  const powersBytes = recordCount * 2;
  const heartRatesBytes = recordCount;
  const cadencesBytes = recordCount;
  const speedsBytes = hasCompleteDistanceSeries ? 0 : (recordCount * 2);
  const altitudesBytes = recordCount * 2;
  const positionLatsBytes = recordCount * 4;
  const positionLongsBytes = recordCount * 4;
  const payloadBytes = distancesBytes
    + powersBytes
    + heartRatesBytes
    + cadencesBytes
    + speedsBytes
    + altitudesBytes
    + positionLatsBytes
    + positionLongsBytes;
  const buffer = new ArrayBuffer(headerBytes + payloadBytes);
  const view = new DataView(buffer);
  const lengths = [
    distancesBytes,
    powersBytes,
    heartRatesBytes,
    cadencesBytes,
    speedsBytes,
    altitudesBytes,
    positionLatsBytes,
    positionLongsBytes
  ];
  const baseTimestampMs = recordCount > 0 && Number.isFinite(Number(recordsTyped.timestampsMs[0]))
    ? Math.round(Number(recordsTyped.timestampsMs[0]))
    : 0;
  const sampleIntervalMs = 1000;

  new Uint8Array(buffer, 0, 4).set(textEncoder.encode("WST2"));
  view.setUint32(4, recordCount, true);
  view.setFloat64(8, baseTimestampMs, true);
  view.setUint32(16, sampleIntervalMs, true);

  let headerOffset = 20;
  for (const length of lengths) {
    view.setUint32(headerOffset, length, true);
    headerOffset += 4;
  }

  let payloadOffset = headerBytes;

  new Uint8Array(buffer, payloadOffset, distancesBytes).set(distancePayload);
  payloadOffset += distancesBytes;

  for (let index = 0; index < recordCount; index += 1) {
    const value = Number(recordsTyped.powersW[index]);
    const encoded = Number.isFinite(value)
      ? Math.max(0, Math.min(UINT16_NAN - 1, Math.round(value)))
      : UINT16_NAN;
    view.setUint16(payloadOffset + (index * 2), encoded, true);
  }
  payloadOffset += powersBytes;

  for (let index = 0; index < recordCount; index += 1) {
    const value = Number(recordsTyped.heartRatesBpm[index]);
    view.setUint8(payloadOffset + index, Number.isFinite(value) ? Math.max(0, Math.min(UINT8_NAN - 1, Math.round(value))) : UINT8_NAN);
  }
  payloadOffset += heartRatesBytes;

  for (let index = 0; index < recordCount; index += 1) {
    const value = Number(recordsTyped.cadencesRpm[index]);
    view.setUint8(payloadOffset + index, Number.isFinite(value) ? Math.max(0, Math.min(UINT8_NAN - 1, Math.round(value))) : UINT8_NAN);
  }
  payloadOffset += cadencesBytes;

  for (let index = 0; index < recordCount && speedsBytes > 0; index += 1) {
    const value = Number(recordsTyped.speedsMps[index]);
    const encoded = Number.isFinite(value)
      ? Math.max(0, Math.min(UINT16_NAN - 1, Math.round(value * 100)))
      : UINT16_NAN;
    view.setUint16(payloadOffset + (index * 2), encoded, true);
  }
  payloadOffset += speedsBytes;

  for (let index = 0; index < recordCount; index += 1) {
    const value = Number(recordsTyped.altitudesM[index]);
    const encoded = Number.isFinite(value)
      ? Math.max(INT16_NAN + 1, Math.min(0x7FFF, Math.round(value * 10)))
      : INT16_NAN;
    view.setInt16(payloadOffset + (index * 2), encoded, true);
  }
  payloadOffset += altitudesBytes;

  for (let index = 0; index < recordCount; index += 1) {
    const value = Number(recordsTyped.positionLatsDeg[index]);
    const encoded = Number.isFinite(value)
      ? Math.max(INT32_NAN + 1, Math.min(0x7FFFFFFF, Math.round(value * MICRO_DEGREES)))
      : INT32_NAN;
    view.setInt32(payloadOffset + (index * 4), encoded, true);
  }
  payloadOffset += positionLatsBytes;

  for (let index = 0; index < recordCount; index += 1) {
    const value = Number(recordsTyped.positionLongsDeg[index]);
    const encoded = Number.isFinite(value)
      ? Math.max(INT32_NAN + 1, Math.min(0x7FFFFFFF, Math.round(value * MICRO_DEGREES)))
      : INT32_NAN;
    view.setInt32(payloadOffset + (index * 4), encoded, true);
  }

  return new Uint8Array(buffer);
}

function buildReducedGpsTrack(recordsTyped, sampleRateSeconds = 5) {
  const points = [];
  const bbox = {
    minLat: Number.POSITIVE_INFINITY,
    maxLat: Number.NEGATIVE_INFINITY,
    minLng: Number.POSITIVE_INFINITY,
    maxLng: Number.NEGATIVE_INFINITY
  };

  let lastAcceptedTimestampMs = Number.NEGATIVE_INFINITY;

  for (let index = 0; index < recordsTyped.recordCount; index += 1) {
    const lat = Number(recordsTyped.positionLatsDeg[index]);
    const lng = Number(recordsTyped.positionLongsDeg[index]);
    const timestampMs = Number(recordsTyped.timestampsMs[index]);

    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(timestampMs)) {
      continue;
    }

    if ((timestampMs - lastAcceptedTimestampMs) < (sampleRateSeconds * 1000) && points.length > 0) {
      continue;
    }

    points.push({ lat, lng, timestampMs });
    lastAcceptedTimestampMs = timestampMs;

    if (lat < bbox.minLat) bbox.minLat = lat;
    if (lat > bbox.maxLat) bbox.maxLat = lat;
    if (lng < bbox.minLng) bbox.minLng = lng;
    if (lng > bbox.maxLng) bbox.maxLng = lng;
  }

  if (!points.length) {
    return {
      sampleRateSeconds,
      pointCount: 0,
      bbox: null,
      startPoint: null,
      endPoint: null,
      points
    };
  }

  return {
    sampleRateSeconds,
    pointCount: points.length,
    bbox,
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

  new Uint8Array(buffer, 0, 4).set(textEncoder.encode("GPS2"));
  view.setUint16(4, 1, true);
  view.setUint16(6, Number(gpsTrack?.sampleRateSeconds || 0), true);
  view.setUint32(8, pointCount, true);
  view.setFloat64(12, firstTimestampMs, true);
  new Uint8Array(buffer, headerBytes, payloadBytes).set(coordinatePayload);

  return new Uint8Array(buffer);
}

function deriveSummary(parsed, gpsTrack, sourceName = "") {
  const sessions = Array.isArray(parsed?.sessions) ? parsed.sessions : [];
  const firstSession = sessions[0] || {};
  const recordsTyped = parsed?.recordsTyped || {};
  const recordCount = Number(recordsTyped.recordCount || 0);
  const firstTimestamp = recordCount > 0 ? Number(recordsTyped.timestampsMs[0]) : Number.NaN;
  const lastTimestamp = recordCount > 0 ? Number(recordsTyped.timestampsMs[recordCount - 1]) : Number.NaN;

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
    endPoint: gpsTrack?.endPoint || null
  };
}

export function createWoa1File(parsed, { sourceName = "", sampleRateSeconds = 5 } = {}) {
  const gpsTrack = buildReducedGpsTrack(parsed.recordsTyped, sampleRateSeconds);
  const metaBytes = encodeJson(deriveSummary(parsed, gpsTrack, sourceName));
  const sessionBytes = encodeJson(Array.isArray(parsed?.sessions) ? parsed.sessions : []);
  const workoutStreamBytes = buildWorkoutStreamBlock(parsed.recordsTyped);
  const gpsTrackBytes = buildGpsTrackBlock(gpsTrack);

  const headerLength = 4 + 1 + 1 + 2 + 4 + 4 + 4 + 4;
  const totalLength = headerLength
    + metaBytes.length
    + sessionBytes.length
    + workoutStreamBytes.length
    + gpsTrackBytes.length;

  const buffer = new ArrayBuffer(totalLength);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  bytes.set(textEncoder.encode("WOA1"), 0);
  view.setUint8(4, 1);
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

  return {
    bytes,
    meta: JSON.parse(new TextDecoder().decode(metaBytes)),
    gpsTrack
  };
}
