import {
  hydrateFitDeviceMetadata,
  isDerivedFitProductName,
  isEquivalentFitName,
  resolveFitBatteryStatusName,
  resolveFitDeviceTypeName,
  resolveFitFileTypeName,
  resolveFitManufacturerName,
  resolveFitSensorPositionName,
  resolveFitSourceTypeName
} from "./FitDeviceCatalog.js";

const MAGIC = "DEV1";
const VERSION = 1;
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

const FILE_FIELDS = [
  ["type", "u8"],
  ["manufacturer", "u16"],
  ["product", "u16"],
  ["serialNumber", "u32"],
  ["timeCreated", "time"],
  ["number", "u16"],
  ["productName", "string"],
  ["typeName", "string"],
  ["manufacturerName", "string"]
];

const DEVICE_FIELDS = [
  ["timestamp", "time"],
  ["deviceIndex", "u8"],
  ["deviceType", "u8"],
  ["manufacturer", "u16"],
  ["serialNumber", "u32"],
  ["product", "u16"],
  ["softwareVersion", "scale100"],
  ["hardwareVersion", "u8"],
  ["cumulativeOperatingTime", "u32"],
  ["batteryVoltage", "scale256"],
  ["batteryStatus", "u8"],
  ["batteryLevel", "u8"],
  ["sensorPosition", "u8"],
  ["descriptor", "string"],
  ["antTransmissionType", "u8"],
  ["antDeviceNumber", "u16"],
  ["antNetwork", "u8"],
  ["antId", "u32"],
  ["sourceType", "u8"],
  ["productName", "string"],
  ["manufacturerName", "string"],
  ["deviceTypeName", "string"],
  ["sourceTypeName", "string"],
  ["batteryStatusName", "string"],
  ["sensorPositionName", "string"]
];

function hasValue(type, value) {
  if (value === null || value === undefined || value === "") return false;
  if (type === "string") return true;
  if (type === "time") return Number.isFinite(new Date(value).getTime());
  return Number.isFinite(Number(value));
}

function normalizeEntry(entry, fields) {
  const normalized = { ...(entry || {}) };
  const fieldNames = new Set(fields.map(([key]) => key));
  if (fieldNames.has("productName") && isDerivedFitProductName(
    normalized.manufacturer,
    normalized.product,
    normalized.productName
  )) {
    normalized.productName = null;
  }
  if (fieldNames.has("typeName") && isEquivalentFitName(
    normalized.typeName,
    resolveFitFileTypeName(normalized.type)
  )) normalized.typeName = null;
  if (fieldNames.has("manufacturerName") && isEquivalentFitName(
    normalized.manufacturerName,
    resolveFitManufacturerName(normalized.manufacturer)
  )) normalized.manufacturerName = null;
  if (fieldNames.has("deviceTypeName") && isEquivalentFitName(
    normalized.deviceTypeName,
    resolveFitDeviceTypeName(normalized.sourceType, normalized.deviceType)
  )) normalized.deviceTypeName = null;
  if (fieldNames.has("sourceTypeName") && isEquivalentFitName(
    normalized.sourceTypeName,
    resolveFitSourceTypeName(normalized.sourceType)
  )) normalized.sourceTypeName = null;
  if (fieldNames.has("batteryStatusName") && isEquivalentFitName(
    normalized.batteryStatusName,
    resolveFitBatteryStatusName(normalized.batteryStatus)
  )) normalized.batteryStatusName = null;
  if (fieldNames.has("sensorPositionName") && isEquivalentFitName(
    normalized.sensorPositionName,
    resolveFitSensorPositionName(normalized.sensorPosition)
  )) normalized.sensorPositionName = null;
  return normalized;
}

function encodedFieldSize(type, value) {
  if (type === "u8") return 1;
  if (type === "u16" || type === "scale100" || type === "scale256") return 2;
  if (type === "u32" || type === "time") return 4;
  const length = TEXT_ENCODER.encode(String(value)).byteLength;
  if (length > 0xffff) throw new Error("DEV1 string field is too long");
  return 2 + length;
}

function prepareEntry(entry, fields) {
  const normalized = normalizeEntry(entry, fields);
  let bitmap = 0;
  let byteLength = 0;
  fields.forEach(([key, type], index) => {
    if (!hasValue(type, normalized[key])) return;
    bitmap |= (1 << index) >>> 0;
    byteLength += encodedFieldSize(type, normalized[key]);
  });
  return { normalized, bitmap: bitmap >>> 0, byteLength };
}

function writeField(view, bytes, offset, type, value) {
  if (type === "u8") {
    view.setUint8(offset, Math.max(0, Math.min(0xff, Math.round(Number(value)))));
    return offset + 1;
  }
  if (type === "u16") {
    view.setUint16(offset, Math.max(0, Math.min(0xffff, Math.round(Number(value)))), true);
    return offset + 2;
  }
  if (type === "u32") {
    view.setUint32(offset, Math.max(0, Math.min(0xffffffff, Math.round(Number(value)))), true);
    return offset + 4;
  }
  if (type === "scale100" || type === "scale256") {
    const scale = type === "scale100" ? 100 : 256;
    view.setUint16(offset, Math.max(0, Math.min(0xffff, Math.round(Number(value) * scale))), true);
    return offset + 2;
  }
  if (type === "time") {
    const timestampMs = new Date(value).getTime();
    view.setUint32(offset, Number.isFinite(timestampMs) ? Math.round(timestampMs / 1000) : 0, true);
    return offset + 4;
  }
  const encoded = TEXT_ENCODER.encode(String(value));
  view.setUint16(offset, encoded.byteLength, true);
  bytes.set(encoded, offset + 2);
  return offset + 2 + encoded.byteLength;
}

