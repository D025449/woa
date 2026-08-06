const FIT_EPOCH_MS = Date.UTC(1989, 11, 31, 0, 0, 0);
const TEXT_ENCODER = new TextEncoder();

function monotonicNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function addProfileValue(profile, key, value) {
  if (!profile) return;
  profile[key] = (Number(profile[key]) || 0) + value;
}

class FitBytes extends Uint8Array {
  static alloc(size, fill = 0) {
    const bytes = new FitBytes(size);
    if (fill !== 0) {
      bytes.fill(fill);
    }
    return bytes;
  }

  static from(value, encoding = null) {
    if (typeof value === "string") {
      if (encoding === "ascii") {
        return new FitBytes([...value].map((character) => character.charCodeAt(0) & 0x7f));
      }
      return new FitBytes(TEXT_ENCODER.encode(value));
    }
    if (value instanceof ArrayBuffer) {
      return new FitBytes(value.slice(0));
    }
    if (ArrayBuffer.isView(value)) {
      return new FitBytes(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    }
    return new FitBytes(value || []);
  }

  static concat(parts) {
    const totalLength = parts.reduce((total, part) => total + part.byteLength, 0);
    const bytes = new FitBytes(totalLength);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    return bytes;
  }

  static isBuffer(value) {
    return value instanceof Uint8Array;
  }

  dataView() {
    return new DataView(this.buffer, this.byteOffset, this.byteLength);
  }

  writeUInt8(value, offset) {
    this.dataView().setUint8(offset, value);
  }

  writeInt8(value, offset) {
    this.dataView().setInt8(offset, value);
  }

  writeUInt16LE(value, offset) {
    this.dataView().setUint16(offset, value, true);
  }

  writeUInt32LE(value, offset) {
    this.dataView().setUint32(offset, value, true);
  }

  writeInt32LE(value, offset) {
    this.dataView().setInt32(offset, value, true);
  }

  write(value, offset, length, encoding = "utf8") {
    const bytes = FitBytes.from(value, encoding);
    this.set(bytes.subarray(0, length), offset);
  }

  copy(target, targetOffset = 0, sourceStart = 0, sourceEnd = this.byteLength) {
    target.set(this.subarray(sourceStart, sourceEnd), targetOffset);
  }
}

const FIT_BASE_TYPES = {
  enum: 0x00,
  sint8: 0x01,
  uint8: 0x02,
  string: 0x07,
  byte: 0x0d,
  uint16: 0x84,
  uint32: 0x86,
  uint8z: 0x0a,
  uint16z: 0x8b,
  uint32z: 0x8c,
  sint32: 0x85
};

const FIT_RECORD_SERIES = {
  gps: 1 << 0,
  altitude: 1 << 1,
  heartRate: 1 << 2,
  cadence: 1 << 3,
  distance: 1 << 4,
  speed: 1 << 5,
  power: 1 << 6,
  temperature: 1 << 7,
  leftRightBalance: 1 << 8
};

function fitTimestampFromMs(ms) {
  if (!Number.isFinite(ms)) {
    return 0;
  }
  return Math.max(0, Math.floor((ms - FIT_EPOCH_MS) / 1000));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function toSemicircles(deg) {
  return Math.round((deg * 0x7fffffff) / 180);
}

function fitAltitudeValue(meters) {
  // FIT altitude = (value / 5) - 500, value stored as uint16
  return clamp(Math.round((meters + 500) * 5), 0, 0xffff);
}

function fitSpeedValue(mps) {
  // FIT speed scale = 1000
  return clamp(Math.round(mps * 1000), 0, 0xffff);
}

function fitDistanceValue(meters) {
  // FIT distance scale = 100
  return clamp(Math.round(meters * 100), 0, 0xffffffff);
}

function fitDurationValue(seconds) {
  // FIT elapsed/timer scale = 1000
  return clamp(Math.round(seconds * 1000), 0, 0xffffffff);
}

function finiteOr(value, fallback = null) {
  if (value == null || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function hasPositiveSeries(records, key) {
  return records.some((record) => Number.isFinite(record[key]) && record[key] > 0);
}

function hasMeaningfulAltitudeSeries(records) {
  return records.some((record) => Number.isFinite(record.altitudeM) && Math.abs(record.altitudeM) >= 0.1);
}

function hasMeasuredLeftRightBalanceSeries(records) {
  return records.some((record) => (
    Number.isFinite(record.leftRightBalancePct)
    && record.leftRightBalancePct >= 0
    && record.leftRightBalancePct <= 100
    && record.leftRightBalancePct !== 50
  ));
}

function resolveCyclingSubSport(workoutType) {
  switch (String(workoutType || "").trim().toLowerCase()) {
    case "indoor": return 6;
    case "road": return 7;
    case "mountain": return 8;
    default: return 0;
  }
}

function normalizeFitDeviceMetadata(value, fallbackSerialNumber, fallbackTimestamp) {
  const metadata = value && typeof value === "object" ? value : {};
  const sourceFileId = metadata.fileId && typeof metadata.fileId === "object" ? metadata.fileId : {};
  const fileId = {
    type: finiteOr(sourceFileId.type, 4),
    manufacturer: finiteOr(sourceFileId.manufacturer, 1),
    product: finiteOr(sourceFileId.product, 0),
    serialNumber: finiteOr(sourceFileId.serialNumber, fallbackSerialNumber),
    timeCreated: sourceFileId.timeCreated || fallbackTimestamp,
    number: finiteOr(sourceFileId.number),
    productName: typeof sourceFileId.productName === "string" ? sourceFileId.productName : null
  };
  const devices = (Array.isArray(metadata.devices) ? metadata.devices : [])
    .filter((device) => device && typeof device === "object")
    .map((device) => ({
      timestamp: device.timestamp || null,
      deviceIndex: finiteOr(device.deviceIndex),
      deviceType: finiteOr(device.deviceType),
      manufacturer: finiteOr(device.manufacturer),
      serialNumber: finiteOr(device.serialNumber),
      product: finiteOr(device.product),
      softwareVersion: finiteOr(device.softwareVersion),
      hardwareVersion: finiteOr(device.hardwareVersion),
      cumulativeOperatingTime: finiteOr(device.cumulativeOperatingTime),
      batteryVoltage: finiteOr(device.batteryVoltage),
      batteryStatus: finiteOr(device.batteryStatus),
      batteryLevel: finiteOr(device.batteryLevel),
      sensorPosition: finiteOr(device.sensorPosition),
      descriptor: typeof device.descriptor === "string" ? device.descriptor : null,
      antTransmissionType: finiteOr(device.antTransmissionType),
      antDeviceNumber: finiteOr(device.antDeviceNumber),
      antNetwork: finiteOr(device.antNetwork),
      antId: finiteOr(device.antId),
      sourceType: finiteOr(device.sourceType),
      productName: typeof device.productName === "string" ? device.productName : null
    }));
  return { fileId, devices };
}

const FIT_CRC_TABLE = new Uint16Array(256);
for (let value = 0; value < FIT_CRC_TABLE.length; value += 1) {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) !== 0 ? (crc >> 1) ^ 0xa001 : crc >> 1;
  }
  FIT_CRC_TABLE[value] = crc;
}

function crc16Fit(buffer, seed = 0) {
  let crc = seed & 0xffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = (crc >> 8) ^ FIT_CRC_TABLE[(crc ^ buffer[i]) & 0xff];
  }
  return crc & 0xffff;
}

class GrowableFitWriter {
  constructor(initialCapacity = 64 * 1024) {
    this.bytes = new FitBytes(Math.max(256, initialCapacity));
    this.view = new DataView(this.bytes.buffer);
    this.length = 0;
  }

