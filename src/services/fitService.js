import IntervalDetector from "../shared/IntervalDetector.js";
import RecordGapFiller from "../shared/RecordGapFiller.js";
import BestEffortDetector from "../shared/BestEffortDetector.js";
import SegmentService from "../shared/SegmentService.js";
import Workout from "../shared/Workout.js";

const IMPORT_TIMING_DEBUG = String(process.env.IMPORT_TIMING_DEBUG || "").trim() === "1";

export default class FitProcessor {
  static extractImportGpsSource(fitFile) {
    const sessions = Array.isArray(fitFile?.sessions) ? fitFile.sessions : [];
    const hasManualGpsFlag = sessions.some((session) => {
      const value = session?.woa_manual_gps;
      return value === 1 || value === true || value === "1";
    });

    return hasManualGpsFlag ? "manual_lookup" : null;
  }

  static createStepLogger(scope, meta = {}) {
    const startedAt = Date.now();
    let lastAt = startedAt;
    const steps = [];

    return {
      steps,
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
        if (!IMPORT_TIMING_DEBUG) {
          return;
        }
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
  static processFitRecords(fitFile, options = {}) {
    const timing = FitProcessor.createStepLogger("fit.process-fit-records", {
      sourceName: options?.sourceName ?? null,
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

    FitProcessor.cleanAltitude(records, {
      sourceName: options?.sourceName ?? null
    });
    timing.mark("clean-altitude");

    if (process.env.ALTITUDE_IMPORT_DEBUG === "1") {
      console.log("[altitude-record-stats]", {
        sourceName: options?.sourceName ?? null,
        stage: "post-clean-records",
        ...FitProcessor.describeAltitudeRecordStats(records)
      });
    }

    const gps_track = FitProcessor.cleanGPSAndBuildTrack(records, {
      sampleRate: 5,
      sourceName: options?.sourceName ?? null
    });
    timing.mark("clean-gps-build-track", {
      gpsPointCount: gps_track?.track?.length ?? 0,
      validGps: !!gps_track?.validGps
    });

    const workoutObject = Workout.fromRecords(records, { validGps: gps_track.validGps, startTime: startdate });
    timing.mark("workout-from-records");

    if (process.env.ALTITUDE_IMPORT_DEBUG === "1") {
      console.log("[altitude-workout-stats]", {
        sourceName: options?.sourceName ?? null,
        stage: "post-workout-from-records",
        ...FitProcessor.describeWorkoutAltitudeStats(workoutObject)
      });
    }

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
      workoutObject,
      importGpsSource: FitProcessor.extractImportGpsSource(fitFile),
      timingSteps: Array.isArray(timing?.steps)
        ? timing.steps.map((step) => ({
            label: step.label,
            stepMs: Number(step.stepMs || 0)
          }))
        : []
    };
  }

  // -----------------------------
  // ALTITUDE CLEANING
  // -----------------------------
  static cleanAltitude(records, options = {}) {
    const {
      minAltitude = -500,
      maxAltitude = 9000,
      maxStepPerSecond = 25,
      sourceName = null
    } = options;

    const debugEnabled = process.env.ALTITUDE_IMPORT_DEBUG === "1";
    const diagnostics = {
      sourceName,
      totalRecords: Array.isArray(records) ? records.length : 0,
      rawFiniteCount: 0,
      rawZeroCount: 0,
      rawNullishCount: 0,
      normalizedNullCount: 0,
      spikeRejectedCount: 0,
      interpolatedCount: 0,
      carriedFromPrevCount: 0,
      carriedFromNextCount: 0,
      forcedZeroFallbackCount: 0,
      finalFiniteCount: 0,
      finalZeroCount: 0
    };

    const toFinite = (value) => {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    };

    for (let i = 0; i < records.length; i++) {
      const rawAlt = toFinite(records[i]?.altitude);
      if (rawAlt == null) {
        diagnostics.rawNullishCount += 1;
      } else {
        diagnostics.rawFiniteCount += 1;
        if (rawAlt === 0) {
          diagnostics.rawZeroCount += 1;
        }
      }

      const alt = rawAlt;
      records[i].altitude = (alt == null || alt < minAltitude || alt > maxAltitude) ? null : alt;
      if (records[i].altitude == null) {
        diagnostics.normalizedNullCount += 1;
      }
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
        diagnostics.spikeRejectedCount += 1;
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
        diagnostics.interpolatedCount += 1;
      } else if (Number.isFinite(prevAlt)) {
        records[i].altitude = prevAlt;
        diagnostics.carriedFromPrevCount += 1;
      } else if (Number.isFinite(nextAlt)) {
        records[i].altitude = nextAlt;
        diagnostics.carriedFromNextCount += 1;
      } else {
        records[i].altitude = 0;
        diagnostics.forcedZeroFallbackCount += 1;
      }
    }

    for (let i = 0; i < records.length; i++) {
      const alt = toFinite(records[i]?.altitude);
      if (alt == null) {
        continue;
      }
      diagnostics.finalFiniteCount += 1;
      if (alt === 0) {
        diagnostics.finalZeroCount += 1;
      }
    }

    if (
      debugEnabled ||
      diagnostics.forcedZeroFallbackCount > 0 ||
      (diagnostics.rawFiniteCount > 0 && diagnostics.finalZeroCount > diagnostics.rawZeroCount)
    ) {
      console.log("[altitude-cleaning]", diagnostics);
    }
  }

  static describeAltitudeRecordStats(records = []) {
    const altitudes = (Array.isArray(records) ? records : [])
      .map((record) => Number(record?.altitude))
      .filter((value) => Number.isFinite(value));

    if (!altitudes.length) {
      return {
        count: 0,
        zeroCount: 0,
        min: null,
        max: null,
        first: null,
        last: null
      };
    }

    return {
      count: altitudes.length,
      zeroCount: altitudes.filter((value) => value === 0).length,
      min: Math.min(...altitudes),
      max: Math.max(...altitudes),
      first: altitudes[0],
      last: altitudes[altitudes.length - 1]
    };
  }

  static describeWorkoutAltitudeStats(workoutObject) {
    if (!workoutObject || !Number.isInteger(workoutObject.length) || workoutObject.length <= 0) {
      return {
        count: 0,
        zeroCount: 0,
        min: null,
        max: null,
        first: null,
        last: null
      };
    }

    const altitudes = [];
    for (let i = 0; i < workoutObject.length; i++) {
      const value = Number(workoutObject.getAltitudeAt(i));
      if (Number.isFinite(value)) {
        altitudes.push(value);
      }
    }

    if (!altitudes.length) {
      return {
        count: 0,
        zeroCount: 0,
        min: null,
        max: null,
        first: null,
        last: null
      };
    }

    return {
      count: altitudes.length,
      zeroCount: altitudes.filter((value) => value === 0).length,
      min: Math.min(...altitudes),
      max: Math.max(...altitudes),
      first: altitudes[0],
      last: altitudes[altitudes.length - 1]
    };
  }

  // -----------------------------
  // GPS CLEANING (unchanged)
  // -----------------------------


  static cleanGPSAndBuildTrack(records, options = {}) {
    const MAX_STEP_DISTANCE_METERS = 40;
    const MIN_RELOCK_SEQUENCE = 3;
    const MAX_INTERPOLATION_GAP = 8;
    const DEG_TO_RAD = Math.PI / 180;
    const EARTH_RADIUS_METERS = 6371000;

    const {
      sampleRate = 1,
      precision = 5,
      sourceName = null
    } = options;

    const debugEnabled = process.env.GPS_IMPORT_DEBUG === "1";
    const diagnostics = {
      sourceName,
      totalRecords: records.length,
      initialInvalidCount: 0,
      jumpRejectedCount: 0,
      firstJumpRejectedIndex: null,
      firstJumpRejectedTimestamp: null,
      maxAcceptedDistanceMeters: 0,
      maxRejectedDistanceMeters: 0,
      interpolatedBetweenCount: 0,
      carriedFromPrevCount: 0,
      carriedFromNextCount: 0,
      trailingConstantTailLength: 0,
      trailingConstantTailStartIndex: null,
      suspiciousConstantTail: false
    };

    function haversine(a, b) {
      const dLat = (b.position_lat - a.position_lat) * DEG_TO_RAD;
      const dLng = (b.position_long - a.position_long) * DEG_TO_RAD;

      const lat1 = a.position_lat * DEG_TO_RAD;
      const lat2 = b.position_lat * DEG_TO_RAD;

      const aVal =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1) * Math.cos(lat2) *
        Math.sin(dLng / 2) ** 2;

      return 2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(aVal), Math.sqrt(1 - aVal));
    }

    const rawPositions = new Array(records.length);
    for (let i = 0; i < records.length; i++) {
      rawPositions[i] = {
        position_lat: records[i].position_lat,
        position_long: records[i].position_long
      };
    }

    let lastValid = null;
    let relockCandidate = [];

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
        diagnostics.initialInvalidCount += 1;
        r.position_lat = null;
        r.position_long = null;
        continue;
      }

