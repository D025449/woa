import Workout from "../shared/Workout.js";

const GPS_TRACK_BLOB_VERSION = 1;
const GPS_TRACK_BLOB_SCALE = 100000;
const GPS2_COORDINATE_SCALE = 1000000;
const GPS2_E5_COORDINATE_SCALE = 100000;
const GPS2_DELTA_ESCAPE = -0x8000;
const GPS2_TIERED_INT16_MARKER = 126;
const GPS2_TIERED_EXTENDED_MARKER = 127;
const GPS_TRACK_BLOB_HEADER_BYTES = 32;
const GPS2_HEADER_BYTES = 20;
const DELTA_BLOCK_SIZE = 128;
const INT32_NAN = -0x80000000;
const TEXT_DECODER = new TextDecoder();
const TEXT_ENCODER = new TextEncoder();
const DEFAULT_GPS_TRACK_BLOB_CODEC = "brotli";

function isFiniteCoordinate(value) {
  return Number.isFinite(Number(value));
}

function isValidGpsSlotPoint(point) {
  return !!point && isFiniteCoordinate(point.lat) && isFiniteCoordinate(point.lng);
}

function buildGpsSlotsAndSegments(latitudes, longitudes, sampleRateGps, firstTimestampMs = 0) {
  const slotCount = Math.min(latitudes.length, longitudes.length);
  const slots = new Array(slotCount);
  const points = [];
  const segments = [];
  let currentSegment = null;

  for (let index = 0; index < slotCount; index += 1) {
    const lat = Number(latitudes[index]);
    const lng = Number(longitudes[index]);
    const valid = isFiniteCoordinate(lat) && isFiniteCoordinate(lng);
    const slot = {
      lat: valid ? lat : Number.NaN,
      lng: valid ? lng : Number.NaN,
      valid,
      slotIndex: index,
      timestampMs: Number.isFinite(firstTimestampMs)
        ? firstTimestampMs + (index * Math.max(1, Number(sampleRateGps) || 1) * 1000)
        : Number.NaN
    };
    slots[index] = slot;

    if (!valid) {
      if (currentSegment?.length) {
        segments.push(currentSegment);
      }
      currentSegment = null;
      continue;
    }

    const point = {
      lat,
      lng,
      slotIndex: index,
      timestampMs: slot.timestampMs
    };
    points.push(point);
    if (!currentSegment) {
      currentSegment = [];
    }
    currentSegment.push(point);
  }

  if (currentSegment?.length) {
    segments.push(currentSegment);
  }

  return {
    slots,
    slotCount,
    points,
    pointCount: points.length,
    segments
  };
}

function toSegmentGeoJson(segments = []) {
  const coordinates = (Array.isArray(segments) ? segments : [])
    .map((segment) => segment
      .filter(isValidGpsSlotPoint)
      .map((point) => [point.lng, point.lat]))
    .filter((segment) => segment.length >= 2);

  if (coordinates.length === 0) {
    return null;
  }

  if (coordinates.length === 1) {
    return {
      type: "LineString",
      coordinates: coordinates[0]
    };
  }

  return {
    type: "MultiLineString",
    coordinates
  };
}

function inferCompressedCodec(bufferLike, fallback = DEFAULT_GPS_TRACK_BLOB_CODEC) {
  if (!bufferLike) {
    return fallback;
  }

  const bytes = Buffer.isBuffer(bufferLike)
    ? bufferLike
    : Buffer.from(bufferLike);

  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return "gzip";
  }

  return fallback;
}

