import Workout from "../shared/Workout.js";
import { buildGpsSlotsAndSegments, decodeGpsBitmapColumnarPayload,
  decodeGpsCoordinatePayload, toSegmentGeoJson } from "../shared/GpsTrackBlobCodec.js";

const GPS_TRACK_BLOB_VERSION = 1;
const GPS_TRACK_BLOB_SCALE = 100000;
const GPS2_E5_COORDINATE_SCALE = 100000;
const GPS2_TIERED_INT16_MARKER = 126;
const GPS2_TIERED_EXTENDED_MARKER = 127;
const GPS_TRACK_BLOB_HEADER_BYTES = 32;
const GPS2_HEADER_BYTES = 20;
const INT32_NAN = -0x80000000;
const TEXT_DECODER = new TextDecoder();
const DEFAULT_GPS_TRACK_BLOB_CODEC = "identity";

function isFiniteCoordinate(value) {
  return Number.isFinite(Number(value));
}

function isValidGpsSlotPoint(point) {
  return !!point && isFiniteCoordinate(point.lat) && isFiniteCoordinate(point.lng);
}

function inferCompressedCodec(bufferLike, fallback = DEFAULT_GPS_TRACK_BLOB_CODEC) {
  if (!bufferLike) {
    return fallback;
  }

  const bytes = Buffer.isBuffer(bufferLike)
    ? bufferLike
    : Buffer.from(bufferLike);

  if (bytes.length >= 4
    && bytes[0] === 0x47
    && bytes[1] === 0x50
    && bytes[2] === 0x53
    && (bytes[3] === 0x31 || bytes[3] === 0x32)) {
    return "identity";
  }

  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return "gzip";
  }

  return fallback;
}

function normalizeGpsTrackCodec(codec) {
  const normalized = String(codec || DEFAULT_GPS_TRACK_BLOB_CODEC).trim().toLowerCase();
  if (normalized === "identity" || normalized === "gzip" || normalized === "brotli") {
    return normalized;
  }
  throw new Error(`Unsupported GPS track codec: ${codec}`);
}

function toByteView(bufferLike) {
  return bufferLike instanceof Uint8Array ? bufferLike : new Uint8Array(bufferLike);
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

  const latitudesE5 = new Int32Array(validPointCount);
  const longitudesE5 = new Int32Array(validPointCount);
  const slotIndices = options?.includeSlotIndices === true ? new Uint32Array(validPointCount) : null;
  let latitudeOffset = latitudeStart;
  let longitudeOffset = longitudeStart;
  let previousLatitude = 0;
  let previousLongitude = 0;
  let previousValid = false;
  let writeIndex = 0;

  for (let index = 0; index < pointCount; index += 1) {
    const valid = (source[headerBytes + (index >> 3)] & (1 << (index & 7))) !== 0;
    if (!valid) {
      previousValid = false;
      continue;
    }

    if (!previousValid) {
      if (latitudeOffset + 4 > longitudeStart || longitudeOffset + 4 > source.byteLength) {
        throw new Error("GPS2 layout v5 coordinate payload is truncated");
      }
      previousLatitude = view.getInt32(latitudeOffset, true);
      previousLongitude = view.getInt32(longitudeOffset, true);
      latitudeOffset += 4;
      longitudeOffset += 4;
    } else {
      if (latitudeOffset >= longitudeStart || longitudeOffset >= source.byteLength) {
        throw new Error("GPS2 layout v5 coordinate payload is truncated");
      }

      const latitudeMarker = view.getUint8(latitudeOffset);
      if (latitudeMarker === GPS2_TIERED_INT16_MARKER) {
        if (latitudeOffset + 3 > longitudeStart) throw new Error("GPS2 layout v5 coordinate payload is truncated");
        previousLatitude += view.getInt16(latitudeOffset + 1, true);
        latitudeOffset += 3;
      } else if (latitudeMarker === GPS2_TIERED_EXTENDED_MARKER) {
        if (latitudeOffset + 5 > longitudeStart) throw new Error("GPS2 layout v5 coordinate payload is truncated");
        previousLatitude = view.getInt32(latitudeOffset + 1, true);
        latitudeOffset += 5;
      } else {
        previousLatitude += view.getInt8(latitudeOffset);
        latitudeOffset += 1;
      }

      const longitudeMarker = view.getUint8(longitudeOffset);
      if (longitudeMarker === GPS2_TIERED_INT16_MARKER) {
        if (longitudeOffset + 3 > source.byteLength) throw new Error("GPS2 layout v5 coordinate payload is truncated");
        previousLongitude += view.getInt16(longitudeOffset + 1, true);
        longitudeOffset += 3;
      } else if (longitudeMarker === GPS2_TIERED_EXTENDED_MARKER) {
        if (longitudeOffset + 5 > source.byteLength) throw new Error("GPS2 layout v5 coordinate payload is truncated");
        previousLongitude = view.getInt32(longitudeOffset + 1, true);
        longitudeOffset += 5;
      } else {
        previousLongitude += view.getInt8(longitudeOffset);
        longitudeOffset += 1;
      }
    }

    latitudesE5[writeIndex] = previousLatitude;
    longitudesE5[writeIndex] = previousLongitude;
    if (slotIndices) slotIndices[writeIndex] = index;
    writeIndex += 1;
    previousValid = true;
  }

  if (latitudeOffset !== longitudeStart || longitudeOffset !== source.byteLength) {
    throw new Error("GPS2 layout v5 coordinate payload has trailing bytes");
  }

  return {
    latitudesE5,
    longitudesE5,
    slotIndices,
    validPointCount
  };
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
    payloadBytes += delta >= -128 && delta <= 125 ? 1 : delta >= -32768 && delta <= 32767 ? 3 : 5;
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
      view.setUint8(offset, GPS2_TIERED_INT16_MARKER);
      view.setInt16(offset + 1, delta, true);
      offset += 3;
    } else {
      view.setUint8(offset, GPS2_TIERED_EXTENDED_MARKER);
      view.setInt32(offset + 1, current[key], true);
      offset += 5;
    }
  }
  return bytes;
}