      if (!lastValid) {
        lastValid = r;
        continue;
      }

      const dist = haversine(lastValid, r);
      if (dist <= MAX_STEP_DISTANCE_METERS) {
        diagnostics.maxAcceptedDistanceMeters = Math.max(diagnostics.maxAcceptedDistanceMeters, dist);
        lastValid = r;
        relockCandidate = [];
        continue;
      }

      diagnostics.maxRejectedDistanceMeters = Math.max(diagnostics.maxRejectedDistanceMeters, dist);
      if (diagnostics.firstJumpRejectedIndex == null) {
        diagnostics.firstJumpRejectedIndex = i;
        diagnostics.firstJumpRejectedTimestamp = r.timestamp ?? null;
      }
      const rawCandidate = {
        index: i,
        timestamp: r.timestamp ?? null,
        position_lat: Number(rawPositions[i].position_lat),
        position_long: Number(rawPositions[i].position_long)
      };

      rawCandidate.position_lat = Number.isFinite(rawCandidate.position_lat) ? rawCandidate.position_lat : null;
      rawCandidate.position_long = Number.isFinite(rawCandidate.position_long) ? rawCandidate.position_long : null;

      diagnostics.jumpRejectedCount += 1;
      r.position_lat = null;
      r.position_long = null;

      if (rawCandidate.position_lat == null || rawCandidate.position_long == null) {
        relockCandidate = [];
        continue;
      }

