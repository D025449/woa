const textEncoder = new TextEncoder();
const UINT8_NAN = 0xFF;
const UINT16_NAN = 0xFFFF;
const UINT32_NAN = 0xFFFFFFFF;
const INT16_NAN = -0x8000;
const INT32_NAN = -0x80000000;
const MICRO_DEGREES = 1e7;
const DELTA_BLOCK_SIZE = 128;
const DEFAULT_STREAM_CODEC = "gzip";
const DEFAULT_GPS_TRACK_CODEC = "gzip";
const DEFAULT_STREAM_GZIP_LEVEL = 4;
const DEFAULT_GPS_GZIP_LEVEL = 4;

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

  const headerBytes = 4 + 4 + 8 + 4 + 6 * 4;
  const distancePayload = buildDistancePayload(recordsTyped, recordCount);
  const distancesBytes = distancePayload.byteLength;
  const powersBytes = recordCount * 2;
  const heartRatesBytes = recordCount;
  const cadencesBytes = recordCount;
  const speedsBytes = hasCompleteDistanceSeries ? 0 : (recordCount * 2);
  const altitudesBytes = recordCount * 2;
  const payloadBytes = distancesBytes
    + powersBytes
    + heartRatesBytes
    + cadencesBytes
    + speedsBytes
    + altitudesBytes;
  const buffer = new ArrayBuffer(headerBytes + payloadBytes);
  const view = new DataView(buffer);
  const lengths = [
    distancesBytes,
    powersBytes,
    heartRatesBytes,
    cadencesBytes,
    speedsBytes,
    altitudesBytes
  ];
  const baseTimestampMs = recordCount > 0 && Number.isFinite(Number(recordsTyped.timestampsMs[0]))
    ? Math.round(Number(recordsTyped.timestampsMs[0]))
    : 0;
  const sampleIntervalMs = 1000;

  new Uint8Array(buffer, 0, 4).set(textEncoder.encode("WST3"));
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

  return new Uint8Array(buffer);
}

