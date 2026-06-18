import "../config/env.js";

import { gzipSync } from "node:zlib";

import pool from "../services/database.js";
import Workout from "../shared/Workout.js";
import GpsTrackBlobService from "../services/gpsTrackBlobService.js";

const UINT8_NAN = 0xFF;
const UINT16_NAN = 0xFFFF;
const UINT32_NAN = 0xFFFFFFFF;
const INT16_NAN = -0x8000;
const INT32_NAN = -0x80000000;
const MICRO_DEGREES = 1e7;
const DELTA_BLOCK_SIZE = 128;

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    workoutId: null,
    gzipLevel: 6
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    if (arg === "--workout" && next) {
      out.workoutId = Number.parseInt(next, 10);
      index += 1;
      continue;
    }

    if (arg === "--gzip-level" && next) {
      out.gzipLevel = Math.max(0, Math.min(9, Number.parseInt(next, 10) || 6));
      index += 1;
    }
  }

  if (!Number.isInteger(out.workoutId) || out.workoutId <= 0) {
    throw new Error("Missing required --workout <id>");
  }

  return out;
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
  const payloadBytes = distancesBytes + powersBytes + heartRatesBytes + cadencesBytes + speedsBytes + altitudesBytes;
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

  new Uint8Array(buffer, 0, 4).set(new TextEncoder().encode("WST3"));
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

  return Buffer.from(buffer);
}

function buildGpsTrackBlock(gpsTrack) {
  const points = Array.isArray(gpsTrack?.track)
    ? gpsTrack.track.map((point) => ({ lat: Number(point[0]), lng: Number(point[1]) }))
    : [];
  const pointCount = points.length;
  const payload = buildGpsCoordinatePayload(points);
  const headerBytes = 20;
  const buffer = new ArrayBuffer(headerBytes + payload.byteLength);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  bytes.set(new TextEncoder().encode("GPS2"), 0);
  view.setUint16(4, 2, true);
  view.setUint16(6, Math.max(1, Math.round(Number(gpsTrack?.sampleRate) || 5)), true);
  view.setUint32(8, pointCount, true);
  view.setFloat64(12, Number(gpsTrack?.firstTimestampMs || 0), true);
  bytes.set(payload, headerBytes);

  return Buffer.from(buffer);
}

function toRecordsTyped(workoutObject) {
  const recordCount = Number(workoutObject?.length || 0);
  const timestampsMs = new Float64Array(recordCount);
  const distancesM = new Float64Array(recordCount);
  const powersW = new Float64Array(recordCount);
  const heartRatesBpm = new Float64Array(recordCount);
  const cadencesRpm = new Float64Array(recordCount);
  const speedsMps = new Float64Array(recordCount);
  const altitudesM = new Float64Array(recordCount);
  const startTimeMs = Number(workoutObject.getStartTime());

  for (let index = 0; index < recordCount; index += 1) {
    timestampsMs[index] = startTimeMs + (index * 1000);
    distancesM[index] = Number(workoutObject.getDistanceAt(index));
    powersW[index] = Number(workoutObject.getPowerAt(index));
    heartRatesBpm[index] = Number(workoutObject.getHrAt(index));
    cadencesRpm[index] = Number(workoutObject.getCadenceAt(index));
    speedsMps[index] = Number(workoutObject.getSpeedAt(index));
    altitudesM[index] = Number(workoutObject.getAltitudeAt(index));
  }

  return {
    recordCount,
    timestampsMs,
    distancesM,
    powersW,
    heartRatesBpm,
    cadencesRpm,
    speedsMps,
    altitudesM
  };
}

async function loadWorkoutRow(workoutId) {
  const result = await pool.query(
    `
    SELECT
      id,
      uid,
      stream,
      stream_codec,
      gps_track_blob,
      gps_track_blob_codec,
      octet_length(stream) AS stream_bytes,
      octet_length(gps_track_blob) AS gps_track_blob_bytes
    FROM workouts
    WHERE id = $1
    LIMIT 1
    `,
    [workoutId]
  );

  if (result.rowCount === 0) {
    throw new Error(`Workout ${workoutId} not found`);
  }

  return result.rows[0];
}

async function run() {
  const { workoutId, gzipLevel } = parseArgs();
  const row = await loadWorkoutRow(workoutId);

  const workoutObject = await Workout.fromCompressedWithCodec(row.stream, row.stream_codec || "brotli");
  const decodedTrack = await GpsTrackBlobService.decodeRowTrack({
    gps_track_blob: row.gps_track_blob,
    gps_track_blob_codec: row.gps_track_blob_codec,
    includeGeoJson: false
  });

  const recordsTyped = toRecordsTyped(workoutObject);
  const workoutStreamBlock = buildWorkoutStreamBlock(recordsTyped);
  const gpsTrackBlock = buildGpsTrackBlock(decodedTrack);

  const gzipWorkoutStream = gzipSync(workoutStreamBlock, { level: gzipLevel });
  const gzipGpsTrack = gzipSync(gpsTrackBlock, { level: gzipLevel });
  const brotliWorkoutStream = await Workout.compress(workoutStreamBlock, "brotli");
  const brotliGpsTrack = await Workout.compress(gpsTrackBlock, "brotli");

  const currentStreamBytes = Number(row.stream_bytes || row.stream?.length || 0);
  const currentGpsBytes = Number(row.gps_track_blob_bytes || row.gps_track_blob?.length || 0);
  const currentTotalBytes = currentStreamBytes + currentGpsBytes;
  const harmonizedRawBytes = workoutStreamBlock.length + gpsTrackBlock.length;
  const harmonizedGzipBytes = gzipWorkoutStream.length + gzipGpsTrack.length;
  const harmonizedBrotliBytes = (brotliWorkoutStream?.length || 0) + (brotliGpsTrack?.length || 0);

  console.table([{
    workoutId,
    currentStreamBytes,
    currentGpsBytes,
    currentTotalBytes,
    harmonizedWorkoutRawBytes: workoutStreamBlock.length,
    harmonizedGpsRawBytes: gpsTrackBlock.length,
    harmonizedRawBytes,
    harmonizedWorkoutGzipBytes: gzipWorkoutStream.length,
    harmonizedGpsGzipBytes: gzipGpsTrack.length,
    harmonizedGzipBytes,
    harmonizedWorkoutBrotliBytes: brotliWorkoutStream.length,
    harmonizedGpsBrotliBytes: brotliGpsTrack.length,
    harmonizedBrotliBytes,
    gzipDeltaBytes: harmonizedGzipBytes - currentTotalBytes,
    gzipRatioVsCurrentPct: currentTotalBytes > 0
      ? Number(((harmonizedGzipBytes / currentTotalBytes) * 100).toFixed(2))
      : 0,
    brotliDeltaBytes: harmonizedBrotliBytes - currentTotalBytes,
    brotliRatioVsCurrentPct: currentTotalBytes > 0
      ? Number(((harmonizedBrotliBytes / currentTotalBytes) * 100).toFixed(2))
      : 0,
    gzipLevel
  }]);

  console.log("Notes:");
  console.log("- currentTotalBytes = current DB stream + current DB gps_track_blob");
  console.log("- harmonizedGzipBytes = hypothetical DB bytes if WOA-style workout/gps blocks were stored gzip-compressed directly");
  console.log("- harmonizedBrotliBytes = same hypothetical harmonized format, but compressed with brotli");
  console.log("- ratio below 100 means the hypothetical harmonized format would be smaller than the current persisted format");
}

run()
  .catch((error) => {
    console.error("WOA harmonized persistence benchmark failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
