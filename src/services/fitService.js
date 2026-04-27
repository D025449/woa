import IntervalDetector from "../shared/IntervalDetector.js";
import RecordGapFiller from "../shared/RecordGapFiller.js";
import BestEffortDetector from "../shared/BestEffortDetector.js";
import SegmentService from "../shared/SegmentService.js";
import Workout from "../shared/Workout.js";

export default class FitProcessor {

  static createStepLogger(scope, meta = {}) {
    const startedAt = Date.now();
    let lastAt = startedAt;
    const steps = [];

    return {
      mark(label, extra = {}) {
        const now = Date.now();
        steps.push({
          label,
          stepMs: now - lastAt,
          totalMs: now - startedAt,
          ...extra
        });
        lastAt = now;
      },
      flush(extra = {}) {
        console.log(`[timing] ${scope}`, {
          ...meta,
          totalMs: Date.now() - startedAt,
          steps,
          ...extra
        });
      }
    };
  }



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

    return FitProcessor.mapAggregatedToFileRow(aggregated, fileMeta, normalized_power);
  }

  static mapAggregatedToFileRow(aggregated, fileMeta, normalized_power) {
    const speedMsToKmh = (value) => {
      if (!Number.isFinite(value)) {
        return 0;
      }
      return value * 3.6;
    };

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

      avg_speed: speedMsToKmh(aggregated.avg_speed),
      max_speed: speedMsToKmh(aggregated.max_speed),

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
  // MAIN PIPELINE
  // -----------------------------
  static processFitRecords(fitFile) {
    const timing = FitProcessor.createStepLogger("fit.process-fit-records", {
      recordCount: fitFile?.records?.length ?? 0,
      sessionCount: fitFile?.sessions?.length ?? 0
    });
    const recs = fitFile.records;
    const aggregated = FitProcessor.aggregateSessions(fitFile);
    timing.mark("aggregate-sessions");

    if (!aggregated) {
      timing.flush({
        status: "failed",
        error: "No sessions found in payload"
      });
      throw new Error("No sessions found in payload");
    }
    const startdate = new Date(aggregated.start_time);

    recs.sort((a, b) => a.timestamp - b.timestamp);
    timing.mark("sort-records");

    if (recs?.length < 300) {
      timing.flush({
        status: "failed",
        error: "less than five minutes"
      });
      throw new Error("less than five minutes");
    }

    const records = RecordGapFiller.fillGaps(recs);
    timing.mark("fill-gaps", {
      filledRecordCount: records.length
    });

    FitProcessor.cleanAltitude(records);
    timing.mark("clean-altitude");

    const gps_track = FitProcessor.cleanGPSAndBuildTrack(records, { sampleRate: 5 });
    timing.mark("clean-gps-build-track", {
      gpsPointCount: gps_track?.track?.length ?? 0,
      validGps: !!gps_track?.validGps
    });

    const workoutObject = Workout.fromRecords(records, { validGps: gps_track.validGps, startTime: startdate });
    timing.mark("workout-from-records");

    const segments = SegmentService.createSgmentsFromIntervals(
      IntervalDetector.detect(records),
      'auto'
    );
    timing.mark("detect-auto-segments", {
      autoSegmentCount: segments.length
    });

    const segBE = SegmentService.createSgmentsFromIntervals(
      BestEffortDetector.detect(records),
      'crit'
    );
    timing.mark("detect-best-efforts", {
      bestEffortSegmentCount: segBE.length
    });

    segments.push(...segBE);
    timing.mark("merge-segments", {
      segmentCount: segments.length
    });

    timing.flush({
      status: "completed",
      validGps: !!gps_track?.validGps,
      gpsPointCount: gps_track?.track?.length ?? 0,
      segmentCount: segments.length
    });

    return {
      aggregated,
      segments,
      gps_track,
      workoutObject
    };
  }

  // -----------------------------
  // ALTITUDE CLEANING
  // -----------------------------
  static cleanAltitude(records, options = {}) {
    const {
      minAltitude = -500,
      maxAltitude = 9000,
      maxStepPerSecond = 25
    } = options;

    const toFinite = (value) => {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    };

    for (let i = 0; i < records.length; i++) {
      const alt = toFinite(records[i]?.altitude);
      records[i].altitude = (alt == null || alt < minAltitude || alt > maxAltitude) ? null : alt;
    }

    for (let i = 1; i < records.length - 1; i++) {
      const prev = records[i - 1]?.altitude;
      const cur = records[i]?.altitude;
      const next = records[i + 1]?.altitude;

      if (!Number.isFinite(prev) || !Number.isFinite(cur) || !Number.isFinite(next)) {
        continue;
      }

      const prevDelta = Math.abs(cur - prev);
      const nextDelta = Math.abs(cur - next);
      const neighborDelta = Math.abs(next - prev);

      if (
        prevDelta > maxStepPerSecond &&
        nextDelta > maxStepPerSecond &&
        neighborDelta <= maxStepPerSecond
      ) {
        records[i].altitude = null;
      }
    }

    for (let i = 0; i < records.length; i++) {
      if (Number.isFinite(records[i]?.altitude)) {
        continue;
      }

      let prevIdx = i - 1;
      while (prevIdx >= 0 && !Number.isFinite(records[prevIdx]?.altitude)) {
        prevIdx -= 1;
      }

      let nextIdx = i + 1;
      while (nextIdx < records.length && !Number.isFinite(records[nextIdx]?.altitude)) {
        nextIdx += 1;
      }

      const prevAlt = prevIdx >= 0 ? records[prevIdx].altitude : null;
      const nextAlt = nextIdx < records.length ? records[nextIdx].altitude : null;

      if (Number.isFinite(prevAlt) && Number.isFinite(nextAlt)) {
        const t = (i - prevIdx) / (nextIdx - prevIdx);
        records[i].altitude = prevAlt + ((nextAlt - prevAlt) * t);
      } else if (Number.isFinite(prevAlt)) {
        records[i].altitude = prevAlt;
      } else if (Number.isFinite(nextAlt)) {
        records[i].altitude = nextAlt;
      } else {
        records[i].altitude = 0;
      }
    }
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
export const mapAggregatedToFileRow = FitProcessor.mapAggregatedToFileRow;
export const processFitRecords = FitProcessor.processFitRecords;
