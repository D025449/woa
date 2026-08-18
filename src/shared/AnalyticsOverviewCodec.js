import { POWER_DISTRIBUTION_ZONES } from "./PowerDistribution.js";

const MAGIC = Object.freeze([0x41, 0x4f, 0x56, 0x31]); // AOV1
const VERSION = 1;
const HEADER_BYTES = 24;
const LOAD_ROW_BYTES = 24;
const DISTRIBUTION_ROW_BYTES = 60;
const CP_ROW_BYTES = 44;
const FTP_ROW_BYTES = 16;
const UINT32_NULL = 0xffffffff;
const FIT_EPOCH_MS = Date.UTC(1989, 11, 31, 0, 0, 0);

const GROUPINGS = Object.freeze({
  week: Object.freeze({ code: 1, cp: "year_week" }),
  month: Object.freeze({ code: 2, cp: "year_month" }),
  quarter: Object.freeze({ code: 3, cp: "year_quarter" }),
  year: Object.freeze({ code: 4, cp: "year" })
});
const GROUPING_BY_CODE = new Map(
  Object.entries(GROUPINGS).map(([name, config]) => [Number(config.code), { name, ...config }])
);

function finiteNumber(value, fallback = Number.NaN) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function periodNumber(value) {
  const period = Number(value);
  if (!Number.isInteger(period) || period < 0 || period >= UINT32_NULL) {
    throw new TypeError(`Invalid analytics period: ${value}`);
  }
  return period;
}

function unsignedNumber(value, nullValue = UINT32_NULL) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number < nullValue
    ? number
    : nullValue;
}

function fitTimestampSeconds(value) {
  if (value == null) return UINT32_NULL;
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(timestamp)) return UINT32_NULL;
  const seconds = Math.floor((timestamp - FIT_EPOCH_MS) / 1000);
  if (!Number.isInteger(seconds) || seconds < 0 || seconds >= UINT32_NULL) {
    throw new RangeError(`Analytics timestamp is outside the FIT epoch range: ${value}`);
  }
  return seconds;
}

function isoTimestampFromFitSeconds(value) {
  return value === UINT32_NULL
    ? null
    : new Date(FIT_EPOCH_MS + (value * 1000)).toISOString();
}

function writeFloat32(view, offset, value) {
  view.setFloat32(offset, finiteNumber(value), true);
  return offset + 4;
}

function readFloat32(view, offset) {
  const value = view.getFloat32(offset, true);
  return Number.isFinite(value) ? value : null;
}

function validateRows(value) {
  return Array.isArray(value) ? value : [];
}