function writeEntry(view, bytes, offset, prepared, fields, bitmapBytes) {
  if (bitmapBytes === 2) view.setUint16(offset, prepared.bitmap, true);
  else view.setUint32(offset, prepared.bitmap, true);
  offset += bitmapBytes;
  fields.forEach(([key, type], index) => {
    if ((prepared.bitmap & ((1 << index) >>> 0)) === 0) return;
    offset = writeField(view, bytes, offset, type, prepared.normalized[key]);
  });
  return offset;
}

function readField(view, bytes, offset, type) {
  if (type === "u8") return { value: view.getUint8(offset), offset: offset + 1 };
  if (type === "u16") return { value: view.getUint16(offset, true), offset: offset + 2 };
  if (type === "u32") return { value: view.getUint32(offset, true), offset: offset + 4 };
  if (type === "scale100" || type === "scale256") {
    const scale = type === "scale100" ? 100 : 256;
    return { value: view.getUint16(offset, true) / scale, offset: offset + 2 };
  }
  if (type === "time") {
    const seconds = view.getUint32(offset, true);
    return { value: new Date(seconds * 1000).toISOString(), offset: offset + 4 };
  }
  const length = view.getUint16(offset, true);
  const start = offset + 2;
  return { value: TEXT_DECODER.decode(bytes.subarray(start, start + length)), offset: start + length };
}

function readEntry(view, bytes, offset, fields, bitmapBytes) {
  const bitmap = bitmapBytes === 2 ? view.getUint16(offset, true) : view.getUint32(offset, true);
  offset += bitmapBytes;
  const entry = {};
  fields.forEach(([key, type], index) => {
    if ((bitmap & ((1 << index) >>> 0)) === 0) return;
    const decoded = readField(view, bytes, offset, type);
    entry[key] = decoded.value;
    offset = decoded.offset;
  });
  return { entry, offset };
}

export function encodeFitDeviceMetadata(metadata) {
  const fileId = metadata?.fileId && typeof metadata.fileId === "object" ? metadata.fileId : null;
  const devices = (Array.isArray(metadata?.devices) ? metadata.devices : [])
    .filter((device) => device && typeof device === "object");
  if (!fileId && devices.length === 0) return new Uint8Array(0);
  if (devices.length > 0xffff) throw new Error("DEV1 contains too many devices");

  const preparedFile = fileId ? prepareEntry(fileId, FILE_FIELDS) : null;
  const preparedDevices = devices.map((device) => prepareEntry(device, DEVICE_FIELDS));
  const totalBytes = 8
    + (preparedFile ? 2 + preparedFile.byteLength : 0)
    + preparedDevices.reduce((sum, device) => sum + 4 + device.byteLength, 0);
  const bytes = new Uint8Array(totalBytes);
  const view = new DataView(bytes.buffer);
  bytes.set(TEXT_ENCODER.encode(MAGIC), 0);
  view.setUint8(4, VERSION);
  view.setUint8(5, preparedFile ? 1 : 0);
  view.setUint16(6, preparedDevices.length, true);
  let offset = 8;
  if (preparedFile) offset = writeEntry(view, bytes, offset, preparedFile, FILE_FIELDS, 2);
  for (const device of preparedDevices) {
    offset = writeEntry(view, bytes, offset, device, DEVICE_FIELDS, 4);
  }
  return bytes;
}

export function decodeFitDeviceMetadata(bufferLike) {
  const bytes = bufferLike instanceof Uint8Array ? bufferLike : new Uint8Array(bufferLike || 0);
  if (bytes.byteLength === 0) return null;
  if (bytes.byteLength < 8 || TEXT_DECODER.decode(bytes.subarray(0, 4)) !== MAGIC) {
    throw new Error("Invalid DEV1 block");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(4) !== VERSION) throw new Error(`Unsupported DEV1 version: ${view.getUint8(4)}`);
  const hasFile = (view.getUint8(5) & 1) !== 0;
  const deviceCount = view.getUint16(6, true);
  let offset = 8;
  let fileId = null;
  if (hasFile) {
    const decoded = readEntry(view, bytes, offset, FILE_FIELDS, 2);
    fileId = decoded.entry;
    offset = decoded.offset;
  }
  const devices = [];
  for (let index = 0; index < deviceCount; index += 1) {
    const decoded = readEntry(view, bytes, offset, DEVICE_FIELDS, 4);
    devices.push(decoded.entry);
    offset = decoded.offset;
  }
  if (offset !== bytes.byteLength) throw new Error("Corrupt DEV1 block length");
  return hydrateFitDeviceMetadata({ version: 2, fileId, devices });
}

export function hasFitDeviceMetadata(metadata) {
  return !!(
    metadata
    && typeof metadata === "object"
    && (
      (metadata.fileId && typeof metadata.fileId === "object")
      || (Array.isArray(metadata.devices) && metadata.devices.length > 0)
    )
  );
}

export function stripFitDeviceMetadataFromWorkoutStream(bufferLike) {
  const bytes = bufferLike instanceof Uint8Array ? bufferLike : new Uint8Array(bufferLike || 0);
  if (bytes.byteLength < 56 || TEXT_DECODER.decode(bytes.subarray(0, 4)) !== "WS11") return bytes;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const metadataLengthOffset = 20 + (8 * 4);
  const metadataLength = view.getUint32(metadataLengthOffset, true);
  if (metadataLength === 0) return bytes;
  if (metadataLength > bytes.byteLength - 56) throw new Error("Corrupt WS11 device metadata length");

  const stripped = bytes.slice(0, bytes.byteLength - metadataLength);
  new DataView(stripped.buffer, stripped.byteOffset, stripped.byteLength)
    .setUint32(metadataLengthOffset, 0, true);
  return stripped;
}