function decodeGpsBitmapColumnarPayload(source, pointCount) {
  const headerBytes = 24;
  const bitmapBytes = Math.ceil(pointCount / 8);
  if (source.byteLength < headerBytes + bitmapBytes) {
    throw new Error("GPS2 layout v5 header or bitmap is truncated");
  }
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  const latitudeBytes = view.getUint32(20, true);
  const latitudeStart = headerBytes + bitmapBytes;
  const longitudeStart = latitudeStart + latitudeBytes;
  if (longitudeStart > source.byteLength) {
    throw new Error("GPS2 layout v5 latitude payload is truncated");
  }

  const decodeColumn = (start, end) => {
    const values = new Float64Array(pointCount);
    values.fill(Number.NaN);
    let offset = start;
    let previous = 0;
    let previousValid = false;
    const requireBytes = (count) => {
      if (offset + count > end) throw new Error("GPS2 layout v5 coordinate payload is truncated");
    };
    for (let index = 0; index < pointCount; index += 1) {
      const valid = (source[headerBytes + (index >> 3)] & (1 << (index & 7))) !== 0;
      if (!valid) {
        previousValid = false;
        continue;
      }
      if (!previousValid) {
        requireBytes(4);
        previous = view.getInt32(offset, true);
        offset += 4;
      } else {
        requireBytes(1);
        const marker = view.getUint8(offset);
        if (marker === GPS2_TIERED_INT16_MARKER) {
          requireBytes(3);
          previous += view.getInt16(offset + 1, true);
          offset += 3;
        } else if (marker === GPS2_TIERED_EXTENDED_MARKER) {
          requireBytes(5);
          previous = view.getInt32(offset + 1, true);
          offset += 5;
        } else {
          previous += view.getInt8(offset);
          offset += 1;
        }
      }
      values[index] = previous / GPS2_E5_COORDINATE_SCALE;
      previousValid = true;
    }
    if (offset !== end) throw new Error("GPS2 layout v5 coordinate payload has trailing bytes");
    return values;
  };

  return {
    latitudes: decodeColumn(latitudeStart, longitudeStart),
    longitudes: decodeColumn(longitudeStart, source.byteLength)
  };
}

function decodeGpsBitmapColumnarCompactPayload(source, pointCount, options = {}) {
  const headerBytes = 24;
  const bitmapBytes = Math.ceil(pointCount / 8);
  if (source.byteLength < headerBytes + bitmapBytes) {
    throw new Error("GPS2 layout v5 header or bitmap is truncated");
  }

  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  const latitudeBytes = view.getUint32(20, true);
  const latitudeStart = headerBytes + bitmapBytes;
  const longitudeStart = latitudeStart + latitudeBytes;
  if (longitudeStart > source.byteLength) {
    throw new Error("GPS2 layout v5 latitude payload is truncated");
  }

  let validPointCount = 0;
  for (let index = 0; index < pointCount; index += 1) {
    if ((source[headerBytes + (index >> 3)] & (1 << (index & 7))) !== 0) {
      validPointCount += 1;
    }
  }

  const slotIndices = options?.includeSlotIndices === true
    ? new Uint32Array(validPointCount)
    : null;
  if (slotIndices) {
    let slotWriteIndex = 0;
    for (let index = 0; index < pointCount; index += 1) {
      if ((source[headerBytes + (index >> 3)] & (1 << (index & 7))) !== 0) {
        slotIndices[slotWriteIndex] = index;
        slotWriteIndex += 1;
      }
    }
  }

  const decodeColumn = (start, end) => {
    const values = new Int32Array(validPointCount);
    let offset = start;
    let writeIndex = 0;
    let previous = 0;
    let previousValid = false;
    const requireBytes = (count) => {
      if (offset + count > end) throw new Error("GPS2 layout v5 coordinate payload is truncated");
    };

    for (let index = 0; index < pointCount; index += 1) {
      const valid = (source[headerBytes + (index >> 3)] & (1 << (index & 7))) !== 0;
      if (!valid) {
        previousValid = false;
        continue;
      }

      if (!previousValid) {
        requireBytes(4);
        previous = view.getInt32(offset, true);
        offset += 4;
      } else {
        requireBytes(1);
        const marker = view.getUint8(offset);
        if (marker === GPS2_TIERED_INT16_MARKER) {
          requireBytes(3);
          previous += view.getInt16(offset + 1, true);
          offset += 3;
        } else if (marker === GPS2_TIERED_EXTENDED_MARKER) {
          requireBytes(5);
          previous = view.getInt32(offset + 1, true);
          offset += 5;
        } else {
          previous += view.getInt8(offset);
          offset += 1;
        }
      }
      values[writeIndex] = previous;
      writeIndex += 1;
      previousValid = true;
    }

    if (offset !== end) throw new Error("GPS2 layout v5 coordinate payload has trailing bytes");
    return values;
  };

  return {
    latitudesE5: decodeColumn(latitudeStart, longitudeStart),
    longitudesE5: decodeColumn(longitudeStart, source.byteLength),
    slotIndices,
    validPointCount
  };
}

