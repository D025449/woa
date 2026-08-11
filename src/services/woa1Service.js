import { readWorkoutIntensityHeader } from "../shared/WorkoutIntensityHeader.js";
import {
  INTENSITY_MODEL_FEATURE_BYTES,
  decodeWorkoutIntensityModelFeatures
} from "../shared/WorkoutIntensityModelCodec.js";

const INT32_NAN = -0x80000000;
const MICRO_DEGREES = 1e6;
const TEXT_DECODER = new TextDecoder();

function readJsonBlock(bytes, offset, length) {
  const slice = bytes.subarray(offset, offset + length);
  return JSON.parse(TEXT_DECODER.decode(slice));
}

export function inspectWoa1Header(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = TEXT_DECODER.decode(bytes.subarray(0, 4));
  if (magic !== "WOA1") {
    throw new Error(`Unsupported WOA container: ${magic}`);
  }

  return {
    magic,
    majorVersion: view.getUint8(4),
    minorVersion: view.getUint8(5),
    metaLength: view.getUint32(8, true),
    sessionLength: view.getUint32(12, true),
    workoutStreamLength: view.getUint32(16, true),
    gpsTrackLength: view.getUint32(20, true),
    headerLength: 24
  };
}

function decodeGpsBitmapColumnarPayload(source, pointCount) {
  const headerBytes = 24;
  const bitmapBytes = Math.ceil(pointCount / 8);
  const scale = 100000;
  const int16Marker = 126;
  const absoluteMarker = 127;
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
        if (marker === int16Marker) {
          requireBytes(3);
          previous += view.getInt16(offset + 1, true);
          offset += 3;
        } else if (marker === absoluteMarker) {
          requireBytes(5);
          previous = view.getInt32(offset + 1, true);
          offset += 5;
        } else {
          previous += view.getInt8(offset);
          offset += 1;
        }
      }
      values[index] = previous / scale;
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
  const GPS2_E5_COORDINATE_SCALE = 100000;
  const GPS2_DELTA_ESCAPE = -0x8000;
  const GPS2_TIERED_INT16_MARKER = 126;
  const GPS2_TIERED_EXTENDED_MARKER = 127;
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
        latitudes[writeIndex] = currentLat === INT32_NAN ? Number.NaN : currentLat / MICRO_DEGREES;
        for (let i = 1; i < count && (writeIndex + i) < pointCount; i += 1) {
          currentLat += view.getInt16(offset, true);
          offset += 2;
          latitudes[writeIndex + i] = currentLat === INT32_NAN ? Number.NaN : currentLat / MICRO_DEGREES;
        }

        let currentLng = view.getInt32(offset, true);
        offset += 4;
        longitudes[writeIndex] = currentLng === INT32_NAN ? Number.NaN : currentLng / MICRO_DEGREES;
        for (let i = 1; i < count && (writeIndex + i) < pointCount; i += 1) {
          currentLng += view.getInt16(offset, true);
          offset += 2;
          longitudes[writeIndex + i] = currentLng === INT32_NAN ? Number.NaN : currentLng / MICRO_DEGREES;
        }

        writeIndex += count;
        continue;
      }

      for (let i = 0; i < count && (writeIndex + i) < pointCount; i += 1) {
        const rawLat = view.getInt32(offset, true);
        offset += 4;
        latitudes[writeIndex + i] = rawLat === INT32_NAN ? Number.NaN : rawLat / MICRO_DEGREES;
      }
      for (let i = 0; i < count && (writeIndex + i) < pointCount; i += 1) {
        const rawLng = view.getInt32(offset, true);
        offset += 4;
        longitudes[writeIndex + i] = rawLng === INT32_NAN ? Number.NaN : rawLng / MICRO_DEGREES;
      }
      writeIndex += count;
      continue;
    }

    if (mode === 1) {
      let currentLat = view.getInt32(offset, true);
      offset += 4;
      let currentLng = view.getInt32(offset, true);
      offset += 4;
      latitudes[writeIndex] = currentLat === INT32_NAN ? Number.NaN : currentLat / MICRO_DEGREES;
      longitudes[writeIndex] = currentLng === INT32_NAN ? Number.NaN : currentLng / MICRO_DEGREES;
      writeIndex += 1;

      for (let i = 1; i < count && writeIndex < pointCount; i += 1) {
        currentLat += view.getInt16(offset, true);
        offset += 2;
        currentLng += view.getInt16(offset, true);
        offset += 2;
        latitudes[writeIndex] = currentLat === INT32_NAN ? Number.NaN : currentLat / MICRO_DEGREES;
        longitudes[writeIndex] = currentLng === INT32_NAN ? Number.NaN : currentLng / MICRO_DEGREES;
        writeIndex += 1;
      }
      continue;
    }

    for (let i = 0; i < count && writeIndex < pointCount; i += 1) {
      const rawLat = view.getInt32(offset, true);
      offset += 4;
      const rawLng = view.getInt32(offset, true);
      offset += 4;
      latitudes[writeIndex] = rawLat === INT32_NAN ? Number.NaN : rawLat / MICRO_DEGREES;
      longitudes[writeIndex] = rawLng === INT32_NAN ? Number.NaN : rawLng / MICRO_DEGREES;
      writeIndex += 1;
    }
  }

  return { latitudes, longitudes };
}