  ensureCapacity(additionalBytes) {
    const requiredLength = this.length + additionalBytes;
    if (requiredLength <= this.bytes.length) return;

    let capacity = this.bytes.length;
    while (capacity < requiredLength) capacity *= 2;
    const grown = new FitBytes(capacity);
    grown.set(this.bytes.subarray(0, this.length));
    this.bytes = grown;
    this.view = new DataView(grown.buffer);
  }

  reserve(size) {
    this.ensureCapacity(size);
    const offset = this.length;
    this.length += size;
    return offset;
  }

  writeUInt8(value) {
    this.ensureCapacity(1);
    this.view.setUint8(this.length, value);
    this.length += 1;
  }

  writeInt8(value) {
    this.ensureCapacity(1);
    this.view.setInt8(this.length, value);
    this.length += 1;
  }

  writeUInt16LE(value) {
    this.ensureCapacity(2);
    this.view.setUint16(this.length, value, true);
    this.length += 2;
  }

  writeUInt32LE(value) {
    this.ensureCapacity(4);
    this.view.setUint32(this.length, value, true);
    this.length += 4;
  }

  writeInt32LE(value) {
    this.ensureCapacity(4);
    this.view.setInt32(this.length, value, true);
    this.length += 4;
  }

  writeBytes(value, size = value.byteLength) {
    const writeLength = Math.min(value.byteLength, size);
    this.ensureCapacity(size);
    this.bytes.set(value.subarray(0, writeLength), this.length);
    if (writeLength < size) this.bytes.fill(0, this.length + writeLength, this.length + size);
    this.length += size;
  }

  setUInt8(offset, value) {
    this.view.setUint8(offset, value);
  }

  setUInt16LE(offset, value) {
    this.view.setUint16(offset, value, true);
  }

  setUInt32LE(offset, value) {
    this.view.setUint32(offset, value, true);
  }

  toBuffer() {
    return new FitBytes(this.bytes.buffer.slice(0, this.length));
  }
}

class FitMessageBuilder {
  constructor() {
    this.writer = new GrowableFitWriter();
    this.writer.reserve(14);
    this.definitionKeys = new Set();
  }

  ensureDefinition(localId, globalId, fields, developerFields = []) {
    const key = `${localId}:${globalId}:${fields.map((f) => `${f.num}/${f.size}/${f.type}`).join(",")}|${developerFields.map((f) => `${f.num}/${f.size}/${f.developerDataIndex}`).join(",")}`;
    if (this.definitionKeys.has(key)) {
      return;
    }

    const hasDeveloperFields = developerFields.length > 0;
    this.writer.writeUInt8(0x40 | (hasDeveloperFields ? 0x20 : 0) | (localId & 0x0f));
    this.writer.writeUInt8(0); // reserved
    this.writer.writeUInt8(0); // little-endian architecture
    this.writer.writeUInt16LE(globalId);
    this.writer.writeUInt8(fields.length);

    for (const field of fields) {
      this.writer.writeUInt8(field.num);
      this.writer.writeUInt8(field.size);
      this.writer.writeUInt8(field.type);
    }

    if (hasDeveloperFields) {
      this.writer.writeUInt8(developerFields.length);
      for (const field of developerFields) {
        this.writer.writeUInt8(field.num);
        this.writer.writeUInt8(field.size);
        this.writer.writeUInt8(field.developerDataIndex);
      }
    }

    this.definitionKeys.add(key);
  }

  writeDataMessage(localId, fields, values, developerFields = []) {
    const allFields = [...fields, ...developerFields];
    this.writer.writeUInt8(localId & 0x0f);

    for (const field of allFields) {
      const valueKey = field.valueKey ?? field.num;
      const value = values[valueKey];
      switch (field.type) {
        case FIT_BASE_TYPES.enum:
        case FIT_BASE_TYPES.uint8: {
          this.writer.writeUInt8(value ?? 0xff);
          break;
        }
        case FIT_BASE_TYPES.uint8z: {
          this.writer.writeUInt8(value ?? 0);
          break;
        }
        case FIT_BASE_TYPES.sint8: {
          this.writer.writeInt8(value ?? 0x7f);
          break;
        }
        case FIT_BASE_TYPES.uint16: {
          this.writer.writeUInt16LE(value ?? 0xffff);
          break;
        }
        case FIT_BASE_TYPES.uint16z: {
          this.writer.writeUInt16LE(value ?? 0);
          break;
        }
        case FIT_BASE_TYPES.uint32: {
          this.writer.writeUInt32LE(value ?? 0xffffffff);
          break;
        }
        case FIT_BASE_TYPES.uint32z: {
          this.writer.writeUInt32LE(value ?? 0);
          break;
        }
        case FIT_BASE_TYPES.sint32: {
          this.writer.writeInt32LE(value ?? 0x7fffffff);
          break;
        }
        case FIT_BASE_TYPES.string: {
          const raw = typeof value === "string" ? FitBytes.from(value, "utf8") : FitBytes.alloc(0);
          const contentSize = Math.max(0, field.size - 1);
          this.writer.writeBytes(raw.subarray(0, contentSize), contentSize);
          if (field.size > 0) this.writer.writeUInt8(0);
          break;
        }
        case FIT_BASE_TYPES.byte: {
          const raw = FitBytes.isBuffer(value)
            ? value
            : Array.isArray(value)
              ? FitBytes.from(value)
              : FitBytes.alloc(0);
          this.writer.writeBytes(raw, field.size);
          break;
        }
        default:
          throw new Error(`Unsupported FIT base type: ${field.type}`);
      }
    }
  }

