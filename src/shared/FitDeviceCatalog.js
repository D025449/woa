const MANUFACTURERS = new Map([
  [0, "development"],
  [1, "garmin"],
  [13, "dynastream_oem"],
  [29, "saxonar"],
  [89, "tacx"],
  [263, "favero_electronics"]
]);

const GARMIN_PRODUCTS = new Map([
  [1561, "edge_510"],
  [2530, "edge_820"],
  [2713, "edge_1030"],
  [4440, "edge_1050"]
]);

const SOURCE_TYPES = new Map([
  [0, "ant"],
  [1, "antplus"],
  [2, "bluetooth"],
  [3, "bluetooth_low_energy"],
  [4, "wifi"],
  [5, "local"]
]);

const FILE_TYPES = new Map([
  [1, "device"],
  [2, "settings"],
  [3, "sport"],
  [4, "activity"],
  [5, "workout"],
  [6, "course"],
  [34, "segment"],
  [35, "segment_list"]
]);

const ANT_DEVICE_TYPES = new Map([
  [11, "bike_power"],
  [17, "fitness_equipment"],
  [31, "muscle_oxygen"],
  [40, "bike_radar"],
  [120, "heart_rate"],
  [121, "bike_speed_cadence"],
  [122, "bike_cadence"],
  [123, "bike_speed"]
]);

const LOCAL_DEVICE_TYPES = new Map([
  [0, "gps"],
  [1, "glonass"],
  [2, "gps_glonass"],
  [3, "accelerometer"],
  [4, "barometer"],
  [5, "temperature"],
  [10, "whr"],
  [12, "sensor_hub"]
]);

const BLE_DEVICE_TYPES = new Map([
  [0, "connected_gps"],
  [1, "heart_rate"],
  [2, "bike_power"],
  [3, "bike_speed_cadence"],
  [4, "bike_speed"],
  [5, "bike_cadence"],
  [6, "footpod"],
  [7, "bike_trainer"]
]);

const BATTERY_STATUSES = new Map([
  [1, "new"],
  [2, "good"],
  [3, "ok"],
  [4, "low"],
  [5, "critical"],
  [6, "charging"],
  [7, "unknown"]
]);

const BODY_LOCATIONS = new Map([
  [0, "left_leg"],
  [1, "left_calf"],
  [2, "left_shin"],
  [3, "left_hamstring"],
  [4, "left_quad"],
  [5, "left_glute"],
  [6, "right_leg"],
  [7, "right_calf"],
  [8, "right_shin"],
  [9, "right_hamstring"],
  [10, "right_quad"],
  [11, "right_glute"],
  [12, "torso_back"],
  [17, "torso_front"],
  [22, "left_arm"],
  [28, "right_arm"],
  [34, "neck"],
  [35, "throat"]
]);

function finiteInteger(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : null;
}

export function resolveFitManufacturerName(manufacturer) {
  return MANUFACTURERS.get(finiteInteger(manufacturer)) || null;
}

export function resolveFitFileTypeName(type) {
  return FILE_TYPES.get(finiteInteger(type)) || null;
}

export function resolveFitProductName(manufacturer, product) {
  const manufacturerId = finiteInteger(manufacturer);
  const productId = finiteInteger(product);
  if (manufacturerId === 1) return GARMIN_PRODUCTS.get(productId) || null;
  return null;
}

export function resolveFitSourceTypeName(sourceType) {
  return SOURCE_TYPES.get(finiteInteger(sourceType)) || null;
}

export function resolveFitDeviceTypeName(sourceType, deviceType) {
  const sourceTypeId = finiteInteger(sourceType);
  const deviceTypeId = finiteInteger(deviceType);
  if (sourceTypeId === 0 || sourceTypeId === 1) return ANT_DEVICE_TYPES.get(deviceTypeId) || null;
  if (sourceTypeId === 2 || sourceTypeId === 3) return BLE_DEVICE_TYPES.get(deviceTypeId) || null;
  return LOCAL_DEVICE_TYPES.get(deviceTypeId) || null;
}

export function resolveFitBatteryStatusName(status) {
  return BATTERY_STATUSES.get(finiteInteger(status)) || null;
}

export function resolveFitSensorPositionName(position) {
  return BODY_LOCATIONS.get(finiteInteger(position)) || null;
}

export function hydrateFitDeviceMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") return null;
  const fileId = metadata.fileId && typeof metadata.fileId === "object"
    ? {
        ...metadata.fileId,
        typeName: metadata.fileId.typeName || resolveFitFileTypeName(metadata.fileId.type),
        manufacturerName: metadata.fileId.manufacturerName
          || resolveFitManufacturerName(metadata.fileId.manufacturer),
        productName: metadata.fileId.productName
          || resolveFitProductName(metadata.fileId.manufacturer, metadata.fileId.product)
      }
    : null;
  const devices = (Array.isArray(metadata.devices) ? metadata.devices : []).map((device) => ({
    ...device,
    manufacturerName: device.manufacturerName || resolveFitManufacturerName(device.manufacturer),
    productName: device.productName || resolveFitProductName(device.manufacturer, device.product),
    sourceTypeName: device.sourceTypeName || resolveFitSourceTypeName(device.sourceType),
    deviceTypeName: device.deviceTypeName
      || resolveFitDeviceTypeName(device.sourceType, device.deviceType),
    batteryStatusName: device.batteryStatusName
      || resolveFitBatteryStatusName(device.batteryStatus),
    sensorPositionName: device.sensorPositionName
      || resolveFitSensorPositionName(device.sensorPosition)
  }));
  return { version: 2, fileId, devices };
}

export function isDerivedFitProductName(manufacturer, product, name) {
  return isEquivalentFitName(name, resolveFitProductName(manufacturer, product));
}

export function isEquivalentFitName(name, derived) {
  if (!name) return true;
  if (!derived) return false;
  const normalize = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
  return normalize(derived) === normalize(name);
}