export function decodeGpsTrackBlock(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = TEXT_DECODER.decode(bytes.subarray(0, 4));
  if (magic !== "GPS2") {
    throw new Error(`Unsupported GPS track block: ${magic}`);
  }

  const layoutVersion = view.getUint16(4, true) || 1;
  const sampleRateSeconds = view.getUint16(6, true);
  const pointCount = view.getUint32(8, true);
  const firstTimestampMs = view.getFloat64(12, true);
  const decoded = layoutVersion === 5
    ? decodeGpsBitmapColumnarPayload(bytes, pointCount)
    : decodeGpsCoordinatePayload(bytes.subarray(20), pointCount, layoutVersion);
  const { latitudes, longitudes } = decoded;
  const slots = [];
  const track = [];
  const segments = [];
  let currentSegment = null;

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;

  for (let i = 0; i < pointCount; i += 1) {
    const lat = latitudes[i];
    const lng = longitudes[i];
    const timestampMs = Number.isFinite(firstTimestampMs)
      ? firstTimestampMs + (i * Math.max(1, Number(sampleRateSeconds) || 1) * 1000)
      : 0;

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      slots.push({
        lat: Number.NaN,
        lng: Number.NaN,
        valid: false,
        slotIndex: i,
        timestampMs
      });
      currentSegment = null;
      continue;
    }

    const slot = {
      lat,
      lng,
      valid: true,
      slotIndex: i,
      timestampMs
    };
    slots.push(slot);
    track.push([lat, lng]);
    if (!currentSegment) {
      currentSegment = [];
      segments.push(currentSegment);
    }
    currentSegment.push([lat, lng]);
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }

  return {
    validGps: track.length > 1,
    slotCount: slots.length,
    pointCount: track.length,
    sampleRate: sampleRateSeconds,
    bbox: track.length > 0 ? { minLat, maxLat, minLng, maxLng } : null,
    firstTimestampMs,
    slots,
    segments,
    track
  };
}

export function decodeWoa1BufferLight(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const header = inspectWoa1Header(bytes);
  const {
    majorVersion,
    minorVersion,
    metaLength,
    sessionLength,
    workoutStreamLength,
    gpsTrackLength,
    headerLength
  } = header;

  if (majorVersion < 2) {
    throw new Error(`Unsupported WOA version ${majorVersion}; version 2 or newer is required`);
  }

  let offset = headerLength;
  const meta = readJsonBlock(bytes, offset, metaLength);
  const intensity = readWorkoutIntensityHeader(bytes);
  if (meta?.persistedRow && typeof meta.persistedRow === "object") {
    meta.persistedRow.intensity_profile = intensity.profile;
    meta.persistedRow.intensity_tags = intensity.tags;
    meta.persistedRow.intensity_structure = intensity.structure;
    meta.persistedRow.intensity_dose = intensity.dose;
    meta.persistedRow.intensity_classifier_version = intensity.classifierVersion;
  }
  offset += metaLength + sessionLength;
  const workoutStreamStoredBytes = bytes.slice(offset, offset + workoutStreamLength);
  offset += workoutStreamLength;
  const gpsTrackStoredBytes = bytes.slice(offset, offset + gpsTrackLength);
  offset += gpsTrackLength;
  const intensityModelFeatureBytes = bytes.byteLength - offset === INTENSITY_MODEL_FEATURE_BYTES
    && decodeWorkoutIntensityModelFeatures(bytes.subarray(offset))
    ? bytes.slice(offset)
    : null;
  if (meta?.persistedRow) {
    meta.persistedRow.intensity_model_features = intensityModelFeatureBytes;
  }

  return {
    meta,
    majorVersion,
    minorVersion,
    workoutStreamStoredBytes,
    gpsTrackStoredBytes
  };
}