  writeRecordMessage(localId, seriesMask, record) {
    this.writer.writeUInt8(localId & 0x0f);
    if ((seriesMask & FIT_RECORD_SERIES.gps) !== 0) {
      this.writer.writeInt32LE(Number.isFinite(record.lat) ? toSemicircles(record.lat) : 0x7fffffff);
      this.writer.writeInt32LE(Number.isFinite(record.lon) ? toSemicircles(record.lon) : 0x7fffffff);
    }
    if ((seriesMask & FIT_RECORD_SERIES.altitude) !== 0) {
      this.writer.writeUInt16LE(Number.isFinite(record.altitudeM) ? fitAltitudeValue(record.altitudeM) : 0xffff);
    }
    if ((seriesMask & FIT_RECORD_SERIES.heartRate) !== 0) {
      this.writer.writeUInt8(Number.isFinite(record.heartRate) ? clamp(Math.round(record.heartRate), 0, 0xfe) : 0xff);
    }
    if ((seriesMask & FIT_RECORD_SERIES.cadence) !== 0) {
      this.writer.writeUInt8(Number.isFinite(record.cadence) ? clamp(Math.round(record.cadence), 0, 0xfe) : 0xff);
    }
    if ((seriesMask & FIT_RECORD_SERIES.distance) !== 0) {
      this.writer.writeUInt32LE(Number.isFinite(record.distanceM) ? fitDistanceValue(record.distanceM) : 0xffffffff);
    }
    if ((seriesMask & FIT_RECORD_SERIES.speed) !== 0) {
      this.writer.writeUInt16LE(Number.isFinite(record.speedMps) ? fitSpeedValue(record.speedMps) : 0xffff);
    }
    if ((seriesMask & FIT_RECORD_SERIES.power) !== 0) {
      this.writer.writeUInt16LE(Number.isFinite(record.power) ? clamp(Math.round(record.power), 0, 0xfffe) : 0xffff);
    }
    if ((seriesMask & FIT_RECORD_SERIES.temperature) !== 0) {
      this.writer.writeInt8(Number.isFinite(record.temperatureC)
        ? clamp(Math.round(record.temperatureC), -128, 126)
        : 0x7f);
    }
    if ((seriesMask & FIT_RECORD_SERIES.leftRightBalance) !== 0) {
      this.writer.writeUInt8(Number.isFinite(record.leftRightBalancePct)
        ? (0x80 | clamp(Math.round(record.leftRightBalancePct), 0, 100))
        : 0xff);
    }
    this.writer.writeUInt32LE(fitTimestampFromMs(record.timestampMs));
  }

