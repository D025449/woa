

import FitParser from "fit-file-parser";
import { TypedArrayHelpers } from "../shared/TypedArrayHelpers.js";
import { IntervalDetector } from "../shared/IntervalDetector.js";
import { RecordGapFiller } from "../shared/RecordGapFiller.js";
import { BestEffortDetector } from "../shared/BestEffortDetector.js";
import { SegmentService } from "../shared/SegmentService.js";

const LIMITS = {
  Uint8: { min: 0, max: 0xFF },
  Int8: { min: -0x80, max: 0x7F },
  Uint16: { min: 0, max: 0xFFFF },
  Int16: { min: -0x8000, max: 0x7FFF },
  Uint32: { min: 0, max: 0xFFFFFFFF },
  Int32: { min: -0x80000000, max: 0x7FFFFFFF },
};

function parseFit(buffer) {
  return new Promise((resolve, reject) => {
    const parser = new FitParser(
      {
        force: true,
        speedUnit: "km/h",
        lengthUnit: "km",
        temperatureUnit: "celcius",
        elapsedRecordField: true,
        mode: "list"
      }

    );

    parser.parse(buffer, (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });
}

function getISOWeekUTC(timestamp) {
  const d = new Date(timestamp);
  const date = new Date(Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate()
  ));

  // ISO: Montag = 1, Sonntag = 7
  let day = date.getUTCDay();
  if (day === 0) day = 7;

  // auf Donnerstag der aktuellen Woche schieben
  date.setUTCDate(date.getUTCDate() + 4 - day);

  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);

  return {
    isoYear: date.getUTCFullYear(),
    isoWeek: weekNo
  };
}



function mapToFileRow(payload, fileMeta, normalized_power) {
  const aggregated = aggregateSessions(payload);

  if (!aggregated) {
    throw new Error("No sessions found in payload");
  }

  const d = new Date(aggregated.start_time);

  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const quarter = Math.ceil(month / 3);
  const year_Month = new Number(`${year}${String(month).padStart(2, '0')}`);

  const { isoYear, isoWeek } = getISOWeekUTC(aggregated.start_time);
  const yearWeek = new Number(`${isoYear}${String(isoWeek).padStart(2, '0')}`);
  const yearQuarter = year * 10 + quarter;

  /*
    year                INTEGER,
    month               INTEGER,
    week                INTEGER,
    year_quarter        INTEGER,
    year_month          INTEGER,
    year_week           INTEGER,

  */




  //console.log({ yearMonth, yearWeek, iso_Year, iso_Week });

  return {
    // --- File Metadaten
    auth_sub: fileMeta.auth_sub,
    original_filename: fileMeta.original_filename,
    s3_key: fileMeta.s3_key,
    mime_type: fileMeta.mime_type,
    file_size: fileMeta.file_size,

    // --- Aggregierte Session-Daten
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

    year: year,
    month: month,
    week: isoWeek,
    year_quarter: yearQuarter,
    year_month: year_Month,
    year_week: yearWeek



  };
}

function aggregateSessions(payload) {
  const sessions = payload.sessions;
  if (!sessions || sessions.length === 0) return null;

  // --- Summe eines numerischen Feldes
  const sum = key =>
    sessions.reduce((acc, s) => acc + (s[key] ?? 0), 0);

  // --- Zeitgewichteter Durchschnitt
  const weightedAvg = key => {
    const totalTime = sum("total_timer_time");
    if (!totalTime) return 0;

    return sessions.reduce(
      (acc, s) =>
        acc + ((s[key] ?? 0) * (s.total_timer_time ?? 0)),
      0
    ) / totalTime;
  };

  // --- Maximum eines Feldes
  const max = key =>
    Math.max(...sessions.map(s => s[key] ?? 0));

  // --- Globale Start-/Endzeit
  const minDate = key =>
    new Date(
      Math.min(...sessions.map(s => new Date(s[key]).getTime()))
    ).toISOString();

  const maxDate = key =>
    new Date(
      Math.max(...sessions.map(s => new Date(s[key]).getTime()))
    ).toISOString();

  // --- Bounding Box (null-safe)
  const validNecLat = sessions.map(s => s.nec_lat).filter(v => v != null);
  const validNecLong = sessions.map(s => s.nec_long).filter(v => v != null);
  const validSwcLat = sessions.map(s => s.swc_lat).filter(v => v != null);
  const validSwcLong = sessions.map(s => s.swc_long).filter(v => v != null);

  return {
    // Zeit
    start_time: minDate("start_time"),
    end_time: maxDate("timestamp"),

    total_elapsed_time: sum("total_elapsed_time"),
    total_timer_time: sum("total_timer_time"),

    // Summen
    total_distance: sum("total_distance"),
    total_cycles: sum("total_cycles"),
    total_work: sum("total_work"),
    total_calories: sum("total_calories"),
    total_ascent: sum("total_ascent"),
    total_descent: sum("total_descent"),

    // Durchschnitt (zeitgewichtet)
    avg_speed: weightedAvg("avg_speed"),
    avg_power: weightedAvg("avg_power"),
    avg_heart_rate: weightedAvg("avg_heart_rate"),
    avg_cadence: weightedAvg("avg_cadence"),
    avg_normalized_power: weightedAvg("normalized_power"),

    // Maxima
    max_speed: max("max_speed"),
    max_power: max("max_power"),
    max_heart_rate: max("max_heart_rate"),
    max_cadence: max("max_cadence"),

    // Bounding Box
    nec_lat: validNecLat.length ? Math.max(...validNecLat) : null,
    nec_long: validNecLong.length ? Math.max(...validNecLong) : null,
    swc_lat: validSwcLat.length ? Math.min(...validSwcLat) : null,
    swc_long: validSwcLong.length ? Math.min(...validSwcLong) : null
  };
}


