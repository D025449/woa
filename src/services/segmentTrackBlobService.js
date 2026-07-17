import GpsTrackBlobService from "./gpsTrackBlobService.js";

const DEFAULT_CODEC = "brotli";

export default class SegmentTrackBlobService {
  static async encode(track = [], options = {}) {
    return GpsTrackBlobService.encodeCompressed(track, {
      codec: options.codec || DEFAULT_CODEC,
      sampleRateGps: 1
    });
  }

  static async decode(bufferLike, options = {}) {
    const decoded = await GpsTrackBlobService.decodeCompressed(bufferLike, {
      codec: options.codec || DEFAULT_CODEC,
      includeGeoJson: false
    });
    return {
      points: decoded.points,
      pointCount: decoded.pointCount,
      bbox: decoded.bbox
    };
  }

  static async decodeRow(row = {}) {
    if (!row?.track_blob) {
      return { points: [], pointCount: 0, bbox: null };
    }
    return this.decode(row.track_blob, {
      codec: row.track_blob_codec || DEFAULT_CODEC
    });
  }
}
