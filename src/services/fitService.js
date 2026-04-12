import FitParser from "fit-file-parser";
import TypedArrayHelpers from "../shared/TypedArrayHelpers.js";
import IntervalDetector from "../shared/IntervalDetector.js";
import RecordGapFiller from "../shared/RecordGapFiller.js";
import BestEffortDetector from "../shared/BestEffortDetector.js";
import SegmentService from "../shared/SegmentService.js";
import Workout from "../shared/Workout.js";

const LIMITS = {
  Uint8: { min: 0, max: 0xFF },
  Int8: { min: -0x80, max: 0x7F },
  Uint16: { min: 0, max: 0xFFFF },
  Int16: { min: -0x8000, max: 0x7FFF },
  Uint32: { min: 0, max: 0xFFFFFFFF },
  Int32: { min: -0x80000000, max: 0x7FFFFFFF },
};

export default class FitProcessor {



  // -----------------------------
  // DATE / GROUPING
  // -----------------------------
  static getISOWeekUTC(timestamp) {
    const d = new Date(timestamp);
    const date = new Date(Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate()
    ));

    let day = date.getUTCDay();
    if (day === 0) day = 7;

    date.setUTCDate(date.getUTCDate() + 4 - day);

    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);

    return {
      isoYear: date.getUTCFullYear(),
      isoWeek: weekNo
    };
  }

  // -----------------------------
  // FILE MAPPING
  // -----------------------------
  static mapToFileRow(payload, fileMeta, normalized_power) {
    const aggregated = FitProcessor.aggregateSessions(payload);

    if (!aggregated) {
      throw new Error("No sessions found in payload");
    }

    const d = new Date(aggregated.start_time);

    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;
    const quarter = Math.ceil(month / 3);
    const year_Month = Number(`${year}${String(month).padStart(2, '0')}`);

    const { isoYear, isoWeek } = FitProcessor.getISOWeekUTC(aggregated.start_time);
    const yearWeek = Number(`${isoYear}${String(isoWeek).padStart(2, '0')}`);
    const yearQuarter = year * 10 + quarter;

    return {
      ...fileMeta,

      start_time: aggregated.start_time,
      end_time: aggregated.end_time,

      total_elapsed_time: aggregated.total_elapsed_time,
      total_timer_time: aggregated.total_timer_time,

      total_distance: aggregated.total_distance,
      total_cycles: aggregated.total_cycles,
      total_work: aggregated.total_work,
      total_calories: aggregated.total_calories,
      total_ascent: aggregated.total_ascent,
      total_descent: aggregated.total_descent,

      avg_speed: aggregated.avg_speed,
      max_speed: aggregated.max_speed,

      avg_power: aggregated.avg_power,
      avg_normalized_power: Math.round(normalized_power),
      max_power: aggregated.max_power,

      avg_heart_rate: aggregated.avg_heart_rate,
      max_heart_rate: aggregated.max_heart_rate,

      avg_cadence: aggregated.avg_cadence,
      max_cadence: aggregated.max_cadence,

      nec_lat: aggregated.nec_lat,
      nec_long: aggregated.nec_long,
      swc_lat: aggregated.swc_lat,
      swc_long: aggregated.swc_long,

      year,
      month,
      week: isoWeek,
      year_quarter: yearQuarter,
      year_month: year_Month,
      year_week: yearWeek
    };
  }

  // -----------------------------
  // SESSION AGGREGATION
  // -----------------------------
  static aggregateSessions(payload) {
    const sessions = payload.sessions;
    if (!sessions || sessions.length === 0) return null;

    const sum = key => sessions.reduce((acc, s) => acc + (s[key] ?? 0), 0);

    const weightedAvg = key => {
      const totalTime = sum("total_timer_time");
      if (!totalTime) return 0;

      return sessions.reduce(
        (acc, s) => acc + ((s[key] ?? 0) * (s.total_timer_time ?? 0)),
        0
      ) / totalTime;
    };

    const max = key => Math.max(...sessions.map(s => s[key] ?? 0));

    const minDate = key =>
      new Date(Math.min(...sessions.map(s => new Date(s[key]).getTime()))).toISOString();

    const maxDate = key =>
      new Date(Math.max(...sessions.map(s => new Date(s[key]).getTime()))).toISOString();

    const valid = (k) => sessions.map(s => s[k]).filter(v => v != null);

    return {
      start_time: minDate("start_time"),
      end_time: maxDate("timestamp"),

      total_elapsed_time: sum("total_elapsed_time"),
      total_timer_time: sum("total_timer_time"),

      total_distance: sum("total_distance"),
      total_cycles: sum("total_cycles"),
      total_work: sum("total_work"),
      total_calories: sum("total_calories"),
      total_ascent: sum("total_ascent"),
      total_descent: sum("total_descent"),

      avg_speed: weightedAvg("avg_speed"),
      avg_power: weightedAvg("avg_power"),
      avg_heart_rate: weightedAvg("avg_heart_rate"),
      avg_cadence: weightedAvg("avg_cadence"),
      avg_normalized_power: weightedAvg("normalized_power"),

      max_speed: max("max_speed"),
      max_power: max("max_power"),
      max_heart_rate: max("max_heart_rate"),
      max_cadence: max("max_cadence"),

      nec_lat: valid("nec_lat").length ? Math.max(...valid("nec_lat")) : null,
      nec_long: valid("nec_long").length ? Math.max(...valid("nec_long")) : null,
      swc_lat: valid("swc_lat").length ? Math.min(...valid("swc_lat")) : null,
      swc_long: valid("swc_long").length ? Math.min(...valid("swc_long")) : null
    };
  }

  // -----------------------------
  // NORMALIZED POWER
  // -----------------------------
  static calculateNormalizedPower(records) {
    if (!records || records.length === 0) return 0;

    const powers = records.map(r => Math.max(0, Number(r.power) || 0));

    if (powers.length < 30) {
      return Math.round(
        Math.pow(
          powers.reduce((sum, p) => sum + Math.pow(p, 4), 0) / powers.length,
          1 / 4
        )
      );
    }

    const rollingAverages = [];
    let windowSum = 0;

    for (let i = 0; i < powers.length; i++) {
      windowSum += powers[i];

      if (i >= 30) windowSum -= powers[i - 30];

      if (i >= 29) rollingAverages.push(windowSum / 30);
    }

    const meanFourth =
      rollingAverages.reduce((sum, avg) => sum + Math.pow(avg, 4), 0) /
      rollingAverages.length;

    return Math.round(Math.pow(meanFourth, 1 / 4));
  }

  // -----------------------------
  // MAIN PIPELINE
  // -----------------------------
  static processFitRecords(fitFile) {
    const recs = fitFile.records;
    const aggregated = FitProcessor.aggregateSessions(fitFile);

    if (!aggregated) {
      throw new Error("No sessions found in payload");
    }
    const startdate = new Date(aggregated.start_time);

    recs.sort((a, b) => a.timestamp - b.timestamp);

    if (recs?.length < 300) {
      throw new Error("less than five minutes");
    }

    const records = RecordGapFiller.fillGaps(recs);





    const normalized_power = FitProcessor.calculateNormalizedPower(records);

    const gps_track = FitProcessor.cleanGPSAndBuildTrack(records, { sampleRate: 5 });

    const workoutObject = Workout.fromRecords(records, { validGps: gps_track.validGps, startTime: startdate });


    const segments = SegmentService.createSgmentsFromIntervals(
      IntervalDetector.detect(records),
      'auto'
    );

    const segBE = SegmentService.createSgmentsFromIntervals(
      BestEffortDetector.detect(records),
      'crit'
    );

    segments.push(...segBE);

    const recCount = records.length;
    const headerSize = 24;

    const bytes = TypedArrayHelpers.computeSizeForFitRecords(recCount, 0, headerSize);
    const buffer = new ArrayBuffer(bytes);
    const view = new DataView(buffer);

    view.setUint32(0, 0x46544b31);
    view.setUint32(4, 1, true);
    view.setUint32(8, recCount, true);
    view.setUint32(12, (gps_track?.validGps) ? 1 : 0, true);
    view.setBigInt64(16, BigInt(startdate.getTime()), true);


    const [powers, heartRates, cadences, speeds, altitudes, latitudes, longitudes] =
      TypedArrayHelpers.allocateViews(buffer, recCount, 0, headerSize);

    const factor = Math.pow(2, 31) / 180;

    let nn = 0;

    for (const r of records) {

      const power = Math.max(Math.min(Math.round(r.power ?? 0), LIMITS.Uint16.max), LIMITS.Uint16.min);
      const heartRate = Math.max(Math.min(Math.round(r.heart_rate ?? 0), LIMITS.Uint8.max), LIMITS.Uint8.min);
      const cadence = Math.max(Math.min(Math.round(r.cadence ?? 0), LIMITS.Uint8.max), LIMITS.Uint8.min);
      const speed = Math.max(Math.min(Math.round((r.speed ?? 0) * 10), LIMITS.Uint16.max), LIMITS.Uint16.min);
      const altitude = Math.max(Math.min(Math.round((r.altitude ?? 0) * 1000), LIMITS.Uint16.max), LIMITS.Uint16.min);
      const lat = Math.max(Math.min(Math.round(((r.position_lat ?? 0) * factor) / 100), LIMITS.Int32.max), LIMITS.Int32.min);
      const long = Math.max(Math.min(Math.round(((r.position_long ?? 0) * factor) / 100), LIMITS.Int32.max), LIMITS.Int32.min);

      powers[nn] = power;
      heartRates[nn] = heartRate;
      cadences[nn] = cadence;
      speeds[nn] = speed;
      altitudes[nn] = altitude;
      latitudes[nn] = lat;
      longitudes[nn] = long;

      nn++;
    }

    return { buffer, normalized_power, segments, gps_track, powers, heartRates, cadences, speeds, altitudes, workoutObject };
  }

  // -----------------------------
  // GPS CLEANING (unchanged)
  // -----------------------------


  static cleanGPSAndBuildTrack(records, options = {}) {
    const MAX_SPEED = 40;

    const {
      sampleRate = 1,
      precision = 5
    } = options;

    function haversine(a, b) {
      const R = 6371000;
      const toRad = x => x * Math.PI / 180;

      const dLat = toRad(b.position_lat - a.position_lat);
      const dLng = toRad(b.position_long - a.position_long);

      const lat1 = toRad(a.position_lat);
      const lat2 = toRad(b.position_lat);

      const aVal =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1) * Math.cos(lat2) *
        Math.sin(dLng / 2) ** 2;

      return 2 * R * Math.atan2(Math.sqrt(aVal), Math.sqrt(1 - aVal));
    }

    let lastValid = null;

    // -------------------------
    // PASS 1: Clean
    // -------------------------
    for (let i = 0; i < records.length; i++) {
      const r = records[i];

      const invalid =
        r.position_lat == null ||
        r.position_long == null ||
        (r.position_lat === 0 && r.position_long === 0);

      if (invalid) {
        r.position_lat = null;
        r.position_long = null;
        continue;
      }

      if (!lastValid) {
        lastValid = r;
        continue;
      }

      const dist = haversine(lastValid, r);

      if (dist > MAX_SPEED) {
        r.position_lat = null;
        r.position_long = null;
      } else {
        lastValid = r;
      }
    }

    // -------------------------
    // PASS 2: Interpolation
    // -------------------------
    for (let i = 0; i < records.length; i++) {
      const r = records[i];

      if (r.position_lat != null && r.position_long != null) continue;

      let prev = null;
      let next = null;

      for (let j = i - 1; j >= 0; j--) {
        if (records[j].position_lat != null && records[j].position_long != null) {
          prev = records[j];
          break;
        }
      }

      for (let j = i + 1; j < records.length; j++) {
        if (records[j].position_lat != null && records[j].position_long != null) {
          next = records[j];
          break;
        }
      }

      if (prev && next) {
        r.position_lat = (prev.position_lat + next.position_lat) / 2;
        r.position_long = (prev.position_long + next.position_long) / 2;
      } else if (prev) {
        r.position_lat = prev.position_lat;
        r.position_long = prev.position_long;
      } else if (next) {
        r.position_lat = next.position_lat;
        r.position_long = next.position_long;
      }
    }

    // -------------------------
    // PASS 3: Build Output
    // -------------------------
    let minLat = Infinity;
    let maxLat = -Infinity;
    let minLng = Infinity;
    let maxLng = -Infinity;

    let validCount = 0;
    const reduced = [];

    for (let i = 0; i < records.length; i++) {
      const r = records[i];

      if (r.position_lat == null || r.position_long == null) continue;

      validCount++;

      const lat = Number(r.position_lat.toFixed(precision));
      const lng = Number(r.position_long.toFixed(precision));

      // bbox
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;

      if (i % sampleRate === 0) {
        reduced.push([lat, lng]);
      }
    }

    const validGps = validCount > 0;

    // einfacher TrackHash
    const trackHash = validGps
      ? reduced.map(p => p.join(',')).join('|')
      : null;

    return {
      validGps,
      sampleRate,
      bbox: validGps
        ? { minLat, maxLat, minLng, maxLng }
        : null,

      track: reduced,

      trackHash
    };
  }


}

//export const parseFit = FitProcessor.parseFit;
export const mapToFileRow = FitProcessor.mapToFileRow;
export const processFitRecords = FitProcessor.processFitRecords;
