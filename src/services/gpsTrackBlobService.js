import Workout from "../shared/Workout.js";

const GPS_TRACK_BLOB_VERSION = 1;
const GPS_TRACK_BLOB_SCALE = 100000;
const GPS_TRACK_BLOB_HEADER_BYTES = 32;

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

  static decodeTrackBuffer(bufferLike) {
    const source = Buffer.isBuffer(bufferLike)
      ? bufferLike
      : Buffer.from(bufferLike || []);
    if (!source || source.length < GPS_TRACK_BLOB_HEADER_BYTES) {
      return {
        version: null,
        sampleRateGps: 1,
        points: [],
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
      geoJson: pointCount >= 2 ? toGeoJson(points) : null,
      bbox
    };
  }

  static async encodeCompressed(track = [], options = {}) {
    const raw = this.encodeTrackBuffer(track, options);
    return Workout.compress(raw);
  }

  static async encodeCompressedFromQuantized(payload = {}, options = {}) {
    const raw = this.encodeTrackBufferFromQuantized(payload, options);
    return Workout.compress(raw);
  }

  static async decodeCompressed(bufferLike) {
    if (!bufferLike) {
      return {
        version: null,
        sampleRateGps: 1,
        points: [],
        geoJson: null,
        bbox: null
      };
    }

    const raw = await Workout.decompress(bufferLike);
    return this.decodeTrackBuffer(raw);
  }

  static async decodeRowTrack(row = {}) {
    if (row?.gps_track_blob) {
      return this.decodeCompressed(row.gps_track_blob);
    }

    const points = this.parseGeoJsonTrack(row?.track ?? row?.track_geojson ?? row?.geom ?? null);
    return {
      version: null,
      sampleRateGps: Number(row?.samplerategps ?? row?.sampleRateGPS ?? 1) || 1,
      points,
      geoJson: points.length >= 2 ? toGeoJson(points) : null,
      bbox: row?.bounds ?? null
    };
  }
}
