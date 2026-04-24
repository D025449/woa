const FIT_EPOCH_MS = Date.UTC(1989, 11, 31, 0, 0, 0);

const FIT_BASE_TYPES = {
  enum: 0x00,
  uint8: 0x02,
  uint16: 0x84,
  uint32: 0x86,
  sint32: 0x85
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

function crc16Fit(buffer, seed = 0) {
  let crc = seed & 0xffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let j = 0; j < 8; j += 1) {
      if ((crc & 1) !== 0) {
        crc = (crc >> 1) ^ 0xa001;
      } else {
        crc >>= 1;
      }
    }
  }
  return crc & 0xffff;
}

class FitMessageBuilder {
  constructor() {
    this.parts = [];
    this.definitionKeys = new Set();
  }

  pushBytes(bytes) {
    this.parts.push(Buffer.from(bytes));
  }

  pushBuffer(buf) {
    this.parts.push(buf);
  }

  ensureDefinition(localId, globalId, fields) {
    const key = `${localId}:${globalId}:${fields.map((f) => `${f.num}/${f.size}/${f.type}`).join(",")}`;
    if (this.definitionKeys.has(key)) {
      return;
    }

    const size = 1 + 1 + 1 + 2 + 1 + (fields.length * 3);
    const def = Buffer.alloc(size);
    let offset = 0;
    def.writeUInt8(0x40 | (localId & 0x0f), offset); offset += 1; // definition header
    def.writeUInt8(0, offset); offset += 1; // reserved
    def.writeUInt8(0, offset); offset += 1; // little-endian architecture
    def.writeUInt16LE(globalId, offset); offset += 2;
    def.writeUInt8(fields.length, offset); offset += 1;

    for (const field of fields) {
      def.writeUInt8(field.num, offset); offset += 1;
      def.writeUInt8(field.size, offset); offset += 1;
      def.writeUInt8(field.type, offset); offset += 1;
    }

    this.pushBuffer(def);
    this.definitionKeys.add(key);
  }

  writeDataMessage(localId, fields, values) {
    const messageSize = 1 + fields.reduce((acc, f) => acc + f.size, 0);
    const row = Buffer.alloc(messageSize);
    let offset = 0;
    row.writeUInt8(localId & 0x0f, offset); offset += 1;

    for (const field of fields) {
      const value = values[field.num];
      switch (field.type) {
        case FIT_BASE_TYPES.enum:
        case FIT_BASE_TYPES.uint8: {
          row.writeUInt8(value ?? 0xff, offset);
          offset += 1;
          break;
        }
        case FIT_BASE_TYPES.uint16: {
          row.writeUInt16LE(value ?? 0xffff, offset);
          offset += 2;
          break;
        }
        case FIT_BASE_TYPES.uint32: {
          row.writeUInt32LE(value ?? 0xffffffff, offset);
          offset += 4;
          break;
        }
        case FIT_BASE_TYPES.sint32: {
          row.writeInt32LE(value ?? 0x7fffffff, offset);
          offset += 4;
          break;
        }
        default:
          throw new Error(`Unsupported FIT base type: ${field.type}`);
      }
    }

    this.pushBuffer(row);
  }