function semicirclesToDegrees(semicircles) {
  return semicircles * (180 / Math.pow(2, 31));
}

function extractGpsTrack(fitJson) {
  const records = fitJson.records || [];

  const track = records
    .filter(r =>
      typeof r.position_lat === "number" &&
      typeof r.position_long === "number"
    )
    .map(r => ({
      timestamp: r.timestamp,
      latitude: r.position_lat,
      longitude: r.position_long
    }));

  return track;
}

function extractCleanGpsTrack(payload, options = {}) {
  const {
    maxSpeedKmh = 60,
    maxJumpMeters = 200
  } = options;

  if (!payload || !Array.isArray(payload.records)) return [];

  const rawPoints = payload.records
    .filter(r =>
      typeof r.position_lat === "number" &&
      typeof r.position_long === "number" &&
      r.timestamp
    )
    .map(r => ({
      timestamp: new Date(r.timestamp),
      lat: r.position_lat,
      lon: r.position_long
    }));

  if (rawPoints.length === 0) return [];

  const cleaned = [rawPoints[0]];

  for (let i = 1; i < rawPoints.length; i++) {
    const prev = cleaned[cleaned.length - 1];
    const curr = rawPoints[i];

    const distance = haversineDistance(
      prev.lat,
      prev.lon,
      curr.lat,
      curr.lon
    );

    const timeDiffSec =
      (curr.timestamp - prev.timestamp) / 1000;

    if (timeDiffSec <= 0) continue;

    const speedKmh = (distance / timeDiffSec) * 3.6;

    const isJump = distance > maxJumpMeters && timeDiffSec <= 2;
    const isTooFast = speedKmh > maxSpeedKmh;

    if (!isJump && !isTooFast) {
      cleaned.push(curr);
    }
  }

  return cleaned.map(p => ({
    timestamp: p.timestamp.toISOString(),
    latitude: p.lat,
    longitude: p.lon
  }));
}


function toGoogleMapsPath(track) {
  return track.map(p => ({
    lat: p.latitude,
    lng: p.longitude
  }));
}

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000; // Erdradius in Meter
  const toRad = deg => deg * (Math.PI / 180);

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
    Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) ** 2;

  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/*
FIT Records
     ↓
Detect Gap
     ↓
Smart Resample
     ↓
Pause Detection
     ↓
Power Smoothing
     ↓
30s Rolling Average
     ↓
Normalized Power
     ↓
Dataset für Chart
*/

function getRecordCount(records, maxSmartGap = 5) {

  let prevT = null;
  let nn = 0;
  const startTime = records[0].timestamp;
  for (const r of records) {
    const t = Math.round((r.timestamp - startTime) / 1000);

    if (prevT !== null && t === prevT) {
      continue;
    }
    if (prevT !== null) {

      const gap = t - prevT;

      if (gap > 1 && gap <= maxSmartGap) {
        for (let s = 1; s < gap; s++) {
          nn++;
        }
      }
    }
    nn++;
    prevT = t;
  }
  return nn;
}
function calculateNormalizedPower(records) {
  if (!records || records.length === 0) return 0;

  const powers = records.map(r => Math.max(0, Number(r.power) || 0));

  // Für echte NP braucht man mindestens 30 Sekunden
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

    if (i >= 30) {
      windowSum -= powers[i - 30];
    }

    if (i >= 29) {
      rollingAverages.push(windowSum / 30);
    }
  }

  let fourthPowerSum = 0;
  for (const avg of rollingAverages) {
    fourthPowerSum += Math.pow(avg, 4);
  }

  const meanFourthPower = fourthPowerSum / rollingAverages.length;
  const normalizedPower = Math.pow(meanFourthPower, 1 / 4);

  return Math.round(normalizedPower);
}