function normalizeTrackPoints(track = []) {
  if (!Array.isArray(track)) {
    return [];
  }

  return track
    .map((point) => {
      if (Array.isArray(point)) {
        const lat = Number(point[0]);
        const lng = Number(point[1]);
        return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
      }

      const lat = Number(point?.lat);
      const lng = Number(point?.lng);
      return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
    })
    .filter(Boolean);
}

function toGeoJson(points = []) {
  return {
    type: "LineString",
    coordinates: points.map((point) => [point.lng, point.lat])
  };
}

function buildGpsCoordinatePayload(points) {
  const quantized = points.map((point) => ({
    lat: Number.isFinite(Number(point.lat)) ? Math.round(Number(point.lat) * GPS_TRACK_BLOB_SCALE) : INT32_NAN,
    lng: Number.isFinite(Number(point.lng)) ? Math.round(Number(point.lng) * GPS_TRACK_BLOB_SCALE) : INT32_NAN
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

    if (layoutVersion >= 4 && mode === 3) {
      let currentLat = view.getInt32(offset, true);
      let currentLng = view.getInt32(offset + 4, true);
      offset += 8;
      latitudes[writeIndex] = currentLat === INT32_NAN ? Number.NaN : currentLat / GPS2_E5_COORDINATE_SCALE;
      longitudes[writeIndex] = currentLng === INT32_NAN ? Number.NaN : currentLng / GPS2_E5_COORDINATE_SCALE;

      for (let i = 1; i < count && (writeIndex + i) < pointCount; i += 1) {
        const marker = view.getInt8(offset);
        if (marker === GPS2_TIERED_INT16_MARKER) {
          currentLat += view.getInt16(offset + 1, true);
          currentLng += view.getInt16(offset + 3, true);
          offset += 5;
        } else if (marker === GPS2_TIERED_EXTENDED_MARKER) {
          const subtype = view.getUint8(offset + 1);
          if (subtype === 0) {
            currentLat = INT32_NAN;
            currentLng = INT32_NAN;
            offset += 2;
          } else if (subtype === 1) {
            currentLat = view.getInt32(offset + 2, true);
            currentLng = view.getInt32(offset + 6, true);
            offset += 10;
          } else {
            throw new Error(`Corrupt GPS2 layout v4 subtype: ${subtype}`);
          }
        } else {
          currentLat += marker;
          currentLng += view.getInt8(offset + 1);
          offset += 2;
        }
        latitudes[writeIndex + i] = currentLat === INT32_NAN ? Number.NaN : currentLat / GPS2_E5_COORDINATE_SCALE;
        longitudes[writeIndex + i] = currentLng === INT32_NAN ? Number.NaN : currentLng / GPS2_E5_COORDINATE_SCALE;
      }

      writeIndex += count;
      continue;
    }

    if (layoutVersion >= 3 && mode === 2) {
      let currentLat = view.getInt32(offset, true);
      let currentLng = view.getInt32(offset + 4, true);
      const tokenCount = Math.max(0, count - 1);
      let tokenOffset = offset + 8;
      let absoluteOffset = tokenOffset + (tokenCount * 4);
      latitudes[writeIndex] = currentLat === INT32_NAN ? Number.NaN : currentLat / GPS2_E5_COORDINATE_SCALE;
      longitudes[writeIndex] = currentLng === INT32_NAN ? Number.NaN : currentLng / GPS2_E5_COORDINATE_SCALE;

      for (let i = 1; i < count && (writeIndex + i) < pointCount; i += 1) {
        const deltaLat = view.getInt16(tokenOffset, true);
        const deltaLng = view.getInt16(tokenOffset + 2, true);
        tokenOffset += 4;
        if (deltaLat === GPS2_DELTA_ESCAPE && deltaLng === GPS2_DELTA_ESCAPE) {
          currentLat = INT32_NAN;
          currentLng = INT32_NAN;
        } else if (deltaLat === GPS2_DELTA_ESCAPE && deltaLng === 0) {
          currentLat = view.getInt32(absoluteOffset, true);
          currentLng = view.getInt32(absoluteOffset + 4, true);
          absoluteOffset += 8;
        } else if (deltaLat === GPS2_DELTA_ESCAPE || deltaLng === GPS2_DELTA_ESCAPE) {
          throw new Error("Corrupt GPS2 layout v3 escape token");
        } else {
          currentLat += deltaLat;
          currentLng += deltaLng;
        }
        latitudes[writeIndex + i] = currentLat === INT32_NAN ? Number.NaN : currentLat / GPS2_E5_COORDINATE_SCALE;
        longitudes[writeIndex + i] = currentLng === INT32_NAN ? Number.NaN : currentLng / GPS2_E5_COORDINATE_SCALE;
      }

      offset = absoluteOffset;
      writeIndex += count;
      continue;
    }

    if (layoutVersion >= 2) {
      if (mode === 1) {
        let currentLat = view.getInt32(offset, true);
        offset += 4;
        latitudes[writeIndex] = currentLat === INT32_NAN ? Number.NaN : currentLat / GPS2_COORDINATE_SCALE;
        for (let i = 1; i < count && (writeIndex + i) < pointCount; i += 1) {
          currentLat += view.getInt16(offset, true);
          offset += 2;
          latitudes[writeIndex + i] = currentLat === INT32_NAN ? Number.NaN : currentLat / GPS2_COORDINATE_SCALE;
        }

        let currentLng = view.getInt32(offset, true);
        offset += 4;
        longitudes[writeIndex] = currentLng === INT32_NAN ? Number.NaN : currentLng / GPS2_COORDINATE_SCALE;
        for (let i = 1; i < count && (writeIndex + i) < pointCount; i += 1) {
          currentLng += view.getInt16(offset, true);
          offset += 2;
          longitudes[writeIndex + i] = currentLng === INT32_NAN ? Number.NaN : currentLng / GPS2_COORDINATE_SCALE;
        }

        writeIndex += count;
        continue;
      }

      for (let i = 0; i < count && (writeIndex + i) < pointCount; i += 1) {
        const rawLat = view.getInt32(offset, true);
        offset += 4;
        latitudes[writeIndex + i] = rawLat === INT32_NAN ? Number.NaN : rawLat / GPS2_COORDINATE_SCALE;
      }
      for (let i = 0; i < count && (writeIndex + i) < pointCount; i += 1) {
        const rawLng = view.getInt32(offset, true);
        offset += 4;
        longitudes[writeIndex + i] = rawLng === INT32_NAN ? Number.NaN : rawLng / GPS2_COORDINATE_SCALE;
      }
      writeIndex += count;
      continue;
    }

    if (mode === 1) {
      let currentLat = view.getInt32(offset, true);
      offset += 4;
      let currentLng = view.getInt32(offset, true);
      offset += 4;
      latitudes[writeIndex] = currentLat === INT32_NAN ? Number.NaN : currentLat / GPS2_COORDINATE_SCALE;
      longitudes[writeIndex] = currentLng === INT32_NAN ? Number.NaN : currentLng / GPS2_COORDINATE_SCALE;
      writeIndex += 1;

      for (let i = 1; i < count && writeIndex < pointCount; i += 1) {
        currentLat += view.getInt16(offset, true);
        offset += 2;
        currentLng += view.getInt16(offset, true);
        offset += 2;
        latitudes[writeIndex] = currentLat === INT32_NAN ? Number.NaN : currentLat / GPS2_COORDINATE_SCALE;
        longitudes[writeIndex] = currentLng === INT32_NAN ? Number.NaN : currentLng / GPS2_COORDINATE_SCALE;
        writeIndex += 1;
      }
      continue;
    }

    for (let i = 0; i < count && writeIndex < pointCount; i += 1) {
      const rawLat = view.getInt32(offset, true);
      offset += 4;
      const rawLng = view.getInt32(offset, true);
      offset += 4;
      latitudes[writeIndex] = rawLat === INT32_NAN ? Number.NaN : rawLat / GPS2_COORDINATE_SCALE;
      longitudes[writeIndex] = rawLng === INT32_NAN ? Number.NaN : rawLng / GPS2_COORDINATE_SCALE;
      writeIndex += 1;
    }
  }

  return { latitudes, longitudes };
}

export default class GpsTrackBlobService {
  static isValidGpsSlot(slot) {
    return isValidGpsSlotPoint(slot);
  }

  static parseGeoJsonTrack(geoJsonTrack = null) {
    const coordinates = Array.isArray(geoJsonTrack?.coordinates)
      ? geoJsonTrack.coordinates
      : [];

    return coordinates
      .map((point) => ({
        lat: Number(Array.isArray(point) ? point[1] : null),
        lng: Number(Array.isArray(point) ? point[0] : null)
      }))
      .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));
  }

  static encodeTrackBuffer(track = [], options = {}) {
    const points = normalizeTrackPoints(track);
    const pointCount = points.length;
    const sampleRateGps = Math.max(1, Math.round(Number(options.sampleRateGps) || 1));
    const buffer = new ArrayBuffer(GPS_TRACK_BLOB_HEADER_BYTES + (pointCount * 8));
    const view = new DataView(buffer);
    const latOffset = GPS_TRACK_BLOB_HEADER_BYTES;
    const lngOffset = latOffset + (pointCount * 4);
    const lats = new Int32Array(buffer, latOffset, pointCount);
    const lngs = new Int32Array(buffer, lngOffset, pointCount);

    let minLatQ = 0;
    let maxLatQ = 0;
    let minLngQ = 0;
    let maxLngQ = 0;

    for (let index = 0; index < pointCount; index += 1) {
      const latQ = Math.round(points[index].lat * GPS_TRACK_BLOB_SCALE);
      const lngQ = Math.round(points[index].lng * GPS_TRACK_BLOB_SCALE);
      lats[index] = latQ;
      lngs[index] = lngQ;

      if (index === 0) {
        minLatQ = maxLatQ = latQ;
        minLngQ = maxLngQ = lngQ;
      } else {
        if (latQ < minLatQ) minLatQ = latQ;
        if (latQ > maxLatQ) maxLatQ = latQ;
        if (lngQ < minLngQ) minLngQ = lngQ;
        if (lngQ > maxLngQ) maxLngQ = lngQ;
      }
    }

    view.setUint8(0, GPS_TRACK_BLOB_VERSION);
    view.setUint8(1, 0);
    view.setUint16(2, 0);
    view.setUint32(4, pointCount);
    view.setUint16(8, sampleRateGps);
    view.setUint16(10, 0);
    view.setUint32(12, GPS_TRACK_BLOB_SCALE);
    view.setInt32(16, minLatQ);
    view.setInt32(20, maxLatQ);
    view.setInt32(24, minLngQ);
    view.setInt32(28, maxLngQ);

    return Buffer.from(buffer);
  }

  static encodeTrackBufferFromQuantized(payload = {}, options = {}) {
    const latitudesQ = payload?.latitudesQ instanceof Int32Array
      ? payload.latitudesQ
      : new Int32Array(payload?.latitudesQ || []);
    const longitudesQ = payload?.longitudesQ instanceof Int32Array
      ? payload.longitudesQ
      : new Int32Array(payload?.longitudesQ || []);
    const pointCount = Math.min(latitudesQ.length, longitudesQ.length);
    const sampleRateGps = Math.max(1, Math.round(Number(options.sampleRateGps ?? payload?.sampleRateGps) || 1));
    const scale = Math.max(1, Math.round(Number(options.scale ?? payload?.scale) || GPS_TRACK_BLOB_SCALE));
    const buffer = new ArrayBuffer(GPS_TRACK_BLOB_HEADER_BYTES + (pointCount * 8));
    const view = new DataView(buffer);
    const latOffset = GPS_TRACK_BLOB_HEADER_BYTES;
    const lngOffset = latOffset + (pointCount * 4);
    const outLats = new Int32Array(buffer, latOffset, pointCount);
    const outLngs = new Int32Array(buffer, lngOffset, pointCount);

    outLats.set(latitudesQ.subarray(0, pointCount));
    outLngs.set(longitudesQ.subarray(0, pointCount));

    let minLatQ = 0;
    let maxLatQ = 0;
    let minLngQ = 0;
    let maxLngQ = 0;

    if (pointCount > 0) {
      minLatQ = maxLatQ = outLats[0];
      minLngQ = maxLngQ = outLngs[0];
      for (let index = 1; index < pointCount; index += 1) {
        const latQ = outLats[index];
        const lngQ = outLngs[index];
        if (latQ < minLatQ) minLatQ = latQ;
        if (latQ > maxLatQ) maxLatQ = latQ;
        if (lngQ < minLngQ) minLngQ = lngQ;
        if (lngQ > maxLngQ) maxLngQ = lngQ;
      }
    }

    view.setUint8(0, GPS_TRACK_BLOB_VERSION);
    view.setUint8(1, 0);
    view.setUint16(2, 0);
    view.setUint32(4, pointCount);
    view.setUint16(8, sampleRateGps);
    view.setUint16(10, 0);
    view.setUint32(12, scale);
    view.setInt32(16, minLatQ);
    view.setInt32(20, maxLatQ);
    view.setInt32(24, minLngQ);
    view.setInt32(28, maxLngQ);

    return Buffer.from(buffer);
  }

  static decodeTrackBuffer(bufferLike, options = {}) {
    const includeGeoJson = options?.includeGeoJson !== false;
    const source = Buffer.isBuffer(bufferLike)
      ? bufferLike
      : Buffer.from(bufferLike || []);
    if (!source || source.length < 4) {
      return {
        version: null,
        sampleRateGps: 1,
        points: [],
        track: [],
        pointCount: 0,
        validGps: false,
        geoJson: null,
        bbox: null
      };
    }

    const magic = TEXT_DECODER.decode(source.subarray(0, 4));
    if (magic === "GPS2") {
      return this.decodeGps2TrackBuffer(source, options);
    }

    if (source.length < GPS_TRACK_BLOB_HEADER_BYTES) {
      return {
        version: null,
        sampleRateGps: 1,
        points: [],
        track: [],
        pointCount: 0,
        validGps: false,
        geoJson: null,
        bbox: null
      };
    }

    const arrayBuffer = source.buffer.slice(
      source.byteOffset,
      source.byteOffset + source.byteLength
    );
    const view = new DataView(arrayBuffer);
    const version = view.getUint8(0);
    if (version !== GPS_TRACK_BLOB_VERSION) {
      throw new Error(`Unsupported gps track blob version: ${version}`);
    }

    const pointCount = view.getUint32(4);
    const sampleRateGps = view.getUint16(8) || 1;
    const scale = view.getUint32(12) || GPS_TRACK_BLOB_SCALE;
    const latOffset = GPS_TRACK_BLOB_HEADER_BYTES;
    const lngOffset = latOffset + (pointCount * 4);
    if (source.length < lngOffset + (pointCount * 4)) {
      throw new Error("GPS track blob payload is truncated");
    }

    const lats = new Int32Array(arrayBuffer, latOffset, pointCount);
    const lngs = new Int32Array(arrayBuffer, lngOffset, pointCount);
    const { slots, slotCount, points, pointCount: validPointCount, segments } = buildGpsSlotsAndSegments(
      Array.from(lats, (value) => value / scale),
      Array.from(lngs, (value) => value / scale),
      sampleRateGps,
      0
    );

    const bbox = validPointCount >= 2
      ? {
          minLat: view.getInt32(16) / scale,
          maxLat: view.getInt32(20) / scale,
          minLng: view.getInt32(24) / scale,
          maxLng: view.getInt32(28) / scale
        }
      : null;

    return {
      version,
      sampleRateGps,
      slots,
      slotCount,
      points,
      track: points,
      pointCount: validPointCount,
      validGps: validPointCount >= 2,
      segments,
      geoJson: includeGeoJson && validPointCount >= 2 ? toSegmentGeoJson(segments) : null,
      bbox
    };
  }

  static decodeGps2TrackBuffer(bufferLike, options = {}) {
    const includeGeoJson = options?.includeGeoJson !== false;
    const source = Buffer.isBuffer(bufferLike)
      ? bufferLike
      : Buffer.from(bufferLike || []);
    const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
    const magic = TEXT_DECODER.decode(source.subarray(0, 4));
    if (magic !== "GPS2") {
      throw new Error(`Unsupported GPS track block: ${magic}`);
    }

    const layoutVersion = view.getUint16(4, true) || 1;
    const sampleRateSeconds = view.getUint16(6, true) || 1;
    const pointCount = view.getUint32(8, true);
    const firstTimestampMs = view.getFloat64(12, true);
    const decoded = layoutVersion === 5
      ? decodeGpsBitmapColumnarPayload(source, pointCount)
      : decodeGpsCoordinatePayload(source.subarray(GPS2_HEADER_BYTES), pointCount, layoutVersion);
    const { latitudes, longitudes } = decoded;
    const { slots, slotCount, points, pointCount: validPointCount, segments } = buildGpsSlotsAndSegments(
      latitudes,
      longitudes,
      sampleRateSeconds,
      firstTimestampMs
    );

    let minLat = Infinity;
    let maxLat = -Infinity;
    let minLng = Infinity;
    let maxLng = -Infinity;
    for (const point of points) {
      if (point.lat < minLat) minLat = point.lat;
      if (point.lat > maxLat) maxLat = point.lat;
      if (point.lng < minLng) minLng = point.lng;
      if (point.lng > maxLng) maxLng = point.lng;
    }

    return {
      version: 2,
      sampleRateGps: sampleRateSeconds,
      slots,
      slotCount,
      points,
      track: points,
      pointCount: validPointCount,
      validGps: validPointCount >= 2,
      segments,
      geoJson: includeGeoJson && validPointCount >= 2 ? toSegmentGeoJson(segments) : null,
      bbox: validPointCount > 0 ? { minLat, maxLat, minLng, maxLng } : null,
      firstTimestampMs
    };
  }

  static async encodeCompressed(track = [], options = {}) {
    const raw = this.encodeTrackBuffer(track, options);
    return Workout.compress(raw, options.codec || DEFAULT_GPS_TRACK_BLOB_CODEC);
  }

  static async encodeCompressedFromQuantized(payload = {}, options = {}) {
    const raw = this.encodeTrackBufferFromQuantized(payload, options);
    return Workout.compress(raw, options.codec || DEFAULT_GPS_TRACK_BLOB_CODEC);
  }

  static async decodeCompressed(bufferLike, options = {}) {
    if (!bufferLike) {
      return {
        version: null,
        sampleRateGps: 1,
        points: [],
        track: [],
        pointCount: 0,
        validGps: false,
        geoJson: null,
        bbox: null
      };
    }

    const raw = await Workout.decompress(bufferLike, options.codec || "brotli");
    return this.decodeTrackBuffer(raw, options);
  }

  static async decodeCompressedCompact(bufferLike, options = {}) {
    const raw = await Workout.decompress(bufferLike, options.codec || "brotli");
    const source = Buffer.isBuffer(raw) ? raw : Buffer.from(new Uint8Array(raw));
    const magic = source.length >= 4 ? TEXT_DECODER.decode(source.subarray(0, 4)) : "";

    if (magic === "GPS2" && source.length >= GPS2_HEADER_BYTES) {
      const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
      const layoutVersion = view.getUint16(4, true) || 1;
      const sampleRateGps = view.getUint16(6, true) || 1;
      const pointCount = view.getUint32(8, true);
      if (layoutVersion === 5) {
        const compact = decodeGpsBitmapColumnarCompactPayload(source, pointCount, options);
        return {
          layoutVersion,
          sampleRateGps,
          pointCount: compact.validPointCount,
          slotCount: pointCount,
          latitudesE5: compact.latitudesE5,
          longitudesE5: compact.longitudesE5,
          slotIndices: compact.slotIndices,
          byteLength: compact.latitudesE5.byteLength
            + compact.longitudesE5.byteLength
            + (compact.slotIndices?.byteLength || 0)
        };
      }
    }

    const decoded = this.decodeTrackBuffer(source, { includeGeoJson: false });
    const points = Array.isArray(decoded?.points) ? decoded.points : [];
    const latitudesE5 = new Int32Array(points.length);
    const longitudesE5 = new Int32Array(points.length);
    const slotIndices = options?.includeSlotIndices === true
      ? new Uint32Array(points.length)
      : null;
    for (let index = 0; index < points.length; index += 1) {
      latitudesE5[index] = Math.round(Number(points[index]?.lat || 0) * GPS2_E5_COORDINATE_SCALE);
      longitudesE5[index] = Math.round(Number(points[index]?.lng || 0) * GPS2_E5_COORDINATE_SCALE);
      if (slotIndices) {
        slotIndices[index] = Number.isInteger(Number(points[index]?.slotIndex))
          ? Number(points[index].slotIndex)
          : index;
      }
    }

    return {
      layoutVersion: decoded?.version ?? null,
      sampleRateGps: decoded?.sampleRateGps || 1,
      pointCount: points.length,
      slotCount: decoded?.slotCount ?? points.length,
      latitudesE5,
      longitudesE5,
      slotIndices,
      byteLength: latitudesE5.byteLength
        + longitudesE5.byteLength
        + (slotIndices?.byteLength || 0)
    };
  }

  static async decodeRowTrack(row = {}, options = {}) {
    const includeGeoJson = options?.includeGeoJson !== false;
    if (row?.gps_track_blob) {
      const codec = row?.gps_track_blob_codec
        ? String(row.gps_track_blob_codec)
        : inferCompressedCodec(row.gps_track_blob, "brotli");
      try {
        return await this.decodeCompressed(row.gps_track_blob, {
          includeGeoJson,
          codec
        });
      } catch (error) {
        const diagnostic = {
          workoutId: row?.id ?? row?.wid ?? null,
          uid: row?.uid ?? null,
          codec,
          blobBytes: Buffer.isBuffer(row.gps_track_blob)
            ? row.gps_track_blob.byteLength
            : Number(row?.gps_track_blob?.length || 0),
          sampleRateGps: Number(row?.samplerategps ?? row?.sampleRateGPS ?? 0) || null,
          validGps: row?.validgps ?? row?.validGps ?? null,
          hasBounds: row?.bounds != null,
          includeGeoJson
        };
        console.error("[gps-track] decodeRowTrack.failed", diagnostic);
        error.message = `${error.message} [gps_track_blob decode workoutId=${diagnostic.workoutId ?? "unknown"} codec=${codec} bytes=${diagnostic.blobBytes}]`;
        throw error;
      }
    }

    const points = this.parseGeoJsonTrack(row?.track ?? row?.track_geojson ?? row?.geom ?? null);
    return {
      version: null,
      sampleRateGps: Number(row?.samplerategps ?? row?.sampleRateGPS ?? 1) || 1,
      points,
      track: points,
      pointCount: points.length,
      validGps: points.length >= 2,
      geoJson: includeGeoJson && points.length >= 2 ? toGeoJson(points) : null,
      bbox: row?.bounds ?? null
    };
  }
}