function encodeGps2BitmapColumnar(quantized, sampleRateGps) {
  const bitmap = new Uint8Array(Math.ceil(quantized.length / 8));
  for (let index = 0; index < quantized.length; index += 1) {
    if (quantized[index]) bitmap[index >> 3] |= 1 << (index & 7);
  }
  const latitudes = buildGpsBitmapCoordinateColumn(quantized, "lat");
  const longitudes = buildGpsBitmapCoordinateColumn(quantized, "lng");
  const buffer = new ArrayBuffer(24 + bitmap.byteLength + latitudes.byteLength + longitudes.byteLength);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  bytes.set([0x47, 0x50, 0x53, 0x32], 0);
  view.setUint16(4, 5, true);
  view.setUint16(6, sampleRateGps, true);
  view.setUint32(8, quantized.length, true);
  view.setFloat64(12, 0, true);
  view.setUint32(20, latitudes.byteLength, true);
  let offset = 24;
  bytes.set(bitmap, offset);
  offset += bitmap.byteLength;
  bytes.set(latitudes, offset);
  offset += latitudes.byteLength;
  bytes.set(longitudes, offset);
  return bytes;
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

export default class GpsTrackBlobService {
  static inferCompressedCodec(bufferLike, fallback = DEFAULT_GPS_TRACK_BLOB_CODEC) {
    return inferCompressedCodec(bufferLike, fallback);
  }

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
    const sampleRateGps = Math.max(1, Math.round(Number(options.sampleRateGps) || 1));
    return encodeGps2BitmapColumnar(points.map((point) => ({
      lat: Math.round(point.lat * GPS2_E5_COORDINATE_SCALE),
      lng: Math.round(point.lng * GPS2_E5_COORDINATE_SCALE)
    })), sampleRateGps);
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
    const quantized = new Array(pointCount);
    for (let index = 0; index < pointCount; index += 1) {
      const lat = latitudesQ[index];
      const lng = longitudesQ[index];
      quantized[index] = lat === INT32_NAN || lng === INT32_NAN
        ? null
        : {
            lat: Math.round((lat * GPS2_E5_COORDINATE_SCALE) / scale),
            lng: Math.round((lng * GPS2_E5_COORDINATE_SCALE) / scale)
          };
    }
    return encodeGps2BitmapColumnar(quantized, sampleRateGps);
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
    const codec = normalizeGpsTrackCodec(options.codec);
    return codec === "identity" ? toByteView(raw) : Workout.compress(raw, codec);
  }

  static async encodeCompressedFromQuantized(payload = {}, options = {}) {
    const raw = this.encodeTrackBufferFromQuantized(payload, options);
    const codec = normalizeGpsTrackCodec(options.codec);
    return codec === "identity" ? toByteView(raw) : Workout.compress(raw, codec);
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

    const codec = normalizeGpsTrackCodec(options.codec);
    const raw = codec === "identity"
      ? toByteView(bufferLike)
      : await Workout.decompressBytes(bufferLike, codec);
    return this.decodeTrackBuffer(raw, options);
  }

  static async decodeCompressedCompact(bufferLike, options = {}) {
    const compressedBytes = Number(bufferLike?.byteLength ?? bufferLike?.length ?? 0);
    const codec = normalizeGpsTrackCodec(options.codec);
    let decompressMs = 0;
    let raw;
    if (codec === "identity") {
      raw = toByteView(bufferLike);
    } else {
      const decompressStartedAt = performance.now();
      raw = await Workout.decompressBytes(bufferLike, codec);
      decompressMs = performance.now() - decompressStartedAt;
    }
    const source = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    const rawBytes = source.byteLength;
    const decodeStartedAt = performance.now();
    const isGps2 = source.length >= 4
      && source[0] === 0x47
      && source[1] === 0x50
      && source[2] === 0x53
      && source[3] === 0x32;

    if (isGps2 && source.length >= GPS2_HEADER_BYTES) {
      const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
      const layoutVersion = view.getUint16(4, true) || 1;
      const sampleRateGps = view.getUint16(6, true) || 1;
      const pointCount = view.getUint32(8, true);
      if (layoutVersion === 5) {
        const compact = decodeGpsBitmapColumnarCompactPayload(source, pointCount, options);
        if (options.profile) {
          options.profile.decompressMs += decompressMs;
          options.profile.decodeMs += performance.now() - decodeStartedAt;
          options.profile.compressedBytes += compressedBytes;
          options.profile.rawBytes += rawBytes;
        }
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

    if (options.profile) {
      options.profile.decompressMs += decompressMs;
      options.profile.decodeMs += performance.now() - decodeStartedAt;
      options.profile.compressedBytes += compressedBytes;
      options.profile.rawBytes += rawBytes;
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