function processFitRecords(recs) {

  // ----------------------------------
  // Sortieren (FIT kann out-of-order sein)
  // ----------------------------------
  recs.sort((a, b) => a.timestamp - b.timestamp);
  if (recs?.length < 300)
  {
      throw new Error("less than five minutes");
  }
  
  // -------------------------
  // smap gaps füllen:
  // -------------------------
  const records = RecordGapFiller.fillGaps(recs);

  const normalized_power = calculateNormalizedPower(records);




  //const intervals = IntervalDetector.detect(records);
  const segments = SegmentService.createSgmentsFromIntervals(IntervalDetector.detect(records));
  //intervals = [];

  const bestEfforts = BestEffortDetector.detect(records);



  //const intervals = IntervalDetector.detect(powers, heartRates);
  if (segments.length > 32) {
    //console.log(intervals);
    console.log({ intlen: segments.length });
  }



  const maxSmartGap = 5;
  const recCount = records.length;// - 1;// getRecordCount(records, maxSmartGap) - 1;

  const headerSize = 16; // Uint32 record count

  //const bytes = TypedArrayHelpers.computeSizeForFitRecords(recCount, intervals.length, headerSize);
  const bytes = TypedArrayHelpers.computeSizeForFitRecords(recCount, 0, headerSize); 
  const buffer = new ArrayBuffer(bytes);
  const view = new DataView(buffer);

  view.setUint32(0, 0x46544b31); // "FTK1"
  view.setUint32(4, 1, true); // Version 
  view.setUint32(8, recCount, true);

  //view.setUint32(12, intervals.length, true); // 0: with out delta 1: with delta
  view.setUint32(12, 0, true); // 0: with out delta 1: with delta




  //const [powers, heartRates, cadences, speeds, altitudes, latitudes, longitudes, starts, ends, durations, intpowers, intHeartRates, intSpeeds] = TypedArrayHelpers.allocateViews(buffer, recCount, intervals.length, headerSize);
  const [powers, heartRates, cadences, speeds, altitudes, latitudes, longitudes] = TypedArrayHelpers.allocateViews(buffer, recCount, 0, headerSize);
  /*IntervalDetector.writeIntervalsToArrays(
    intervals,
    starts,
    ends,
    durations,
    intpowers,
    intHeartRates,
    intSpeeds,
    10
  );*/


  /*let lastPower = 0;
  let lastHeartRate = 0;
  let lastCadence = 0;
  let lastSpeed = 0;
  let lastAltitude = 0;
  let lastLat = 0;
  let lastLong = 0;*/

  const factor = Math.pow(2, 31) / 180;

  let nn = 0;
  // let first = true;
  /*
  //            { type: Int32Array, length: 7 },  //bases for delta
              { type: Uint16Array, length: recCount }, //dxPw
              { type: Uint8Array, length: recCount }, // hr
              { type: Uint8Array, length: recCount },// cad
              { type: Uint16Array, length: recCount }, //sp
              { type: Int16Array, length: recCount }, // alt
  */

  for (const r of records) {
    // ===== Normalisierung + Fallback =====
    const power = Math.max(Math.min(Math.round(r.power ?? 0), LIMITS.Uint16.max), LIMITS.Uint16.min);
    const heartRate = Math.max(Math.min(Math.round(r.heart_rate ?? 0), LIMITS.Uint8.max), LIMITS.Uint8.min);
    const cadence = Math.max(Math.min(Math.round(r.cadence ?? 0), LIMITS.Uint8.max), LIMITS.Uint8.min);
    const speed = Math.max(Math.min(Math.round((r.speed ?? 0) * 10), LIMITS.Uint16.max), LIMITS.Uint16.min);   // kmh*10
    const altitude = Math.max(Math.min(Math.round((r.altitude ?? 0) * 1000), LIMITS.Uint16.max), LIMITS.Uint16.min);  // meters

    const lat = Math.max(Math.min(Math.round(((r.position_lat ?? 0) * factor) / 100), LIMITS.Int32.max), LIMITS.Int32.min);
    const long = Math.max(Math.min(Math.round(((r.position_long ?? 0) * factor) / 100), LIMITS.Int32.max), LIMITS.Int32.min);

    // ===== First Record → Base Values =====
    /*if (first) {
      baseValues[0] = power;
      baseValues[1] = heartRate;
      baseValues[2] = cadence;
      baseValues[3] = speed;
      baseValues[4] = altitude;
      baseValues[5] = lat;
      baseValues[6] = long;

      first = false;
    } else {*/

    // ===== Deltas schreiben =====
    powers[nn] = power;
    heartRates[nn] = heartRate;
    cadences[nn] = cadence;
    speeds[nn] = speed;
    altitudes[nn] = altitude;
    latitudes[nn] = lat;
    longitudes[nn] = long;

    nn++;
  }

  // ===== State updaten =====
  /*lastPower = power;
  lastHeartRate = heartRate;
  lastCadence = cadence;
  lastSpeed = speed;
  lastAltitude = altitude;
  lastLat = lat;
  lastLong = long;*/
  //}


  return {buffer, normalized_power, bestEfforts, segments};
}




export {
  parseFit,
  extractGpsTrack,
  extractCleanGpsTrack,
  toGoogleMapsPath,
  aggregateSessions,
  mapToFileRow,
  processFitRecords
};