function buildReducedGpsTrack(recordsTyped, sampleRateSeconds = 5) {
  const MAX_STEP_DISTANCE_METERS = 40;
  const MIN_RELOCK_SEQUENCE = 3;
  const MAX_INTERPOLATION_GAP = 8;
  const DEG_TO_RAD = Math.PI / 180;
  const EARTH_RADIUS_METERS = 6371000;
  const sampleRate = Math.max(1, Math.round(Number(sampleRateSeconds) || 1));
  const precision = 5;

  function haversine(a, b) {
    const dLat = (b.position_lat - a.position_lat) * DEG_TO_RAD;
    const dLng = (b.position_long - a.position_long) * DEG_TO_RAD;
    const lat1 = a.position_lat * DEG_TO_RAD;
    const lat2 = b.position_lat * DEG_TO_RAD;
    const aVal = Math.sin(dLat / 2) ** 2
      + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(aVal), Math.sqrt(1 - aVal));
  }

  const records = [];
  for (let index = 0; index < Number(recordsTyped?.recordCount || 0); index += 1) {
    const lat = Number(recordsTyped?.positionLatsDeg?.[index]);
    const lng = Number(recordsTyped?.positionLongsDeg?.[index]);
    const timestamp = Number(recordsTyped?.timestampsMs?.[index]);
    records.push({
      timestamp: Number.isFinite(timestamp) ? timestamp : null,
      position_lat: Number.isFinite(lat) ? lat : null,
      position_long: Number.isFinite(lng) ? lng : null
    });
  }

  const rawPositions = new Array(records.length);
  for (let i = 0; i < records.length; i += 1) {
    rawPositions[i] = {
      position_lat: records[i].position_lat,
      position_long: records[i].position_long
    };
  }

  let lastValid = null;
  let relockCandidate = [];

  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    const invalid = !Number.isFinite(record.position_lat)
      || !Number.isFinite(record.position_long)
      || (record.position_lat === 0 && record.position_long === 0);

    if (invalid) {
      record.position_lat = null;
      record.position_long = null;
      continue;
    }

    if (!lastValid) {
      lastValid = record;
      continue;
    }

    const dist = haversine(lastValid, record);
    if (dist <= MAX_STEP_DISTANCE_METERS) {
      lastValid = record;
      relockCandidate = [];
      continue;
    }

    const rawCandidate = {
      index: i,
      timestamp: record.timestamp ?? null,
      position_lat: Number(rawPositions[i].position_lat),
      position_long: Number(rawPositions[i].position_long)
    };
    rawCandidate.position_lat = Number.isFinite(rawCandidate.position_lat) ? rawCandidate.position_lat : null;
    rawCandidate.position_long = Number.isFinite(rawCandidate.position_long) ? rawCandidate.position_long : null;

    record.position_lat = null;
    record.position_long = null;

    if (rawCandidate.position_lat == null || rawCandidate.position_long == null) {
      relockCandidate = [];
      continue;
    }

    if (relockCandidate.length === 0) {
      relockCandidate.push(rawCandidate);
      continue;
    }

    const prevCandidate = relockCandidate[relockCandidate.length - 1];
    const candidateDist = haversine(prevCandidate, rawCandidate);

    if (candidateDist <= MAX_STEP_DISTANCE_METERS) {
      relockCandidate.push(rawCandidate);
    } else {
      relockCandidate = [rawCandidate];
    }

    if (relockCandidate.length >= MIN_RELOCK_SEQUENCE) {
      for (const candidate of relockCandidate) {
        const target = records[candidate.index];
        target.position_lat = candidate.position_lat;
        target.position_long = candidate.position_long;
      }
      lastValid = records[relockCandidate[relockCandidate.length - 1].index];
      relockCandidate = [];
    }
  }

  const prevValidIndex = new Array(records.length).fill(-1);
  const nextValidIndex = new Array(records.length).fill(-1);
  let lastValidIndex = -1;

  for (let i = 0; i < records.length; i += 1) {
    prevValidIndex[i] = lastValidIndex;
    if (Number.isFinite(records[i].position_lat) && Number.isFinite(records[i].position_long)) {
      lastValidIndex = i;
    }
  }

  let nextIndex = -1;
  for (let i = records.length - 1; i >= 0; i -= 1) {
    nextValidIndex[i] = nextIndex;
    if (Number.isFinite(records[i].position_lat) && Number.isFinite(records[i].position_long)) {
      nextIndex = i;
    }
  }

  let currentGapLength = 0;
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (Number.isFinite(record.position_lat) && Number.isFinite(record.position_long)) {
      currentGapLength = 0;
      continue;
    }

    currentGapLength += 1;
    const prevIndex = prevValidIndex[i];
    const nextValid = nextValidIndex[i];
    const prev = prevIndex >= 0 ? records[prevIndex] : null;
    const next = nextValid >= 0 ? records[nextValid] : null;

    if (
      !prev
      || !next
      || !Number.isFinite(prev.position_lat)
      || !Number.isFinite(prev.position_long)
      || !Number.isFinite(next.position_lat)
      || !Number.isFinite(next.position_long)
      || currentGapLength > MAX_INTERPOLATION_GAP
    ) {
      continue;
    }

    record.position_lat = (prev.position_lat + next.position_lat) / 2;
    record.position_long = (prev.position_long + next.position_long) / 2;
  }

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  const points = [];

  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (!Number.isFinite(record.position_lat) || !Number.isFinite(record.position_long)) {
      continue;
    }

    const lat = Number(record.position_lat.toFixed(precision));
    const lng = Number(record.position_long.toFixed(precision));
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;

    if (i % sampleRate === 0) {
      points.push({
        lat,
        lng,
        timestampMs: Number.isFinite(Number(record.timestamp)) ? Number(record.timestamp) : 0
      });
    }
  }

  if (!points.length) {
    return {
      sampleRateSeconds: sampleRate,
      pointCount: 0,
      bbox: null,
      startPoint: null,
      endPoint: null,
      points
    };
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

  new Uint8Array(buffer, 0, 4).set(textEncoder.encode("GPS2"));
  view.setUint16(4, 1, true);
  view.setUint16(6, Number(gpsTrack?.sampleRateSeconds || 0), true);
  view.setUint32(8, pointCount, true);
  view.setFloat64(12, firstTimestampMs, true);
  new Uint8Array(buffer, headerBytes, payloadBytes).set(coordinatePayload);

  return new Uint8Array(buffer);
}

