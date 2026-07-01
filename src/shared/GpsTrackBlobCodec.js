import Workout from "./Workout.js";

const GPS_TRACK_BLOB_VERSION = 1;
const GPS_TRACK_BLOB_SCALE = 100000;
const GPS2_COORDINATE_SCALE = 1000000;
const GPS_TRACK_BLOB_HEADER_BYTES = 32;
const GPS2_HEADER_BYTES = 20;
const DELTA_BLOCK_SIZE = 128;
const INT32_NAN = -0x80000000;
const TEXT_DECODER = new TextDecoder();

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
    const points = new Array(pointCount);
    for (let index = 0; index < pointCount; index += 1) {
      points[index] = {
        lat: lats[index] / scale,
        lng: lngs[index] / scale
      };
    }

    const bbox = pointCount >= 2
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
      points,
      track: points,
      pointCount,
      validGps: pointCount >= 2,
      geoJson: includeGeoJson && pointCount >= 2 ? toGeoJson(points) : null,
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
    const payload = source.subarray(GPS2_HEADER_BYTES);
    const { latitudes, longitudes } = decodeGpsCoordinatePayload(payload, pointCount, layoutVersion);
    const points = [];

    let minLat = Infinity;
    let maxLat = -Infinity;
    let minLng = Infinity;
    let maxLng = -Infinity;

    for (let index = 0; index < pointCount; index += 1) {
      const lat = latitudes[index];
      const lng = longitudes[index];
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        continue;
      }
      points.push({ lat, lng });
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
    }

    return {
      version: 2,
      sampleRateGps: sampleRateSeconds,
      points,
      track: points,
      pointCount: points.length,
      validGps: points.length >= 2,
      geoJson: includeGeoJson && points.length >= 2 ? toGeoJson(points) : null,
      bbox: points.length > 0 ? { minLat, maxLat, minLng, maxLng } : null,
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
