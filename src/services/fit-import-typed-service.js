import { FIT } from "../../vendor/fit-file-parser-fast/dist/fit.js";

const GARMIN_TIME_OFFSET_MS = 631065600000;
const COMPRESSED_HEADER_MASK = 0x80;
const COMPRESSED_LOCAL_MSG_NUM_MASK = 0x60;
const SEMICIRCLES_TO_DEGREES = 180 / 0x80000000;

const SESSION_FIELDS = new Set([
  "timestamp",
  "start_time",
  "total_elapsed_time",
  "total_timer_time",
  "total_distance",
  "total_cycles",
  "total_work",
  "total_calories",
  "total_ascent",
  "total_descent",
  "avg_speed",
  "avg_power",
  "avg_heart_rate",
  "avg_cadence",
  "normalized_power",
  "max_speed",
  "max_power",
  "max_heart_rate",
  "max_cadence",
  "nec_lat",
  "nec_long",
  "swc_lat",
  "swc_long",
  "woa_manual_gps"
]);

const RECORD_FIELDS = new Set([
  "timestamp",
  "distance",
  "power",
  "heart_rate",
  "cadence",
  "speed",
  "enhanced_speed",
  "altitude",
  "enhanced_altitude",
  "position_lat",
  "position_long"
]);

class GrowableFloat64Array {
  constructor(initialCapacity = 1024) {
    this.buffer = new Float64Array(initialCapacity);
    this.length = 0;
  }

  push(value) {
    if (this.length >= this.buffer.length) {
      const next = new Float64Array(this.buffer.length * 2);
      next.set(this.buffer);
      this.buffer = next;
    }
    this.buffer[this.length] = value;
    this.length += 1;
  }

  toTypedArray() {
    return this.buffer.slice(0, this.length);
  }
}

function getArrayBuffer(buffer) {
  if (buffer instanceof ArrayBuffer) {
    return buffer;
  }

  if (ArrayBuffer.isView(buffer)) {
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }

  throw new Error("Unsupported FIT input buffer");
}

function getMessageDefinition(globalMessageNumber) {
  const message = FIT.messages[globalMessageNumber];
  if (!message) {
    return { name: "", fieldMap: new Map() };
  }

  const fieldMap = new Map();
  for (const [fieldNum, definition] of Object.entries(message)) {
    if (fieldNum === "name") {
      continue;
    }
    fieldMap.set(Number(fieldNum), definition);
  }

  return {
    name: message.name || "",
    fieldMap
  };
}

function isInvalidValue(data, type) {
  switch (type) {
    case "enum":
    case "uint8":
    case "byte":
      return data === 0xFF;
    case "sint8":
      return data === 0x7F;
    case "sint16":
      return data === 0x7FFF;
    case "uint16":
    case "uint16z":
      return data === 0xFFFF;
    case "sint32":
      return data === 0x7FFFFFFF;
    case "uint32":
    case "uint32z":
    case "date_time":
    case "local_date_time":
      return data === 0xFFFFFFFF;
    case "float32":
      return data === 0xFFFFFFFF;
    default:
      return false;
  }
}

function readValue(view, offset, fieldDef) {
  switch (fieldDef.type) {
    case "uint8":
    case "enum":
    case "byte":
      return view.getUint8(offset);
    case "sint8":
      return view.getInt8(offset);
    case "uint16":
    case "uint16z":
      return view.getUint16(offset, fieldDef.littleEndian);
    case "sint16":
      return view.getInt16(offset, fieldDef.littleEndian);
    case "uint32":
    case "uint32z":
    case "date_time":
    case "local_date_time":
      return view.getUint32(offset, fieldDef.littleEndian);
    case "sint32":
      return view.getInt32(offset, fieldDef.littleEndian);
    case "float32":
      return view.getFloat32(offset, fieldDef.littleEndian);
    case "float64":
      return view.getFloat64(offset, fieldDef.littleEndian);
    default:
      return null;
  }
}

function scaleValue(rawValue, scale = null, offset = 0) {
  if (!Number.isFinite(rawValue)) {
    return NaN;
  }
  return scale ? (rawValue / scale) + offset : rawValue;
}