  toBuffer() {
    return Buffer.concat(this.parts);
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
  let speedSum = 0;
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

    speedSum += r.speedMps || 0;
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
    avgSpeed: speedSum / count,
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

function normalizeRecords(workout, options = {}) {
  const records = [];
  const length = workout.length || 0;
  const startMs = Number(workout.getStartTime?.() || Date.now());
  const gpsCoordinates = Array.isArray(options.gpsCoordinates) ? options.gpsCoordinates : [];
  const includeGps = options.includeGps !== false;
  const sampleRateGpsRaw = Number(options.sampleRateGps);
  const sampleRateGps = Number.isFinite(sampleRateGpsRaw) && sampleRateGpsRaw > 0
    ? Math.max(1, Math.round(sampleRateGpsRaw))
    : 1;
  let distanceM = 0;

  for (let i = 0; i < length; i += 1) {
    const speedMps = Number(workout.getSpeedAt(i) || 0);
    if (i > 0) {
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
    const records = normalizeRecords(workout, {
      gpsCoordinates: options.gpsCoordinates,
      sampleRateGps: options.sampleRateGps,
      includeGps: options.includeGps
    });
    const firstTs = fitTimestampFromMs(records[0].timestampMs);
    const lastTs = fitTimestampFromMs(records[records.length - 1].timestampMs);
    const totalSeconds = Math.max(0, records.length - 1);
    const summary = summarizeRecords(records);

    const msg = new FitMessageBuilder();

    const FILE_ID_FIELDS = [
      { num: 0, size: 1, type: FIT_BASE_TYPES.enum },   // type
      { num: 1, size: 2, type: FIT_BASE_TYPES.uint16 }, // manufacturer
      { num: 2, size: 2, type: FIT_BASE_TYPES.uint16 }, // product
      { num: 3, size: 4, type: FIT_BASE_TYPES.uint32 }, // serial_number
      { num: 4, size: 4, type: FIT_BASE_TYPES.uint32 }  // time_created
    ];

    const RECORD_FIELDS = [
      { num: 0, size: 4, type: FIT_BASE_TYPES.sint32 },   // position_lat (semicircles)
      { num: 1, size: 4, type: FIT_BASE_TYPES.sint32 },   // position_long (semicircles)
      { num: 2, size: 2, type: FIT_BASE_TYPES.uint16 },   // altitude
      { num: 3, size: 1, type: FIT_BASE_TYPES.uint8 },    // heart_rate
      { num: 4, size: 1, type: FIT_BASE_TYPES.uint8 },    // cadence
      { num: 5, size: 4, type: FIT_BASE_TYPES.uint32 },   // distance
      { num: 6, size: 2, type: FIT_BASE_TYPES.uint16 },   // speed
      { num: 7, size: 2, type: FIT_BASE_TYPES.uint16 },   // power
      { num: 253, size: 4, type: FIT_BASE_TYPES.uint32 }  // timestamp
    ];

    const LAP_FIELDS = [
      { num: 2, size: 4, type: FIT_BASE_TYPES.uint32 },   // start_time
      { num: 7, size: 4, type: FIT_BASE_TYPES.uint32 },   // total_elapsed_time
      { num: 8, size: 4, type: FIT_BASE_TYPES.uint32 },   // total_timer_time
      { num: 9, size: 4, type: FIT_BASE_TYPES.uint32 },   // total_distance
      { num: 13, size: 2, type: FIT_BASE_TYPES.uint16 },  // avg_speed
      { num: 14, size: 2, type: FIT_BASE_TYPES.uint16 },  // max_speed
      { num: 15, size: 1, type: FIT_BASE_TYPES.uint8 },   // avg_hr
      { num: 16, size: 1, type: FIT_BASE_TYPES.uint8 },   // max_hr
      { num: 17, size: 1, type: FIT_BASE_TYPES.uint8 },   // avg_cadence
      { num: 18, size: 1, type: FIT_BASE_TYPES.uint8 },   // max_cadence
      { num: 19, size: 2, type: FIT_BASE_TYPES.uint16 },  // avg_power
      { num: 20, size: 2, type: FIT_BASE_TYPES.uint16 },  // max_power
      { num: 21, size: 2, type: FIT_BASE_TYPES.uint16 },  // total_ascent
      { num: 22, size: 2, type: FIT_BASE_TYPES.uint16 },  // total_descent
      { num: 253, size: 4, type: FIT_BASE_TYPES.uint32 }  // timestamp
    ];

    const SESSION_FIELDS = [
      ...LAP_FIELDS,
      { num: 5, size: 1, type: FIT_BASE_TYPES.enum }      // sport
    ];

    const ACTIVITY_FIELDS = [
      { num: 0, size: 4, type: FIT_BASE_TYPES.uint32 },   // total_timer_time
      { num: 1, size: 2, type: FIT_BASE_TYPES.uint16 },   // num_sessions
      { num: 2, size: 1, type: FIT_BASE_TYPES.enum },     // type
      { num: 253, size: 4, type: FIT_BASE_TYPES.uint32 }  // timestamp
    ];

    msg.ensureDefinition(0, 0, FILE_ID_FIELDS);
    msg.writeDataMessage(0, FILE_ID_FIELDS, {
      0: 4, // activity file
      1: 1, // Garmin
      2: 0,
      3: clamp(serialNumber, 0, 0xffffffff),
      4: firstTs
    });

    msg.ensureDefinition(1, 20, RECORD_FIELDS);
    for (const record of records) {
      msg.writeDataMessage(1, RECORD_FIELDS, {
        0: Number.isFinite(record.lat) ? toSemicircles(record.lat) : 0x7fffffff,
        1: Number.isFinite(record.lon) ? toSemicircles(record.lon) : 0x7fffffff,
        2: fitAltitudeValue(record.altitudeM),
        3: clamp(Math.round(record.heartRate), 0, 0xff),
        4: clamp(Math.round(record.cadence), 0, 0xff),
        5: fitDistanceValue(record.distanceM),
        6: fitSpeedValue(record.speedMps),
        7: clamp(Math.round(record.power), 0, 0xffff),
        253: fitTimestampFromMs(record.timestampMs)
      });
    }

    msg.ensureDefinition(2, 19, LAP_FIELDS);
    msg.writeDataMessage(2, LAP_FIELDS, {
      2: firstTs,
      7: fitDurationValue(totalSeconds),
      8: fitDurationValue(totalSeconds),
      9: fitDistanceValue(summary.totalDistanceM),
      13: fitSpeedValue(summary.avgSpeed),
      14: fitSpeedValue(summary.maxSpeed),
      15: clamp(Math.round(summary.avgHr), 0, 0xff),
      16: clamp(Math.round(summary.maxHr), 0, 0xff),
      17: clamp(Math.round(summary.avgCad), 0, 0xff),
      18: clamp(Math.round(summary.maxCad), 0, 0xff),
      19: clamp(Math.round(summary.avgPower), 0, 0xffff),
      20: clamp(Math.round(summary.maxPower), 0, 0xffff),
      21: clamp(Math.round(summary.totalAscentM), 0, 0xffff),
      22: clamp(Math.round(summary.totalDescentM), 0, 0xffff),
      253: lastTs
    });

    msg.ensureDefinition(3, 18, SESSION_FIELDS);
    msg.writeDataMessage(3, SESSION_FIELDS, {
      2: firstTs,
      5: 2, // cycling
      7: fitDurationValue(totalSeconds),
      8: fitDurationValue(totalSeconds),
      9: fitDistanceValue(summary.totalDistanceM),
      13: fitSpeedValue(summary.avgSpeed),
      14: fitSpeedValue(summary.maxSpeed),
      15: clamp(Math.round(summary.avgHr), 0, 0xff),
      16: clamp(Math.round(summary.maxHr), 0, 0xff),
      17: clamp(Math.round(summary.avgCad), 0, 0xff),
      18: clamp(Math.round(summary.maxCad), 0, 0xff),
      19: clamp(Math.round(summary.avgPower), 0, 0xffff),
      20: clamp(Math.round(summary.maxPower), 0, 0xffff),
      21: clamp(Math.round(summary.totalAscentM), 0, 0xffff),
      22: clamp(Math.round(summary.totalDescentM), 0, 0xffff),
      253: lastTs
    });

    msg.ensureDefinition(4, 34, ACTIVITY_FIELDS);
    msg.writeDataMessage(4, ACTIVITY_FIELDS, {
      0: fitDurationValue(totalSeconds),
      1: 1,
      2: 0, // manual
      253: lastTs
    });

    const data = msg.toBuffer();

    const header = Buffer.alloc(14);
    header.writeUInt8(14, 0);           // header size
    header.writeUInt8(0x20, 1);         // protocol version
    header.writeUInt16LE(2200, 2);      // profile version
    header.writeUInt32LE(data.length, 4);
    header.write(".FIT", 8, 4, "ascii");
    header.writeUInt16LE(crc16Fit(header.subarray(0, 12)), 12);

    const fullWithoutCrc = Buffer.concat([header, data]);
    const fileCrc = crc16Fit(fullWithoutCrc.subarray(14));
    const crc = Buffer.alloc(2);
    crc.writeUInt16LE(fileCrc, 0);

    return Buffer.concat([fullWithoutCrc, crc]);
  }
}

export {
  fitTimestampFromMs,
  toSemicircles
};
