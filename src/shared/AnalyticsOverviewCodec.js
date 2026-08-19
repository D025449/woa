import { POWER_DISTRIBUTION_ZONES } from "./PowerDistribution.js";

const MAGIC = Object.freeze([0x41, 0x4f, 0x56, 0x31]); // AOV1
const VERSION = 3;
const HEADER_BYTES = 24;
const LOAD_ROW_BYTES = 14;
const DISTRIBUTION_ROW_BYTES = 39;
const CP_ROW_BYTES = 29;
const FTP_ROW_BYTES = 13;
const UINT32_NULL = 0xffffffff;
const UINT16_NULL = 0xffff;
const UINT8_NULL = 0xff;
const INT16_NULL = -0x8000;
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

function signedInt16Number(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > INT16_NULL && number <= 0x7fff
    ? number
    : INT16_NULL;
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

function readUint16(view, offset) {
  const value = view.getUint16(offset, true);
  return value === UINT16_NULL ? null : value;
}

function readUint8(view, offset) {
  const value = view.getUint8(offset);
  return value === UINT8_NULL ? null : value;
}

function readInt16(view, offset) {
  const value = view.getInt16(offset, true);
  return value === INT16_NULL ? null : value;
}

function validateRows(value) {
  return Array.isArray(value) ? value : [];
}

function quantizeZonePercentages(row) {
  const activeSeconds = Number(row.activeSeconds);
  if (!(activeSeconds > 0)) return new Uint8Array(POWER_DISTRIBUTION_ZONES.length);

  const shares = POWER_DISTRIBUTION_ZONES.map(({ key }, index) => {
    const exact = Math.max(0, Number(row.zoneSeconds?.[key]) || 0) * UINT8_NULL / activeSeconds;
    const base = Math.floor(exact);
    return { index, base, remainder: exact - base };
  });
  let remaining = UINT8_NULL - shares.reduce((sum, share) => sum + share.base, 0);
  shares.sort((left, right) => right.remainder - left.remainder || left.index - right.index);
  for (let index = 0; index < shares.length && remaining > 0; index += 1, remaining -= 1) {
    shares[index].base += 1;
  }

  const quantized = new Uint8Array(POWER_DISTRIBUTION_ZONES.length);
  for (const share of shares) quantized[share.index] = share.base;
  return quantized;
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
    view.setUint16(offset, unsignedNumber(row.tss_sum, UINT16_NULL), true);
    view.setUint16(offset + 2, unsignedNumber(row.ctl_start, UINT16_NULL), true);
    view.setUint16(offset + 4, unsignedNumber(row.ctl_end, UINT16_NULL), true);
    view.setInt16(offset + 6, signedInt16Number(row.tsb_avg), true);
    view.setUint16(offset + 8, unsignedNumber(row.atl_avg, UINT16_NULL), true);
    offset += 10;
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
    bytes.set(quantizeZonePercentages(row), offset);
    offset += POWER_DISTRIBUTION_ZONES.length;
  }

  for (const row of criticalPowers) {
    view.setUint32(offset, periodNumber(row.grp), true);
    view.setUint16(offset + 4, unsignedNumber(row.duration, UINT16_NULL), true);
    view.setUint16(
      offset + 6,
      unsignedNumber(Math.round(Number(row.best_effort_avg_power)), UINT16_NULL),
      true
    );
    view.setUint8(
      offset + 8,
      unsignedNumber(Math.round(Number(row.best_effort_avg_heart_rate)), UINT8_NULL)
    );
    view.setFloat64(offset + 9, finiteNumber(row.best_effort_file_id), true);
    view.setUint32(offset + 17, unsignedNumber(row.start_offset), true);
    view.setUint32(offset + 21, unsignedNumber(row.end_offset), true);
    view.setUint32(offset + 25, fitTimestampSeconds(row.start_time), true);
    offset += CP_ROW_BYTES;
  }

  for (const row of rollingFtp) {
    view.setUint32(offset, periodNumber(row.period), true);
    offset += 4;
    view.setUint16(offset, unsignedNumber(Math.round(Number(row.ftp)), UINT16_NULL), true);
    view.setUint16(offset + 2, unsignedNumber(row.confidence, UINT16_NULL), true);
    view.setUint8(offset + 4, unsignedNumber(row.modelPointCount, UINT8_NULL));
    view.setUint32(offset + 5, fitTimestampSeconds(row.startTime), true);
    offset += 9;
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
      tss_sum: readUint16(view, offset + 4),
      ctl_start: readUint16(view, offset + 6),
      ctl_end: readUint16(view, offset + 8),
      tsb_avg: readInt16(view, offset + 10),
      atl_avg: readUint16(view, offset + 12)
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
    const zonePercentages = {};
    POWER_DISTRIBUTION_ZONES.forEach(({ key }, zoneIndex) => {
      const quantized = view.getUint8(offset + 32 + zoneIndex);
      zonePercentages[key] = (quantized / UINT8_NULL) * 100;
      zoneSeconds[key] = Math.round((values[3] * quantized) / UINT8_NULL);
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
      zonePercentages
    });
    offset += DISTRIBUTION_ROW_BYTES;
  }

  const powerCurveData = {};
  for (let index = 0; index < cpCount; index += 1) {
    const period = String(view.getUint32(offset, true));
    const duration = view.getUint16(offset + 4, true);
    const fileId = view.getFloat64(offset + 9, true);
    const startOffset = view.getUint32(offset + 17, true);
    const endOffset = view.getUint32(offset + 21, true);
    if (!powerCurveData[period]) powerCurveData[period] = {};
    powerCurveData[period][`CP${duration}`] = {
      power: readUint16(view, offset + 6),
      heartRate: readUint8(view, offset + 8),
      fileId: Number.isFinite(fileId) ? String(Math.trunc(fileId)) : null,
      startOffset: startOffset === UINT32_NULL ? null : startOffset,
      endOffset: endOffset === UINT32_NULL ? null : endOffset,
      startTime: isoTimestampFromFitSeconds(view.getUint32(offset + 25, true))
    };
    offset += CP_ROW_BYTES;
  }

  for (let index = 0; index < ftpCount; index += 1) {
    const period = String(view.getUint32(offset, true));
    if (!powerCurveData[period]) powerCurveData[period] = {};
    const confidence = view.getUint16(offset + 6, true);
    const modelPointCount = view.getUint8(offset + 8);
    powerCurveData[period].eFTP = {
      power: readUint16(view, offset + 4),
      confidence: confidence === UINT16_NULL ? null : confidence,
      modelPointCount: modelPointCount === UINT8_NULL ? null : modelPointCount,
      startTime: isoTimestampFromFitSeconds(view.getUint32(offset + 9, true))
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