export function encodeAnalyticsOverview({
  grouping,
  durations,
  loadModelRows,
  distributionRows,
  cpRows,
  rollingFtpRows
}) {
  const groupingConfig = GROUPINGS[grouping];
  if (!groupingConfig) throw new TypeError(`Unsupported analytics grouping: ${grouping}`);

  const normalizedDurations = validateRows(durations).map(Number);
  const loadRows = validateRows(loadModelRows);
  const distributions = validateRows(distributionRows);
  const criticalPowers = validateRows(cpRows);
  const rollingFtp = validateRows(rollingFtpRows);
  if (normalizedDurations.length > 255) throw new RangeError("Too many CP durations");

  const byteLength = HEADER_BYTES
    + (normalizedDurations.length * 2)
    + (loadRows.length * LOAD_ROW_BYTES)
    + (distributions.length * DISTRIBUTION_ROW_BYTES)
    + (criticalPowers.length * CP_ROW_BYTES)
    + (rollingFtp.length * FTP_ROW_BYTES);
  const bytes = new Uint8Array(byteLength);
  const view = new DataView(bytes.buffer);
  bytes.set(MAGIC, 0);
  view.setUint8(4, VERSION);
  view.setUint8(5, groupingConfig.code);
  view.setUint8(6, normalizedDurations.length);
  view.setUint8(7, 0);
  view.setUint32(8, loadRows.length, true);
  view.setUint32(12, distributions.length, true);
  view.setUint32(16, criticalPowers.length, true);
  view.setUint32(20, rollingFtp.length, true);

  let offset = HEADER_BYTES;
  for (const duration of normalizedDurations) {
    view.setUint16(offset, unsignedNumber(duration, 0xffff), true);
    offset += 2;
  }

  for (const row of loadRows) {
    view.setUint32(offset, periodNumber(row.date), true);
    offset += 4;
    offset = writeFloat32(view, offset, row.tss_sum);
    offset = writeFloat32(view, offset, row.ctl_start);
    offset = writeFloat32(view, offset, row.ctl_end);
    offset = writeFloat32(view, offset, row.tsb_avg);
    offset = writeFloat32(view, offset, row.atl_avg);
  }

  for (const row of distributions) {
    view.setUint32(offset, periodNumber(row.period), true);
    offset += 4;
    for (const value of [
      row.workoutCount,
      row.classifiedWorkoutCount,
      row.invalidHistogramCount,
      row.activeSeconds,
      row.zeroSeconds,
      row.missingSeconds,
      row.unclassifiedSeconds
    ]) {
      view.setUint32(offset, unsignedNumber(value, UINT32_NULL), true);
      offset += 4;
    }
    for (const { key } of POWER_DISTRIBUTION_ZONES) {
      view.setUint32(offset, unsignedNumber(row.zoneSeconds?.[key], UINT32_NULL), true);
      offset += 4;
    }
  }

  for (const row of criticalPowers) {
    view.setUint32(offset, periodNumber(row.grp), true);
    view.setUint16(offset + 4, unsignedNumber(row.duration, 0xffff), true);
    view.setUint16(offset + 6, 0, true);
    offset += 8;
    offset = writeFloat32(view, offset, row.best_effort_avg_power);
    offset = writeFloat32(view, offset, row.best_effort_avg_heart_rate);
    offset = writeFloat32(view, offset, row.best_effort_avg_cadence);
    offset = writeFloat32(view, offset, row.best_effort_avg_speed);
    view.setFloat64(offset, finiteNumber(row.best_effort_file_id), true);
    offset += 8;
    view.setUint32(offset, unsignedNumber(row.start_offset), true);
    view.setUint32(offset + 4, unsignedNumber(row.end_offset), true);
    offset += 8;
    view.setUint32(offset, fitTimestampSeconds(row.start_time), true);
    offset += 4;
  }

  for (const row of rollingFtp) {
    view.setUint32(offset, periodNumber(row.period), true);
    offset += 4;
    offset = writeFloat32(view, offset, row.ftp);
    view.setUint16(offset, unsignedNumber(row.confidence, 0xffff), true);
    view.setUint8(offset + 2, unsignedNumber(row.modelPointCount, 0xff));
    view.setUint8(offset + 3, 0);
    offset += 4;
    view.setUint32(offset, fitTimestampSeconds(row.startTime), true);
    offset += 4;
  }

  return bytes;
}