  toFitFile() {
    const dataLength = this.writer.length - 14;
    this.writer.setUInt8(0, 14);
    this.writer.setUInt8(1, 0x20);
    this.writer.setUInt16LE(2, 2200);
    this.writer.setUInt32LE(4, dataLength);
    this.writer.bytes.set([46, 70, 73, 84], 8);
    this.writer.setUInt16LE(12, crc16Fit(this.writer.bytes.subarray(0, 12)));
    this.writer.writeUInt16LE(crc16Fit(this.writer.bytes.subarray(14, this.writer.length)));
    return this.writer.toBuffer();
  }
}

function summarizeRecords(records) {
  let totalDistanceM = 0;
  let maxSpeed = 0;
  let maxPower = 0;
  let maxHr = 0;
  let maxCad = 0;
  let asc = 0;
  let desc = 0;
  let powerSum = 0;
  let hrSum = 0;
  let cadSum = 0;
  let prevAlt = null;

  for (const r of records) {
    totalDistanceM = Number.isFinite(r.distanceM) ? r.distanceM : totalDistanceM;
    maxSpeed = Math.max(maxSpeed, r.speedMps || 0);
    maxPower = Math.max(maxPower, r.power || 0);
    maxHr = Math.max(maxHr, r.heartRate || 0);
    maxCad = Math.max(maxCad, r.cadence || 0);

    powerSum += r.power || 0;
    hrSum += r.heartRate || 0;
    cadSum += r.cadence || 0;

    if (Number.isFinite(r.altitudeM) && Number.isFinite(prevAlt)) {
      const delta = r.altitudeM - prevAlt;
      if (delta > 0) {
        asc += delta;
      } else {
        desc += Math.abs(delta);
      }
    }

    if (Number.isFinite(r.altitudeM)) {
      prevAlt = r.altitudeM;
    }
  }

  const count = Math.max(1, records.length);
  return {
    totalDistanceM,
    maxSpeed,
    maxPower,
    avgPower: powerSum / count,
    maxHr,
    avgHr: hrSum / count,
    maxCad,
    avgCad: cadSum / count,
    totalAscentM: asc,
    totalDescentM: desc
  };
}

function normalizeManualLapSegments(segments, recordCount) {
  const maximumOffset = Math.max(0, recordCount - 1);
  return (Array.isArray(segments) ? segments : [])
    .filter((segment) => String(segment?.segmenttype || "").toLowerCase() === "manual")
    .map((segment) => {
      const start = clamp(Math.round(Number(segment?.start_offset)), 0, maximumOffset);
      const end = clamp(Math.round(Number(segment?.end_offset)), 0, maximumOffset);
      return { start: Math.min(start, end), end: Math.max(start, end) };
    })
    .filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
}

function summarizeRecordRange(records, start, end) {
  let maxSpeed = 0;
  let maxPower = 0;
  let maxHr = 0;
  let maxCad = 0;
  let powerSum = 0;
  let hrSum = 0;
  let cadSum = 0;
  let ascent = 0;
  let descent = 0;
  let previousAltitude = null;

  for (let index = start; index < end; index += 1) {
    const record = records[index];
    maxSpeed = Math.max(maxSpeed, record.speedMps || 0);
    maxPower = Math.max(maxPower, record.power || 0);
    maxHr = Math.max(maxHr, record.heartRate || 0);
    maxCad = Math.max(maxCad, record.cadence || 0);
    powerSum += record.power || 0;
    hrSum += record.heartRate || 0;
    cadSum += record.cadence || 0;

    if (Number.isFinite(record.altitudeM) && Number.isFinite(previousAltitude)) {
      const delta = record.altitudeM - previousAltitude;
      if (delta > 0) ascent += delta;
      else descent += Math.abs(delta);
    }
    if (Number.isFinite(record.altitudeM)) previousAltitude = record.altitudeM;
  }

  const intervalCount = Math.max(1, end - start);
  const startDistance = Number(records[start]?.distanceM);
  const endDistance = Number(records[end]?.distanceM);
  const totalDistanceM = Number.isFinite(startDistance) && Number.isFinite(endDistance)
    ? Math.max(0, endDistance - startDistance)
    : 0;

  return {
    durationSeconds: end - start,
    totalDistanceM,
    avgSpeed: end > start ? totalDistanceM / (end - start) : 0,
    maxSpeed,
    avgPower: powerSum / intervalCount,
    maxPower,
    avgHr: hrSum / intervalCount,
    maxHr,
    avgCad: cadSum / intervalCount,
    maxCad,
    totalAscentM: ascent,
    totalDescentM: descent
  };
}

function normalizeRecords(workout, options = {}) {
  const records = [];
  let length = workout.length || 0;
  const startMs = Number(workout.getStartTime?.() || Date.now());
  const gpsCoordinates = Array.isArray(options.gpsCoordinates) ? options.gpsCoordinates : [];
  const includeGps = options.includeGps !== false;
  const sampleRateGpsRaw = Number(options.sampleRateGps);
  const sampleRateGps = Number.isFinite(sampleRateGpsRaw) && sampleRateGpsRaw > 0
    ? Math.max(1, Math.round(sampleRateGpsRaw))
    : 1;
  let distanceM = 0;
  const hasDistanceSeries = typeof workout.hasDistanceSeries === "function" && workout.hasDistanceSeries();

  while (length > 1) {
    const finalIndex = length - 1;
    const previousIndex = finalIndex - 1;
    const finalSpeed = Number(workout.getSpeedAt(finalIndex));
    const previousAltitude = Number(workout.getAltitudeAt(previousIndex));
    const finalAltitude = Number(workout.getAltitudeAt(finalIndex));
    const previousDistance = hasDistanceSeries ? Number(workout.getDistanceAt(previousIndex)) : Number.NaN;
    const finalDistance = hasDistanceSeries ? Number(workout.getDistanceAt(finalIndex)) : Number.NaN;
    const distanceJump = finalDistance - previousDistance;
    const impossibleSignalCount = [
      finalSpeed > 300,
      distanceJump > 300,
      Math.abs(finalAltitude - previousAltitude) > 500,
      Number(workout.getPowerAt(finalIndex)) > 5000,
    ].filter(Boolean).length;

    if (impossibleSignalCount < 2) break;
    length -= 1;
  }

  for (let i = 0; i < length; i += 1) {
    const speedKmh = Number(workout.getSpeedAt(i) || 0);
    const speedMps = speedKmh / 3.6;
    if (hasDistanceSeries && typeof workout.getDistanceAt === "function") {
      distanceM = Number(workout.getDistanceAt(i) || 0);
    } else if (i > 0) {
      distanceM += Math.max(0, speedMps);
    }

    let lat = null;
    let lon = null;
    if (includeGps && gpsCoordinates.length > 0) {
      const lowerIndex = Math.floor(i / sampleRateGps);
      const upperIndex = Math.ceil(i / sampleRateGps);
      const clampedLower = Math.max(0, Math.min(gpsCoordinates.length - 1, lowerIndex));
      const clampedUpper = Math.max(0, Math.min(gpsCoordinates.length - 1, upperIndex));
      const lowerPoint = gpsCoordinates[clampedLower];
      const upperPoint = gpsCoordinates[clampedUpper];

      const lowerLat = Array.isArray(lowerPoint) && Number.isFinite(lowerPoint[0]) ? Number(lowerPoint[0]) : null;
      const lowerLon = Array.isArray(lowerPoint) && Number.isFinite(lowerPoint[1]) ? Number(lowerPoint[1]) : null;
      const upperLat = Array.isArray(upperPoint) && Number.isFinite(upperPoint[0]) ? Number(upperPoint[0]) : null;
      const upperLon = Array.isArray(upperPoint) && Number.isFinite(upperPoint[1]) ? Number(upperPoint[1]) : null;

      if (
        Number.isFinite(lowerLat) &&
        Number.isFinite(lowerLon) &&
        Number.isFinite(upperLat) &&
        Number.isFinite(upperLon)
      ) {
        if (clampedUpper === clampedLower || sampleRateGps <= 1) {
          lat = lowerLat;
          lon = lowerLon;
        } else {
          const t = (i % sampleRateGps) / sampleRateGps;
          lat = lowerLat + ((upperLat - lowerLat) * t);
          lon = lowerLon + ((upperLon - lowerLon) * t);
        }
      } else if (Number.isFinite(lowerLat) && Number.isFinite(lowerLon)) {
        lat = lowerLat;
        lon = lowerLon;
      } else if (Number.isFinite(upperLat) && Number.isFinite(upperLon)) {
        lat = upperLat;
        lon = upperLon;
      }
    }

    records.push({
      timestampMs: startMs + (i * 1000),
      power: Number(workout.getPowerAt(i) || 0),
      heartRate: Number(workout.getHrAt(i) || 0),
      cadence: Number(workout.getCadenceAt(i) || 0),
      speedMps,
      distanceM,
      altitudeM: Number(workout.getAltitudeAt(i) || 0),
      temperatureC: typeof workout.getTemperatureAt === "function"
        ? Number(workout.getTemperatureAt(i))
        : Number.NaN,
      leftRightBalancePct: typeof workout.getLeftRightBalanceAt === "function"
        ? Number(workout.getLeftRightBalanceAt(i))
        : Number.NaN,
      lat,
      lon
    });
  }

  return records;
}

export default class FitExportService {
  static buildFitFromWorkout(workout, options = {}) {
    if (!workout || !Number.isFinite(workout.length) || workout.length <= 0) {
      throw new Error("Cannot export FIT: workout has no records.");
    }

    const serialNumber = Number(options.serialNumber || 1);
    const profile = options.profile && typeof options.profile === "object" ? options.profile : null;
    const totalStartedAt = monotonicNow();
    let phaseStartedAt = totalStartedAt;
    const records = normalizeRecords(workout, {
      gpsCoordinates: options.gpsCoordinates,
      sampleRateGps: options.sampleRateGps,
      includeGps: options.includeGps
    });
    addProfileValue(profile, "normalizeRecordsMs", monotonicNow() - phaseStartedAt);
    addProfileValue(profile, "recordCount", records.length);
    phaseStartedAt = monotonicNow();
    const firstTs = fitTimestampFromMs(records[0].timestampMs);
    const lastTs = fitTimestampFromMs(records[records.length - 1].timestampMs);
    const totalSeconds = Math.max(0, records.length - 1);
    const summary = summarizeRecords(records);
    const manualLapSegments = normalizeManualLapSegments(options.segments, records.length);
    const fitDeviceMetadata = normalizeFitDeviceMetadata(
      options.fitDeviceMetadata,
      serialNumber,
      records[0].timestampMs
    );
    const hasFitDeviceMetadata = !!(
      options.fitDeviceMetadata?.fileId
      || (Array.isArray(options.fitDeviceMetadata?.devices) && options.fitDeviceMetadata.devices.length > 0)
    );
    const hasGpsSeries = records.some((record) => Number.isFinite(record.lat) && Number.isFinite(record.lon));
    const hasDistanceSeries = (
      (typeof workout.hasDistanceSeries === "function" && workout.hasDistanceSeries())
      || hasPositiveSeries(records, "speedMps")
    );
    const hasSpeedSeries = hasPositiveSeries(records, "speedMps");
    const hasPowerSeries = hasPositiveSeries(records, "power");
    const hasHeartRateSeries = hasPositiveSeries(records, "heartRate");
    const hasCadenceSeries = hasPositiveSeries(records, "cadence");
    const hasAltitudeSeries = hasMeaningfulAltitudeSeries(records);
    const hasTemperatureSeries = records.some((record) => Number.isFinite(record.temperatureC));
    const hasLeftRightBalanceSeries = hasMeasuredLeftRightBalanceSeries(records);
    const normalizedPower = finiteOr(options.normalizedPower, workout.getNormalizedPower?.());
    const totalCalories = finiteOr(options.totalCalories);
    const subSport = resolveCyclingSubSport(options.workoutType);
    const avgSpeedFromDistance = totalSeconds > 0
      ? (summary.totalDistanceM / totalSeconds)
      : 0;

    const msg = new FitMessageBuilder();
    const developerFieldEnabled = options.gpsSource === "manual_lookup";
    const applicationId = FitBytes.alloc(16, 0);
    FitBytes.from("woa-manual-gps", "utf8").copy(applicationId, 0, 0, 16);

    const FILE_ID_FIELDS = [
      { num: 0, size: 1, type: FIT_BASE_TYPES.enum },   // type
      { num: 1, size: 2, type: FIT_BASE_TYPES.uint16 }, // manufacturer
      { num: 2, size: 2, type: FIT_BASE_TYPES.uint16 }, // product
      { num: 3, size: 4, type: hasFitDeviceMetadata ? FIT_BASE_TYPES.uint32z : FIT_BASE_TYPES.uint32 }, // serial_number
      { num: 4, size: 4, type: FIT_BASE_TYPES.uint32 }, // time_created
      ...(hasFitDeviceMetadata ? [
        { num: 5, size: 2, type: FIT_BASE_TYPES.uint16 }, // number
        { num: 8, size: 32, type: FIT_BASE_TYPES.string } // product_name
      ] : [])
    ];

    const RECORD_FIELDS = [
      ...(hasGpsSeries ? [
        { num: 0, size: 4, type: FIT_BASE_TYPES.sint32 },  // position_lat (semicircles)
        { num: 1, size: 4, type: FIT_BASE_TYPES.sint32 }   // position_long (semicircles)
      ] : []),
      ...(hasAltitudeSeries ? [
        { num: 2, size: 2, type: FIT_BASE_TYPES.uint16 }   // altitude
      ] : []),
      ...(hasHeartRateSeries ? [
        { num: 3, size: 1, type: FIT_BASE_TYPES.uint8 }    // heart_rate
      ] : []),
      ...(hasCadenceSeries ? [
        { num: 4, size: 1, type: FIT_BASE_TYPES.uint8 }    // cadence
      ] : []),
      ...(hasDistanceSeries ? [
        { num: 5, size: 4, type: FIT_BASE_TYPES.uint32 }   // distance
      ] : []),
      ...(hasSpeedSeries ? [
        { num: 6, size: 2, type: FIT_BASE_TYPES.uint16 }   // speed
      ] : []),
      ...(hasPowerSeries ? [
        { num: 7, size: 2, type: FIT_BASE_TYPES.uint16 }   // power
      ] : []),
      ...(hasTemperatureSeries ? [
        { num: 13, size: 1, type: FIT_BASE_TYPES.sint8 }   // temperature
      ] : []),
      ...(hasLeftRightBalanceSeries ? [
        { num: 30, size: 1, type: FIT_BASE_TYPES.uint8 }   // left_right_balance
      ] : []),
      { num: 253, size: 4, type: FIT_BASE_TYPES.uint32 }  // timestamp
    ];
    const recordSeriesMask = (hasGpsSeries ? FIT_RECORD_SERIES.gps : 0)
      | (hasAltitudeSeries ? FIT_RECORD_SERIES.altitude : 0)
      | (hasHeartRateSeries ? FIT_RECORD_SERIES.heartRate : 0)
      | (hasCadenceSeries ? FIT_RECORD_SERIES.cadence : 0)
      | (hasDistanceSeries ? FIT_RECORD_SERIES.distance : 0)
      | (hasSpeedSeries ? FIT_RECORD_SERIES.speed : 0)
      | (hasPowerSeries ? FIT_RECORD_SERIES.power : 0)
      | (hasTemperatureSeries ? FIT_RECORD_SERIES.temperature : 0)
      | (hasLeftRightBalanceSeries ? FIT_RECORD_SERIES.leftRightBalance : 0);

    const DEVICE_INFO_FIELDS = [
      { num: 0, size: 1, type: FIT_BASE_TYPES.uint8 },    // device_index
      { num: 1, size: 1, type: FIT_BASE_TYPES.uint8 },    // device_type
      { num: 2, size: 2, type: FIT_BASE_TYPES.uint16 },   // manufacturer
      { num: 3, size: 4, type: FIT_BASE_TYPES.uint32z },  // serial_number
      { num: 4, size: 2, type: FIT_BASE_TYPES.uint16 },   // product
      { num: 5, size: 2, type: FIT_BASE_TYPES.uint16 },   // software_version
      { num: 6, size: 1, type: FIT_BASE_TYPES.uint8 },    // hardware_version
      { num: 7, size: 4, type: FIT_BASE_TYPES.uint32 },   // cum_operating_time
      { num: 10, size: 2, type: FIT_BASE_TYPES.uint16 },  // battery_voltage
      { num: 11, size: 1, type: FIT_BASE_TYPES.enum },    // battery_status
      { num: 18, size: 1, type: FIT_BASE_TYPES.enum },    // sensor_position
      { num: 19, size: 32, type: FIT_BASE_TYPES.string }, // descriptor
      { num: 20, size: 1, type: FIT_BASE_TYPES.uint8z },  // ant_transmission_type
      { num: 21, size: 2, type: FIT_BASE_TYPES.uint16z }, // ant_device_number
      { num: 22, size: 1, type: FIT_BASE_TYPES.enum },    // ant_network
      { num: 24, size: 4, type: FIT_BASE_TYPES.uint32z }, // ant_id
      { num: 25, size: 1, type: FIT_BASE_TYPES.enum },    // source_type
      { num: 27, size: 32, type: FIT_BASE_TYPES.string }, // product_name
      { num: 32, size: 1, type: FIT_BASE_TYPES.uint8 },   // battery_level
      { num: 253, size: 4, type: FIT_BASE_TYPES.uint32 }  // timestamp
    ];

    const LAP_FIELDS = [
      { num: 254, size: 2, type: FIT_BASE_TYPES.uint16 }, // message_index
      { num: 2, size: 4, type: FIT_BASE_TYPES.uint32 },   // start_time
      { num: 7, size: 4, type: FIT_BASE_TYPES.uint32 },   // total_elapsed_time
      { num: 8, size: 4, type: FIT_BASE_TYPES.uint32 },   // total_timer_time
      ...(hasDistanceSeries ? [
        { num: 9, size: 4, type: FIT_BASE_TYPES.uint32 }   // total_distance
      ] : []),
      ...(hasSpeedSeries ? [
        { num: 13, size: 2, type: FIT_BASE_TYPES.uint16 }, // avg_speed
        { num: 14, size: 2, type: FIT_BASE_TYPES.uint16 }  // max_speed
      ] : []),
      ...(hasHeartRateSeries ? [
        { num: 15, size: 1, type: FIT_BASE_TYPES.uint8 },  // avg_hr
        { num: 16, size: 1, type: FIT_BASE_TYPES.uint8 }   // max_hr
      ] : []),
      ...(hasCadenceSeries ? [
        { num: 17, size: 1, type: FIT_BASE_TYPES.uint8 },  // avg_cadence
        { num: 18, size: 1, type: FIT_BASE_TYPES.uint8 }   // max_cadence
      ] : []),
      ...(hasPowerSeries ? [
        { num: 19, size: 2, type: FIT_BASE_TYPES.uint16 }, // avg_power
        { num: 20, size: 2, type: FIT_BASE_TYPES.uint16 }  // max_power
      ] : []),
      ...(hasAltitudeSeries ? [
        { num: 21, size: 2, type: FIT_BASE_TYPES.uint16 }, // total_ascent
        { num: 22, size: 2, type: FIT_BASE_TYPES.uint16 }  // total_descent
      ] : []),
      ...(Number.isFinite(totalCalories) && totalCalories > 0 ? [
        { num: 11, size: 2, type: FIT_BASE_TYPES.uint16 }  // total_calories
      ] : []),
      ...(Number.isFinite(normalizedPower) && normalizedPower > 0 ? [
        { num: 33, size: 2, type: FIT_BASE_TYPES.uint16 }  // normalized_power
      ] : []),
      { num: 23, size: 1, type: FIT_BASE_TYPES.enum },    // intensity
      { num: 24, size: 1, type: FIT_BASE_TYPES.enum },    // lap_trigger
      { num: 25, size: 1, type: FIT_BASE_TYPES.enum },    // sport
      { num: 39, size: 1, type: FIT_BASE_TYPES.enum },    // sub_sport
      { num: 253, size: 4, type: FIT_BASE_TYPES.uint32 }  // timestamp
    ];

    const SESSION_FIELDS = [
      { num: 2, size: 4, type: FIT_BASE_TYPES.uint32 },   // start_time
      { num: 5, size: 1, type: FIT_BASE_TYPES.enum },     // sport
      { num: 7, size: 4, type: FIT_BASE_TYPES.uint32 },   // total_elapsed_time
      { num: 8, size: 4, type: FIT_BASE_TYPES.uint32 },   // total_timer_time
      ...(hasDistanceSeries ? [
        { num: 9, size: 4, type: FIT_BASE_TYPES.uint32 }   // total_distance
      ] : []),
      ...(hasSpeedSeries ? [
        { num: 14, size: 2, type: FIT_BASE_TYPES.uint16 }, // avg_speed
        { num: 15, size: 2, type: FIT_BASE_TYPES.uint16 }  // max_speed
      ] : []),
      ...(hasHeartRateSeries ? [
        { num: 16, size: 1, type: FIT_BASE_TYPES.uint8 },  // avg_hr
        { num: 17, size: 1, type: FIT_BASE_TYPES.uint8 }   // max_hr
      ] : []),
      ...(hasCadenceSeries ? [
        { num: 18, size: 1, type: FIT_BASE_TYPES.uint8 },  // avg_cadence
        { num: 19, size: 1, type: FIT_BASE_TYPES.uint8 }   // max_cadence
      ] : []),
      ...(hasPowerSeries ? [
        { num: 20, size: 2, type: FIT_BASE_TYPES.uint16 }, // avg_power
        { num: 21, size: 2, type: FIT_BASE_TYPES.uint16 }  // max_power
      ] : []),
      ...(hasAltitudeSeries ? [
        { num: 22, size: 2, type: FIT_BASE_TYPES.uint16 }, // total_ascent
        { num: 23, size: 2, type: FIT_BASE_TYPES.uint16 }  // total_descent
      ] : []),
      ...(Number.isFinite(totalCalories) && totalCalories > 0 ? [
        { num: 11, size: 2, type: FIT_BASE_TYPES.uint16 }  // total_calories
      ] : []),
      ...(Number.isFinite(normalizedPower) && normalizedPower > 0 ? [
        { num: 34, size: 2, type: FIT_BASE_TYPES.uint16 }  // normalized_power
      ] : []),
      { num: 6, size: 1, type: FIT_BASE_TYPES.enum },     // sub_sport
      { num: 26, size: 2, type: FIT_BASE_TYPES.uint16 },  // num_laps
      { num: 253, size: 4, type: FIT_BASE_TYPES.uint32 }  // timestamp
    ];

    const ACTIVITY_FIELDS = [
      { num: 0, size: 4, type: FIT_BASE_TYPES.uint32 },   // total_timer_time
      { num: 1, size: 2, type: FIT_BASE_TYPES.uint16 },   // num_sessions
      { num: 2, size: 1, type: FIT_BASE_TYPES.enum },     // type
      { num: 253, size: 4, type: FIT_BASE_TYPES.uint32 }  // timestamp
    ];
    const DEVELOPER_DATA_ID_FIELDS = [
      { num: 1, size: 16, type: FIT_BASE_TYPES.byte },    // application_id
      { num: 3, size: 1, type: FIT_BASE_TYPES.uint8 },    // developer_data_index
      { num: 4, size: 1, type: FIT_BASE_TYPES.uint8 }     // application_version
    ];
    const FIELD_DESCRIPTION_FIELDS = [
      { num: 0, size: 1, type: FIT_BASE_TYPES.uint8 },    // developer_data_index
      { num: 1, size: 1, type: FIT_BASE_TYPES.uint8 },    // field_definition_number
      { num: 2, size: 1, type: FIT_BASE_TYPES.uint8 },    // fit_base_type_id
      { num: 3, size: 16, type: FIT_BASE_TYPES.string }   // field_name
    ];
    const SESSION_DEVELOPER_FIELDS = developerFieldEnabled
      ? [
          {
            num: 0,
            size: 1,
            developerDataIndex: 0,
            type: FIT_BASE_TYPES.uint8,
            valueKey: "woa_manual_gps"
          }
        ]
      : [];
    addProfileValue(profile, "analyzeRecordsMs", monotonicNow() - phaseStartedAt);
    phaseStartedAt = monotonicNow();

    msg.ensureDefinition(0, 0, FILE_ID_FIELDS);
    msg.writeDataMessage(0, FILE_ID_FIELDS, {
      0: clamp(fitDeviceMetadata.fileId.type, 0, 0xff),
      1: clamp(fitDeviceMetadata.fileId.manufacturer, 0, 0xffff),
      2: clamp(fitDeviceMetadata.fileId.product, 0, 0xffff),
      3: clamp(fitDeviceMetadata.fileId.serialNumber, 0, 0xffffffff),
      4: fitTimestampFromMs(new Date(fitDeviceMetadata.fileId.timeCreated).getTime()),
      5: fitDeviceMetadata.fileId.number,
      8: fitDeviceMetadata.fileId.productName
    });

    if (fitDeviceMetadata.devices.length > 0) {
      msg.ensureDefinition(7, 23, DEVICE_INFO_FIELDS);
      for (const device of fitDeviceMetadata.devices) {
        msg.writeDataMessage(7, DEVICE_INFO_FIELDS, {
          0: device.deviceIndex,
          1: device.deviceType,
          2: device.manufacturer,
          3: device.serialNumber,
          4: device.product,
          5: Number.isFinite(device.softwareVersion) ? Math.round(device.softwareVersion * 100) : null,
          6: device.hardwareVersion,
          7: device.cumulativeOperatingTime,
          10: Number.isFinite(device.batteryVoltage) ? Math.round(device.batteryVoltage * 256) : null,
          11: device.batteryStatus,
          18: device.sensorPosition,
          19: device.descriptor,
          20: device.antTransmissionType,
          21: device.antDeviceNumber,
          22: device.antNetwork,
          24: device.antId,
          25: device.sourceType,
          27: device.productName,
          32: device.batteryLevel,
          253: device.timestamp ? fitTimestampFromMs(new Date(device.timestamp).getTime()) : firstTs
        });
      }
    }

    if (developerFieldEnabled) {
      msg.ensureDefinition(5, 207, DEVELOPER_DATA_ID_FIELDS);
      msg.writeDataMessage(5, DEVELOPER_DATA_ID_FIELDS, {
        1: applicationId,
        3: 0,
        4: 1
      });

      msg.ensureDefinition(6, 206, FIELD_DESCRIPTION_FIELDS);
      msg.writeDataMessage(6, FIELD_DESCRIPTION_FIELDS, {
        0: 0,
        1: 0,
        2: FIT_BASE_TYPES.uint8,
        3: "woa_manual_gps"
      });
    }

    msg.ensureDefinition(1, 20, RECORD_FIELDS);
    addProfileValue(profile, "writeMetadataMs", monotonicNow() - phaseStartedAt);
    phaseStartedAt = monotonicNow();
    for (const record of records) {
      msg.writeRecordMessage(1, recordSeriesMask, record);
    }
    addProfileValue(profile, "writeRecordsMs", monotonicNow() - phaseStartedAt);
    phaseStartedAt = monotonicNow();

    msg.ensureDefinition(2, 19, LAP_FIELDS);
    for (let lapIndex = 0; lapIndex < manualLapSegments.length; lapIndex += 1) {
      const segment = manualLapSegments[lapIndex];
      const segmentSummary = summarizeRecordRange(records, segment.start, segment.end);
      msg.writeDataMessage(2, LAP_FIELDS, {
        254: lapIndex,
        2: fitTimestampFromMs(records[segment.start].timestampMs),
        7: fitDurationValue(segmentSummary.durationSeconds),
        8: fitDurationValue(segmentSummary.durationSeconds),
        9: fitDistanceValue(segmentSummary.totalDistanceM),
        13: fitSpeedValue(segmentSummary.avgSpeed),
        14: fitSpeedValue(segmentSummary.maxSpeed),
        15: clamp(Math.round(segmentSummary.avgHr), 0, 0xff),
        16: clamp(Math.round(segmentSummary.maxHr), 0, 0xff),
        17: clamp(Math.round(segmentSummary.avgCad), 0, 0xff),
        18: clamp(Math.round(segmentSummary.maxCad), 0, 0xff),
        19: clamp(Math.round(segmentSummary.avgPower), 0, 0xffff),
        20: clamp(Math.round(segmentSummary.maxPower), 0, 0xffff),
        21: clamp(Math.round(segmentSummary.totalAscentM), 0, 0xffff),
        22: clamp(Math.round(segmentSummary.totalDescentM), 0, 0xffff),
        11: null,
        33: null,
        23: 0, // active
        24: 0, // manual
        25: 2, // cycling
        39: subSport,
        253: fitTimestampFromMs(records[segment.end].timestampMs)
      });
    }
    msg.writeDataMessage(2, LAP_FIELDS, {
      254: manualLapSegments.length,
      2: firstTs,
      7: fitDurationValue(totalSeconds),
      8: fitDurationValue(totalSeconds),
      9: fitDistanceValue(summary.totalDistanceM),
      13: fitSpeedValue(avgSpeedFromDistance),
      14: fitSpeedValue(summary.maxSpeed),
      15: clamp(Math.round(summary.avgHr), 0, 0xff),
      16: clamp(Math.round(summary.maxHr), 0, 0xff),
      17: clamp(Math.round(summary.avgCad), 0, 0xff),
      18: clamp(Math.round(summary.maxCad), 0, 0xff),
      19: clamp(Math.round(summary.avgPower), 0, 0xffff),
      20: clamp(Math.round(summary.maxPower), 0, 0xffff),
      21: clamp(Math.round(summary.totalAscentM), 0, 0xffff),
      22: clamp(Math.round(summary.totalDescentM), 0, 0xffff),
      11: Number.isFinite(totalCalories) ? clamp(Math.round(totalCalories), 0, 0xfffe) : null,
      33: Number.isFinite(normalizedPower) ? clamp(Math.round(normalizedPower), 0, 0xfffe) : null,
      23: 0, // active
      24: 7, // session_end
      25: 2, // cycling
      39: subSport,
      253: lastTs
    });

    msg.ensureDefinition(3, 18, SESSION_FIELDS, SESSION_DEVELOPER_FIELDS);
    msg.writeDataMessage(3, SESSION_FIELDS, {
      2: firstTs,
      5: 2, // cycling
      7: fitDurationValue(totalSeconds),
      8: fitDurationValue(totalSeconds),
      9: fitDistanceValue(summary.totalDistanceM),
      14: fitSpeedValue(avgSpeedFromDistance),
      15: fitSpeedValue(summary.maxSpeed),
      16: clamp(Math.round(summary.avgHr), 0, 0xff),
      17: clamp(Math.round(summary.maxHr), 0, 0xff),
      18: clamp(Math.round(summary.avgCad), 0, 0xff),
      19: clamp(Math.round(summary.maxCad), 0, 0xff),
      20: clamp(Math.round(summary.avgPower), 0, 0xffff),
      21: clamp(Math.round(summary.maxPower), 0, 0xffff),
      22: clamp(Math.round(summary.totalAscentM), 0, 0xffff),
      23: clamp(Math.round(summary.totalDescentM), 0, 0xffff),
      11: Number.isFinite(totalCalories) ? clamp(Math.round(totalCalories), 0, 0xfffe) : null,
      34: Number.isFinite(normalizedPower) ? clamp(Math.round(normalizedPower), 0, 0xfffe) : null,
      6: subSport,
      26: manualLapSegments.length + 1,
      253: lastTs,
      woa_manual_gps: developerFieldEnabled ? 1 : 0
    }, SESSION_DEVELOPER_FIELDS);

    msg.ensureDefinition(4, 34, ACTIVITY_FIELDS);
    msg.writeDataMessage(4, ACTIVITY_FIELDS, {
      0: fitDurationValue(totalSeconds),
      1: 1,
      2: 0, // manual
      253: lastTs
    });

    addProfileValue(profile, "writeSummariesMs", monotonicNow() - phaseStartedAt);
    phaseStartedAt = monotonicNow();
    const result = msg.toFitFile();
    addProfileValue(profile, "finalizeMs", monotonicNow() - phaseStartedAt);
    addProfileValue(profile, "totalMs", monotonicNow() - totalStartedAt);
    return result;
  }
}

export {
  fitTimestampFromMs,
  toSemicircles
};