      if (relockCandidate.length === 0) {
        relockCandidate.push(rawCandidate);
        continue;
      }

      const prevCandidate = relockCandidate[relockCandidate.length - 1];
      const candidateDist = haversine(prevCandidate, rawCandidate);

      if (candidateDist <= MAX_STEP_DISTANCE_METERS) {
        relockCandidate.push(rawCandidate);
      } else {
        relockCandidate = [rawCandidate];
      }

      if (relockCandidate.length >= MIN_RELOCK_SEQUENCE) {
        diagnostics.relockCount = (diagnostics.relockCount ?? 0) + 1;
        diagnostics.lastRelockIndex = i;
        diagnostics.lastRelockTimestamp = r.timestamp ?? null;

        for (const candidate of relockCandidate) {
          const target = records[candidate.index];
          target.position_lat = candidate.position_lat;
          target.position_long = candidate.position_long;
          diagnostics.recoveredPointCount = (diagnostics.recoveredPointCount ?? 0) + 1;
        }

        lastValid = records[relockCandidate[relockCandidate.length - 1].index];
        diagnostics.maxAcceptedDistanceMeters = Math.max(diagnostics.maxAcceptedDistanceMeters, candidateDist);
        relockCandidate = [];
      }
    }

    // -------------------------
    // PASS 2: Interpolation
    // -------------------------
    const prevValidIndex = new Array(records.length).fill(-1);
    const nextValidIndex = new Array(records.length).fill(-1);
    let lastValidIndex = -1;

    for (let i = 0; i < records.length; i++) {
      prevValidIndex[i] = lastValidIndex;
      if (records[i].position_lat != null && records[i].position_long != null) {
        lastValidIndex = i;
      }
    }

    let nextIndex = -1;
    for (let i = records.length - 1; i >= 0; i--) {
      nextValidIndex[i] = nextIndex;
      if (records[i].position_lat != null && records[i].position_long != null) {
        nextIndex = i;
      }
    }

    let currentGapLength = 0;
    for (let i = 0; i < records.length; i++) {
      const r = records[i];

      if (r.position_lat != null && r.position_long != null) {
        currentGapLength = 0;
        continue;
      }

      currentGapLength += 1;

      const prev = prevValidIndex[i] >= 0 ? records[prevValidIndex[i]] : null;
      const next = nextValidIndex[i] >= 0 ? records[nextValidIndex[i]] : null;

      const canBridgeGap = prev && next && currentGapLength <= MAX_INTERPOLATION_GAP;

      if (canBridgeGap) {
        diagnostics.interpolatedBetweenCount += 1;
        r.position_lat = (prev.position_lat + next.position_lat) / 2;
        r.position_long = (prev.position_long + next.position_long) / 2;
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

    const validGps = reduced.length >= 2;

    let trailingConstantTailLength = 0;
    for (let i = records.length - 1; i > 0; i--) {
      const current = records[i];
      const previous = records[i - 1];
      if (
        current?.position_lat == null ||
        current?.position_long == null ||
        previous?.position_lat == null ||
        previous?.position_long == null
      ) {
        break;
      }

      if (
        current.position_lat === previous.position_lat &&
        current.position_long === previous.position_long
      ) {
        trailingConstantTailLength += 1;
        continue;
      }

      break;
    }

    diagnostics.trailingConstantTailLength = trailingConstantTailLength;
    diagnostics.trailingConstantTailStartIndex =
      trailingConstantTailLength > 0 ? records.length - trailingConstantTailLength - 1 : null;
    diagnostics.suspiciousConstantTail =
      trailingConstantTailLength >= Math.max(25, Math.floor(records.length * 0.05));

    if (debugEnabled) {
      console.log("[gps-cleaning]", {
        ...diagnostics,
        sampleRate,
        precision,
        validGps,
        validCount,
        reducedTrackPointCount: reduced.length
      });
    }

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