function getISOWeekUTC(dateLike) {
  const date = new Date(dateLike);
  const utcDate = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate()
  ));
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
    if (!totalTime) {
      return 0;
    }
    return sessions.reduce((acc, session) => (
      acc + ((Number(session?.[key]) || 0) * (Number(session?.total_timer_time) || 0))
    ), 0) / totalTime;
  };
  const max = (key) => Math.max(...sessions.map((session) => Number(session?.[key]) || 0));
  const minDate = (key) => new Date(
    Math.min(...sessions.map((session) => new Date(session?.[key]).getTime()))
  ).toISOString();
  const maxDate = (key) => new Date(
    Math.max(...sessions.map((session) => new Date(session?.[key]).getTime()))
  ).toISOString();
  const validValues = (key) => sessions
    .map((session) => session?.[key])
    .filter((value) => value != null && Number.isFinite(Number(value)));

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
  if (!Number.isFinite(Number(value))) {
    return 0;
  }
  return Number(value) * 3.6;
}

function derivePersistedRow(parsed, gpsTrack, sourceName = "") {
  const sessions = Array.isArray(parsed?.sessions) ? parsed.sessions : [];
  const aggregated = aggregateSessions(sessions);
  if (!aggregated) {
    return null;
  }

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
    bounds: bbox ? {
      minLat: bbox.minLat,
      maxLat: bbox.maxLat,
      minLng: bbox.minLng,
      maxLng: bbox.maxLng
    } : null,
    track_start: trackStart ? { lat: trackStart.lat, lng: trackStart.lng } : null,
    track_end: trackEnd ? { lat: trackEnd.lat, lng: trackEnd.lng } : null,
    stream_codec: DEFAULT_STREAM_CODEC,
    gps_track_blob_codec: DEFAULT_GPS_TRACK_CODEC
  };
}

function deriveSummary(parsed, gpsTrack, sourceName = "") {
  const sessions = Array.isArray(parsed?.sessions) ? parsed.sessions : [];
  const firstSession = sessions[0] || {};
  const recordsTyped = parsed?.recordsTyped || {};
  const recordCount = Number(recordsTyped.recordCount || 0);
  const firstTimestamp = recordCount > 0 ? Number(recordsTyped.timestampsMs[0]) : Number.NaN;
  const lastTimestamp = recordCount > 0 ? Number(recordsTyped.timestampsMs[recordCount - 1]) : Number.NaN;
  const persistedRow = derivePersistedRow(parsed, gpsTrack, sourceName);

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

export function createWoa1File(parsed, {
  sourceName = "",
  sampleRateSeconds = 5,
  compressWorkoutStream = null,
  compressGpsTrack = null
} = {}) {
  const gpsTrack = buildReducedGpsTrack(parsed.recordsTyped, sampleRateSeconds);
  const workoutStreamRawBytes = buildWorkoutStreamBlock(parsed.recordsTyped);
  const gpsTrackRawBytes = buildGpsTrackBlock(gpsTrack);
  const workoutStreamBytes = compressWorkoutStream
    ? compressWorkoutStream(workoutStreamRawBytes, { level: DEFAULT_STREAM_GZIP_LEVEL })
    : workoutStreamRawBytes;
  const gpsTrackBytes = compressGpsTrack
    ? compressGpsTrack(gpsTrackRawBytes, { level: DEFAULT_GPS_GZIP_LEVEL })
    : gpsTrackRawBytes;
  const usesCompressedBlocks = !!(compressWorkoutStream && compressGpsTrack);
  const summary = deriveSummary(parsed, gpsTrack, sourceName);
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
  const metaBytes = encodeJson(summary);
  const sessionBytes = encodeJson(Array.isArray(parsed?.sessions) ? parsed.sessions : []);

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

  return {
    bytes,
    meta: JSON.parse(new TextDecoder().decode(metaBytes)),
    gpsTrack,
    workoutStreamBytes,
    gpsTrackBytes
  };
}
