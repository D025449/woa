import { FIT } from "/vendor/fit-file-parser-fast/dist/fit.js";

const GARMIN_TIME_OFFSET_MS = 631065600000;
const COMPRESSED_HEADER_MASK = 0x80;
const COMPRESSED_LOCAL_MSG_NUM_MASK = 0x60;
const SEMICIRCLES_TO_DEGREES = 180 / 0x80000000;
const DEFINITION_MESSAGE_MASK = 0x40;
const DEVELOPER_DATA_MASK = 0x20;
const DEFAULT_TYPED_ARRAY_CAPACITY = 1024;

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
  constructor(initialCapacity = DEFAULT_TYPED_ARRAY_CAPACITY) {
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
    case "string": {
      const bytes = new Uint8Array(view.buffer, view.byteOffset + offset, fieldDef.size);
      let length = 0;
      while (length < bytes.length && bytes[length] !== 0) {
        length += 1;
      }
      return new TextDecoder("utf-8").decode(bytes.subarray(0, length));
    }
    case "byte_array":
      return new Uint8Array(view.buffer, view.byteOffset + offset, fieldDef.size);
    default:
      return null;
  }
}

function scaleValue(rawValue, scale = null, offset = 0) {
  if (!Number.isFinite(rawValue)) {
    return Number.NaN;
  }
  return scale ? (rawValue / scale) + offset : rawValue;
}

function decodeValue(fieldName, rawValue, fieldDef) {
  if (rawValue == null || isInvalidValue(rawValue, fieldDef.type)) {
    return Number.NaN;
  }

  if (fieldDef.type === "string" || fieldDef.type === "byte_array") {
    return rawValue;
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
  if (messageName === "field_description") {
    return fieldName === "developer_data_index"
      || fieldName === "field_definition_number"
      || fieldName === "fit_base_type_id"
      || fieldName === "field_name"
      || fieldName === "scale"
      || fieldName === "offset";
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

function decodeDeveloperFieldDescription(fieldDescription) {
  const developerDataIndex = Number(fieldDescription?.developer_data_index);
  const fieldDefinitionNumber = Number(fieldDescription?.field_definition_number);
  const fitBaseTypeId = Number(fieldDescription?.fit_base_type_id);
  const fieldName = typeof fieldDescription?.field_name === "string"
    ? fieldDescription.field_name.trim()
    : "";

  if (!Number.isInteger(developerDataIndex) || developerDataIndex < 0) {
    return null;
  }
  if (!Number.isInteger(fieldDefinitionNumber) || fieldDefinitionNumber < 0) {
    return null;
  }
  if (!Number.isInteger(fitBaseTypeId) || fitBaseTypeId < 0) {
    return null;
  }
  if (!fieldName) {
    return null;
  }

  return {
    developerDataIndex,
    fieldDefinitionNumber,
    fitBaseTypeId,
    fieldName,
    type: FIT.types?.fit_base_type?.[fitBaseTypeId] || "byte",
    scale: Number.isFinite(Number(fieldDescription?.scale)) ? Number(fieldDescription.scale) : null,
    offset: Number.isFinite(Number(fieldDescription?.offset)) ? Number(fieldDescription.offset) : 0
  };
}

export function parseFitBufferTypedBrowser(buffer) {
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
  const developerFields = [];
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

    if ((recordHeader & DEFINITION_MESSAGE_MASK) === DEFINITION_MESSAGE_MASK) {
      const hasDeveloperData = (recordHeader & DEVELOPER_DATA_MASK) === DEVELOPER_DATA_MASK;
      const littleEndian = blob[loopIndex + 2] === 0;
      const fieldCount = blob[loopIndex + 5];
      const developerFieldCount = hasDeveloperData
        ? blob[loopIndex + 6 + (fieldCount * 3)]
        : 0;
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

      for (let fieldIndex = 0; fieldIndex < developerFieldCount; fieldIndex += 1) {
        const definitionOffset = loopIndex + 7 + (fieldCount * 3) + (fieldIndex * 3);
        const fieldNumber = blob[definitionOffset];
        const size = blob[definitionOffset + 1];
        const developerDataIndex = blob[definitionOffset + 2];
        const developerField = developerFields[developerDataIndex]?.[fieldNumber];

        if (!developerField) {
          fieldDefs.push({
            field: "",
            type: "byte",
            scale: null,
            offset: 0,
            size,
            littleEndian,
            baseTypeNo: 13,
            isDeveloperField: true
          });
          continue;
        }

        fieldDefs.push({
          field: developerField.fieldName,
          type: developerField.type,
          scale: developerField.scale,
          offset: developerField.offset,
          size,
          littleEndian,
          baseTypeNo: developerField.fitBaseTypeId & 0x0F,
          isDeveloperField: true
        });
      }

      messageTypes[localMessageType] = {
        messageName: name,
        fieldDefs
      };

      loopIndex += 6 + (fieldCount * 3) + (hasDeveloperData ? 1 + (developerFieldCount * 3) : 0);
      continue;
    }

    const messageType = messageTypes[localMessageType] || messageTypes[0];
    if (!messageType) {
      throw new Error(`Missing FIT message definition for local message type ${localMessageType}`);
    }

    const messageName = messageType.messageName;
    if (messageName !== "record" && messageName !== "session" && messageName !== "field_description") {
      loopIndex = skipMessage(loopIndex, messageType);
      continue;
    }

    const recordViewOffset = loopIndex + 1;
    const recordView = new DataView(blob.buffer, blob.byteOffset + recordViewOffset);
    let currentOffset = 0;

    if (messageName === "record") {
      let timestampMs = Number.NaN;
      let distanceM = Number.NaN;
      let powerW = Number.NaN;
      let heartRateBpm = Number.NaN;
      let cadenceRpm = Number.NaN;
      let speedMps = Number.NaN;
      let altitudeM = Number.NaN;
      let positionLatDeg = Number.NaN;
      let positionLongDeg = Number.NaN;

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
      const target = {};

      for (const fieldDef of messageType.fieldDefs) {
        const rawValue = readValue(recordView, currentOffset, fieldDef);
        currentOffset += fieldDef.size;

        if (!shouldKeepField(messageName, fieldDef.field)) {
          continue;
        }

        const decoded = decodeValue(fieldDef.field, rawValue, fieldDef);
        target[fieldDef.field] = typeof decoded === "string"
          ? decoded
          : (Number.isFinite(decoded) ? decoded : null);
      }

      if (messageName === "field_description") {
        const developerFieldDescription = decodeDeveloperFieldDescription(target);
        if (developerFieldDescription) {
          developerFields[developerFieldDescription.developerDataIndex]
            = developerFields[developerFieldDescription.developerDataIndex] || [];
          developerFields[developerFieldDescription.developerDataIndex][developerFieldDescription.fieldDefinitionNumber]
            = developerFieldDescription;
        }
      } else {
        sessions.push(target);
      }
    }

    loopIndex = recordViewOffset + currentOffset;
  }

  return {
    sessions,
    recordsTyped: {
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
    },
    recordsAreSorted: true
  };
}
