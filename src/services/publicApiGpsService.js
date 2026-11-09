import { gunzipSync, brotliDecompressSync } from "node:zlib";
import GpsTrackBlobService from "./gpsTrackBlobService.js";

export const PUBLIC_GPS_LIMITS = Object.freeze({ blobBytes: 2 * 1024 * 1024, rawBytes: 4 * 1024 * 1024,
  responseBytes: 4 * 1024 * 1024, slots: 100000, timeoutMs: 2000, workers: 2 });

function budgetExceeded() {
  throw Object.assign(new Error("GPS response exceeds the configured budget."),
    { statusCode: 422, code: "gps_response_too_large" });
}

// The legacy decoder tolerates incomplete GPS2 blocks by leaving zero-filled
// slots. Validate their structure first so corrupt data cannot fabricate a route.
function validateLegacyGps2(raw, slots, layout) {
  let offset = 20;
  let written = 0;
  const invalid = () => { throw new Error("Invalid GPS payload"); };
  const take = count => {
    if (offset + count > raw.byteLength) invalid();
    const start = offset;
    offset += count;
    return start;
  };
  while (written < slots) {
    const header = take(3);
    const mode = raw[header];
    const count = raw.readUInt16LE(header + 1);
    if (!count || count > slots - written || mode > Math.max(1, layout - 1)) invalid();
    if (mode === 0) take(count * 8);
    else if (mode === 1) take(8 + (count - 1) * 4);
    else if (mode === 2) {
      take(8);
      const tokens = take((count - 1) * 4);
      for (let index = 0; index < count - 1; index += 1) {
        const latitude = raw.readInt16LE(tokens + index * 4);
        const longitude = raw.readInt16LE(tokens + index * 4 + 2);
        if (latitude === -32768 && longitude === 0) take(8);
        else if ((latitude === -32768 || longitude === -32768) && !(latitude === -32768 && longitude === -32768)) invalid();
      }
    } else if (mode === 3) {
      take(8);
      for (let index = 1; index < count; index += 1) {
        const marker = raw.readInt8(take(1));
        if (marker === 126) take(4);
        else if (marker === 127) {
          const subtype = raw[take(1)];
          if (subtype === 1) take(8);
          else if (subtype !== 0) invalid();
        } else take(1);
      }
    } else invalid();
    written += count;
  }
  if (offset !== raw.byteLength) invalid();
}

/** @param {{blobBytes: number, rawBytes: number, slots: number}} limits */
export function decodePublicGpsTrack(blob, storedCodec, limits = PUBLIC_GPS_LIMITS) {
  if (blob.byteLength > limits.blobBytes) budgetExceeded();
  const bytes = Buffer.from(blob);
  const codec = storedCodec || (bytes[0] === 1 ? "identity" : GpsTrackBlobService.inferCompressedCodec(bytes, "brotli"));
  let raw;
  try {
    if (codec === "identity") raw = bytes;
    else if (codec === "gzip") raw = gunzipSync(bytes, { maxOutputLength: limits.rawBytes });
    else if (codec === "brotli") raw = brotliDecompressSync(bytes, { maxOutputLength: limits.rawBytes });
    else throw new Error("Unsupported GPS codec");
  } catch (error) {
    if (error.code === "ERR_BUFFER_TOO_LARGE") budgetExceeded();
    throw error;
  }
  if (raw.byteLength > limits.rawBytes) budgetExceeded();
  const gps2 = raw.subarray(0, 4).toString("ascii") === "GPS2";
  if (raw.byteLength < (gps2 ? 20 : 32) || (!gps2 && raw[0] !== 1)) throw new Error("Invalid GPS header");
  if (gps2 && (raw.readUInt16LE(4) < 1 || raw.readUInt16LE(4) > 5)) throw new Error("Invalid GPS layout");
  const slots = gps2 ? raw.readUInt32LE(8) : raw.readUInt32BE(4);
  if (slots > limits.slots) budgetExceeded();
  if (gps2 && raw.readUInt16LE(4) < 5) validateLegacyGps2(raw, slots, raw.readUInt16LE(4));
  if (!gps2 && raw.byteLength !== 32 + slots * 8) throw new Error("Invalid GPS payload");
  return GpsTrackBlobService.decodeTrackBuffer(raw, { includeGeoJson: false });
}

export function decodePublicGps(blob, storedCodec, workoutId) {
  const decoded = decodePublicGpsTrack(blob, storedCodec);
  const lines = [];
  let line = [];
  const finishLine = () => { if (line.length >= 2) lines.push(line); line = []; };
  for (const point of decoded.slots) {
    if (!point.valid || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)
      || Math.abs(point.lat) > 90 || Math.abs(point.lng) > 180) {
      finishLine();
    } else line.push([point.lng, point.lat]);
  }
  finishLine();
  const json = JSON.stringify({ type: "Feature", properties: { workout_id: workoutId },
    geometry: lines.length ? { type: "MultiLineString", coordinates: lines } : null });
  if (Buffer.byteLength(json) > PUBLIC_GPS_LIMITS.responseBytes) budgetExceeded();
  return json;
}