function decodeValue(fieldName, rawValue, fieldDef) {
  if (rawValue == null || isInvalidValue(rawValue, fieldDef.type)) {
    return NaN;
  }

  switch (fieldName) {
    case "timestamp":
    case "start_time":
      return (rawValue * 1000) + GARMIN_TIME_OFFSET_MS;
    case "position_lat":
    case "position_long":
    case "nec_lat":
    case "nec_long":
    case "swc_lat":
    case "swc_long":
      return rawValue * SEMICIRCLES_TO_DEGREES;
    default:
      return scaleValue(rawValue, fieldDef.scale, fieldDef.offset || 0);
  }
}

function shouldKeepField(messageName, fieldName) {
  if (messageName === "record") {
    return RECORD_FIELDS.has(fieldName);
  }
  if (messageName === "session") {
    return SESSION_FIELDS.has(fieldName);
  }
  return false;
}

function skipMessage(startIndex, messageType) {
  let nextIndex = startIndex + 1;
  for (const fieldDef of messageType.fieldDefs) {
    nextIndex += fieldDef.size;
  }
  return nextIndex;
}

export function parseFitBufferTyped(buffer) {
  const rawBuffer = getArrayBuffer(buffer);
  const blob = new Uint8Array(rawBuffer);

  if (blob.length < 12) {
    throw new Error("File too small to be a FIT file");
  }

  const headerLength = blob[0];
  if (headerLength !== 12 && headerLength !== 14) {
    throw new Error("Incorrect FIT header size");
  }

  let fileTypeString = "";
  for (let index = 8; index < 12; index += 1) {
    fileTypeString += String.fromCharCode(blob[index]);
  }
  if (fileTypeString !== ".FIT") {
    throw new Error("Missing .FIT in FIT header");
  }

  const dataLength = blob[4] + (blob[5] << 8) + (blob[6] << 16) + (blob[7] << 24);
  const crcStart = dataLength + headerLength;
  const messageTypes = [];
  const sessions = [];

  const timestampsMs = new GrowableFloat64Array();
  const distancesM = new GrowableFloat64Array();
  const powersW = new GrowableFloat64Array();
  const heartRatesBpm = new GrowableFloat64Array();
  const cadencesRpm = new GrowableFloat64Array();
  const speedsMps = new GrowableFloat64Array();
  const altitudesM = new GrowableFloat64Array();
  const positionLatsDeg = new GrowableFloat64Array();
  const positionLongsDeg = new GrowableFloat64Array();

  let loopIndex = headerLength;

  while (loopIndex < crcStart) {
    const recordHeader = blob[loopIndex];
    let localMessageType = recordHeader & 0x0F;

    if ((recordHeader & COMPRESSED_HEADER_MASK) === COMPRESSED_HEADER_MASK) {
      localMessageType = (recordHeader & COMPRESSED_LOCAL_MSG_NUM_MASK) >> 5;
    }

    if ((recordHeader & 0x40) === 0x40) {
      const littleEndian = blob[loopIndex + 2] === 0;
      const fieldCount = blob[loopIndex + 5];
      const globalMessageNumber = littleEndian
        ? blob[loopIndex + 3] + (blob[loopIndex + 4] << 8)
        : blob[loopIndex + 4] + (blob[loopIndex + 3] << 8);
      const { name, fieldMap } = getMessageDefinition(globalMessageNumber);
      const fieldDefs = [];

      for (let fieldIndex = 0; fieldIndex < fieldCount; fieldIndex += 1) {
        const definitionOffset = loopIndex + 6 + (fieldIndex * 3);
        const fieldNumber = blob[definitionOffset];
        const size = blob[definitionOffset + 1];
        const baseType = blob[definitionOffset + 2];
        const fieldDefinition = fieldMap.get(fieldNumber) || {};

        fieldDefs.push({
          field: fieldDefinition.field || "",
          type: fieldDefinition.type || "byte",
          scale: fieldDefinition.scale ?? null,
          offset: fieldDefinition.offset ?? 0,
          size,
          littleEndian,
          baseTypeNo: baseType & 0x0F
        });
      }

      messageTypes[localMessageType] = {
        messageName: name,
        fieldDefs
      };

      loopIndex += 6 + (fieldCount * 3);
      continue;
    }

    const messageType = messageTypes[localMessageType] || messageTypes[0];
    if (!messageType) {
      throw new Error(`Missing FIT message definition for local message type ${localMessageType}`);
    }

    const messageName = messageType.messageName;
    if (messageName !== "record" && messageName !== "session") {
      loopIndex = skipMessage(loopIndex, messageType);
      continue;
    }

    const recordViewOffset = loopIndex + 1;
    const recordView = new DataView(blob.buffer, blob.byteOffset + recordViewOffset);
    let currentOffset = 0;

    if (messageName === "record") {
      let timestampMs = NaN;
      let distanceM = NaN;
      let powerW = NaN;
      let heartRateBpm = NaN;
      let cadenceRpm = NaN;
      let speedMps = NaN;
      let altitudeM = NaN;
      let positionLatDeg = NaN;
      let positionLongDeg = NaN;

      for (const fieldDef of messageType.fieldDefs) {
        const rawValue = readValue(recordView, currentOffset, fieldDef);
        currentOffset += fieldDef.size;

        if (!shouldKeepField(messageName, fieldDef.field)) {
          continue;
        }

        const decoded = decodeValue(fieldDef.field, rawValue, fieldDef);
        switch (fieldDef.field) {
          case "timestamp":
            timestampMs = decoded;
            break;
          case "distance":
            distanceM = decoded;
            break;
          case "power":
            powerW = decoded;
            break;
          case "heart_rate":
            heartRateBpm = decoded;
            break;
          case "cadence":
            cadenceRpm = decoded;
            break;
          case "enhanced_speed":
            speedMps = decoded;
            break;
          case "speed":
            if (!Number.isFinite(speedMps)) {
              speedMps = decoded;
            }
            break;
          case "enhanced_altitude":
            altitudeM = decoded;
            break;
          case "altitude":
            if (!Number.isFinite(altitudeM)) {
              altitudeM = decoded;
            }
            break;
          case "position_lat":
            positionLatDeg = decoded;
            break;
          case "position_long":
            positionLongDeg = decoded;
            break;
          default:
            break;
        }
      }

      timestampsMs.push(timestampMs);
      distancesM.push(distanceM);
      powersW.push(powerW);
      heartRatesBpm.push(heartRateBpm);
      cadencesRpm.push(cadenceRpm);
      speedsMps.push(speedMps);
      altitudesM.push(altitudeM);
      positionLatsDeg.push(positionLatDeg);
      positionLongsDeg.push(positionLongDeg);
    } else {
      const session = {};

      for (const fieldDef of messageType.fieldDefs) {
        const rawValue = readValue(recordView, currentOffset, fieldDef);
        currentOffset += fieldDef.size;

        if (!shouldKeepField(messageName, fieldDef.field)) {
          continue;
        }

        const decoded = decodeValue(fieldDef.field, rawValue, fieldDef);
        session[fieldDef.field] = Number.isFinite(decoded) ? decoded : null;
      }

      sessions.push(session);
    }

    loopIndex = recordViewOffset + currentOffset;
  }

  const recordsTyped = {
    recordCount: timestampsMs.length,
    timestampsMs: timestampsMs.toTypedArray(),
    distancesM: distancesM.toTypedArray(),
    powersW: powersW.toTypedArray(),
    heartRatesBpm: heartRatesBpm.toTypedArray(),
    cadencesRpm: cadencesRpm.toTypedArray(),
    speedsMps: speedsMps.toTypedArray(),
    altitudesM: altitudesM.toTypedArray(),
    positionLatsDeg: positionLatsDeg.toTypedArray(),
    positionLongsDeg: positionLongsDeg.toTypedArray()
  };

  return {
    sessions,
    recordsTyped,
    recordsAreSorted: true
  };
}