export function decodeAnalyticsOverview(input) {
  const bytes = input instanceof Uint8Array
    ? input
    : new Uint8Array(input);
  if (bytes.byteLength < HEADER_BYTES) throw new RangeError("Analytics overview is truncated");
  if (!MAGIC.every((value, index) => bytes[index] === value)) {
    throw new TypeError("Unsupported analytics overview format");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(4) !== VERSION) {
    throw new TypeError(`Unsupported analytics overview version: ${view.getUint8(4)}`);
  }
  const groupingConfig = GROUPING_BY_CODE.get(view.getUint8(5));
  if (!groupingConfig) throw new TypeError("Unsupported analytics grouping code");

  const durationCount = view.getUint8(6);
  const loadCount = view.getUint32(8, true);
  const distributionCount = view.getUint32(12, true);
  const cpCount = view.getUint32(16, true);
  const ftpCount = view.getUint32(20, true);
  const expectedBytes = HEADER_BYTES
    + (durationCount * 2)
    + (loadCount * LOAD_ROW_BYTES)
    + (distributionCount * DISTRIBUTION_ROW_BYTES)
    + (cpCount * CP_ROW_BYTES)
    + (ftpCount * FTP_ROW_BYTES);
  if (bytes.byteLength !== expectedBytes) {
    throw new RangeError(`Invalid analytics overview length: ${bytes.byteLength}, expected ${expectedBytes}`);
  }

  let offset = HEADER_BYTES;
  const durations = [];
  for (let index = 0; index < durationCount; index += 1) {
    durations.push(view.getUint16(offset, true));
    offset += 2;
  }

  const loadModelRows = [];
  for (let index = 0; index < loadCount; index += 1) {
    loadModelRows.push({
      date: String(view.getUint32(offset, true)),
      tss_sum: readFloat32(view, offset + 4),
      ctl_start: readFloat32(view, offset + 8),
      ctl_end: readFloat32(view, offset + 12),
      tsb_avg: readFloat32(view, offset + 16),
      atl_avg: readFloat32(view, offset + 20)
    });
    offset += LOAD_ROW_BYTES;
  }

  const distributionRows = [];
  for (let index = 0; index < distributionCount; index += 1) {
    const period = view.getUint32(offset, true);
    const values = [];
    for (let valueIndex = 0; valueIndex < 7; valueIndex += 1) {
      values.push(view.getUint32(offset + 4 + (valueIndex * 4), true));
    }
    const zoneSeconds = {};
    POWER_DISTRIBUTION_ZONES.forEach(({ key }, zoneIndex) => {
      zoneSeconds[key] = view.getUint32(offset + 32 + (zoneIndex * 4), true);
    });
    const activeSeconds = values[3];
    distributionRows.push({
      period,
      workoutCount: values[0],
      classifiedWorkoutCount: values[1],
      invalidHistogramCount: values[2],
      activeSeconds,
      zeroSeconds: values[4],
      missingSeconds: values[5],
      unclassifiedSeconds: values[6],
      zoneSeconds,
      zonePercentages: Object.fromEntries(POWER_DISTRIBUTION_ZONES.map(({ key }) => [
        key,
        activeSeconds > 0 ? (zoneSeconds[key] / activeSeconds) * 100 : 0
      ]))
    });
    offset += DISTRIBUTION_ROW_BYTES;
  }

  const powerCurveData = {};
  for (let index = 0; index < cpCount; index += 1) {
    const period = String(view.getUint32(offset, true));
    const duration = view.getUint16(offset + 4, true);
    const fileId = view.getFloat64(offset + 24, true);
    const startOffset = view.getUint32(offset + 32, true);
    const endOffset = view.getUint32(offset + 36, true);
    if (!powerCurveData[period]) powerCurveData[period] = {};
    powerCurveData[period][`CP${duration}`] = {
      power: readFloat32(view, offset + 8),
      heartRate: readFloat32(view, offset + 12),
      cadence: readFloat32(view, offset + 16),
      speed: readFloat32(view, offset + 20),
      fileId: Number.isFinite(fileId) ? String(Math.trunc(fileId)) : null,
      startOffset: startOffset === UINT32_NULL ? null : startOffset,
      endOffset: endOffset === UINT32_NULL ? null : endOffset,
      startTime: isoTimestampFromFitSeconds(view.getUint32(offset + 40, true))
    };
    offset += CP_ROW_BYTES;
  }

  for (let index = 0; index < ftpCount; index += 1) {
    const period = String(view.getUint32(offset, true));
    if (!powerCurveData[period]) powerCurveData[period] = {};
    const confidence = view.getUint16(offset + 8, true);
    const modelPointCount = view.getUint8(offset + 10);
    powerCurveData[period].eFTP = {
      power: Math.round(readFloat32(view, offset + 4)),
      confidence: confidence === 0xffff ? null : confidence,
      modelPointCount: modelPointCount === 0xff ? null : modelPointCount,
      startTime: isoTimestampFromFitSeconds(view.getUint32(offset + 12, true))
    };
    offset += FTP_ROW_BYTES;
  }

  return {
    grouping: groupingConfig.name,
    loadModel: { grouping: groupingConfig.name, data: loadModelRows },
    powerDistribution: {
      grouping: groupingConfig.name,
      zones: POWER_DISTRIBUTION_ZONES.map(({ key, maxPercent, color }) => ({
        key,
        maxPercent: Number.isFinite(maxPercent) ? maxPercent : null,
        color
      })),
      data: distributionRows
    },
    powerCurve: {
      grouping: groupingConfig.cp,
      durations,
      data: powerCurveData
    }
  };
}
