import Workout from "./Workout.js";

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

function toGeoJson(points = []) {
  return {
    type: "LineString",
    coordinates: points.map((point) => [point.lng, point.lat])
  };
}

function inferCompressedCodec(bufferLike, fallback = "brotli") {
  if (!bufferLike) {
    return fallback;
  }

  const bytes = bufferLike instanceof Uint8Array
    ? bufferLike
    : new Uint8Array(bufferLike);

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

export default class GpsTrackBlobCodec {
  static isValidGpsSlot(slot) {
    return isValidGpsSlotPoint(slot);
  }

  static decodeTrackBuffer(bufferLike, options = {}) {
    const includeGeoJson = options?.includeGeoJson !== false;
    const source = bufferLike instanceof Uint8Array
      ? bufferLike
      : new Uint8Array(bufferLike || new ArrayBuffer(0));

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

    const arrayBuffer = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
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
    const source = bufferLike instanceof Uint8Array
      ? bufferLike
      : new Uint8Array(bufferLike || new ArrayBuffer(0));
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

    const codec = options.codec || inferCompressedCodec(bufferLike, "brotli");
    const raw = await Workout.decompress(bufferLike, codec);
    return this.decodeTrackBuffer(raw, options);
  }
}
