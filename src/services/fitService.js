

import FitParser from "fit-file-parser";
import { TypedArrayHelpers } from "../shared/TypedArrayHelpers.js";

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

function mapToFileRow(payload, fileMeta) {
  const aggregated = aggregateSessions(payload);

  if (!aggregated) {
    throw new Error("No sessions found in payload");
  }

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
    avg_normalized_power: Math.round(aggregated.avg_normalized_power),

    max_power: aggregated.max_power,

    avg_heart_rate: aggregated.avg_heart_rate,
    max_heart_rate: aggregated.max_heart_rate,

    avg_cadence: aggregated.avg_cadence,
    max_cadence: aggregated.max_cadence,

    nec_lat: aggregated.nec_lat,
    nec_long: aggregated.nec_long,
    swc_lat: aggregated.swc_lat,
    swc_long: aggregated.swc_long
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

function processFitRecords(records) {

  if (!records || records.length === 0) {
    return { data: [], normalizedPower: 0 };
  }

  // ----------------------------------
  // Sortieren (FIT kann out-of-order sein)
  // ----------------------------------

  records.sort((a, b) => a.timestamp - b.timestamp);

  const result = [];

  const startTime = records[0].timestamp;

  const maxSmartGap = 5;
  const smoothingAlpha = 0.25;

  let prevT = null;

  let lastPower = 0;
  let lastHeartRate = 0;
  let lastCadence = 0;
  let lastSpeed = 0;
  let lastAltitude = 0;
  let lastLat = 0;
  let lastLong = 0;

  let ema = 0;

  // rolling 30s power
  const roll30 = new Array(30).fill(0);
  let rollIndex = 0;
  let rollSum = 0;
  let rollCount = 0;

  let npSum = 0;
  let npCount = 0;

  for (const r of records) {

    // -------------------------------
    // Zeit → Sekunden
    // -------------------------------

    const t = Math.round((r.timestamp - startTime) / 1000);

    if (prevT !== null && t === prevT) {
      continue;
    }

    // -------------------------------
    // Forward Fill Sensoren
    // -------------------------------

    const power = r.power ?? lastPower ?? 0;
    const heartRate = r.heart_rate ?? lastHeartRate ?? 0;
    const cadence = r.cadence ?? lastCadence ?? 0;
    const speed = r.speed ?? lastSpeed ?? 0;
    const altitude = r.altitude ?? lastAltitude ?? 0;
    const lat = r.position_lat ?? lastLat ?? 0;
    const long = r.position_long ?? lastLong ?? 0;
    // -------------------------------
    // Gap Behandlung
    // -------------------------------

    if (prevT !== null) {

      const gap = t - prevT;

      if (gap > 1 && gap <= maxSmartGap) {

        for (let s = 1; s < gap; s++) {

          const tt = prevT + s;

          // smoothing
          ema = power === 0 ? ema : smoothingAlpha * power + (1 - smoothingAlpha) * ema;

          // rolling30
          rollSum -= roll30[rollIndex];
          roll30[rollIndex] = power;
          rollSum += power;

          rollIndex = (rollIndex + 1) % 30;

          if (rollCount < 30) rollCount++;

          const avg30 = rollSum / rollCount;

          const p4 = avg30 * avg30 * avg30 * avg30;

          npSum += p4;
          npCount++;

          result.push([
            //tt,
            power,
            heartRate,
            cadence,
            Math.round(speed * 10) / 10,
            Math.round(ema)
          ]);
        }
      }

      else if (gap > maxSmartGap) {

        /*result.push([
          //prevT + 1,
          NaN,
          NaN,
          NaN,
          NaN,
          NaN
        ]);*/
      }
    }

    // -------------------------------
    // Zero-Aware Smoothing
    // -------------------------------

    ema = power === 0
      ? ema
      : smoothingAlpha * power + (1 - smoothingAlpha) * ema;

    // -------------------------------
    // Rolling 30s
    // -------------------------------

    rollSum -= roll30[rollIndex];
    roll30[rollIndex] = power;
    rollSum += power;

    rollIndex = (rollIndex + 1) % 30;

    if (rollCount < 30) rollCount++;

    const avg30 = rollSum / rollCount;

    const p4 = avg30 * avg30 * avg30 * avg30;

    npSum += p4;
    npCount++;

    // -------------------------------
    // Chart Record
    // -------------------------------

    result.push([
      //  t,
      power,
      heartRate,
      cadence,
      Math.round(speed * 10) / 10,
      Math.round(ema)
    ]);

    // -------------------------------

    lastPower = power;
    lastHeartRate = heartRate;
    lastCadence = cadence;
    lastSpeed = speed;
    lastAltitude = altitude;
    lastLat = lat;
    lastLong = long;

    prevT = t;
  }

  // ----------------------------------
  // Normalized Power
  // ----------------------------------

  const normalizedPower =
    npCount === 0
      ? 0
      : Math.round(Math.pow(npSum / npCount, 0.25));

  return {
    data: result,
    normalizedPower
  };
}

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


function processFitRecords_v2(records) {

  // ----------------------------------
  // Sortieren (FIT kann out-of-order sein)
  // ----------------------------------

  records.sort((a, b) => a.timestamp - b.timestamp);

  const maxSmartGap = 5;
  const recCount = getRecordCount(records, maxSmartGap) - 1;


  const headerSize = 12; // Uint32 record count

  const bytes = TypedArrayHelpers.computeSizeForFitRecords(recCount, headerSize);



  /*const bytes = 
    headerSize +
    7 * Int32Array.BYTES_PER_ELEMENT + // Base
    recCount * Int16Array.BYTES_PER_ELEMENT + // power
    recCount * Int8Array.BYTES_PER_ELEMENT + // cadence
    recCount * Int8Array.BYTES_PER_ELEMENT + // hr
    recCount * Int8Array.BYTES_PER_ELEMENT + // speed
    recCount * Int8Array.BYTES_PER_ELEMENT + // altitude
    recCount * Int32Array.BYTES_PER_ELEMENT + // lat
    recCount * Int32Array.BYTES_PER_ELEMENT;  // lon*/


  const buffer = new ArrayBuffer(bytes);
  const view = new DataView(buffer);

  view.setUint32(0, 0x46544b31); // "FTK1"
  view.setUint16(4, 1, true); // Version 
  view.setUint32(6, recCount, true);
  view.setUint16(10, 1, true); // 0: with out delta 1: with delta


  const [baseValues, powers, heartRates, cadences, speeds, altitudes, latitudes, longitudes] = TypedArrayHelpers.allocateViews(buffer, recCount, headerSize);


  /*let offset = headerSize;


  const baseValues = new Int32Array(buffer, offset, 7);
  offset += baseValues.byteLength;




  const powers = new Int16Array(buffer, offset, recCount);
  offset += powers.byteLength;

  const heartRates = new Int8Array(buffer, offset, recCount);
  offset += heartRates.byteLength;

  const cadences = new Int8Array(buffer, offset, recCount);
  offset += cadences.byteLength;

  const speeds = new Int8Array(buffer, offset, recCount);
  offset += speeds.byteLength;

  const altitudes = new Int8Array(buffer, offset, recCount);
  offset += altitudes.byteLength;

  const latitudes = new Int32Array(buffer, offset, recCount);
  offset += latitudes.byteLength;

  const longitudes = new Int32Array(buffer, offset, recCount);*/




  const startTime = records[0].timestamp;
  let prevT = null;
  let lastPower = 0;
  let lastHeartRate = 0;
  let lastCadence = 0;
  let lastSpeed = 0;
  let lastAltitude = 0;
  let lastLat = 0;
  let lastLong = 0;
  let nn = 0;

  const factor = Math.pow(2, 31) / 180;
  let idx = 0;

  for (const r of records) {

    // -------------------------------
    // Zeit → Sekunden
    // -------------------------------

    const t = Math.round((r.timestamp - startTime) / 1000);

    if (prevT !== null && t === prevT) {
      continue;
    }



    // -------------------------------
    // Forward Fill Sensoren
    // -------------------------------

    const power = Math.round(r.power ?? lastPower ?? 0);
    const heartRate = Math.round(r.heart_rate ?? lastHeartRate ?? 0);
    const cadence = Math.round(r.cadence ?? lastCadence ?? 0);
    const speed = Math.round((r.speed ?? lastSpeed ?? 0) * 10);
    const altitude = Math.round(r.altitude * 1000 ?? lastAltitude ?? 0);
    const lat = Math.round((r.position_lat ?? lastLat ?? 0) * factor / 100); // 0.9m exactness
    const long = Math.round((r.position_long ?? lastLong ?? 0) * factor / 100);





    // -------------------------------
    // Gap Behandlung
    // -------------------------------

    if (prevT !== null) {

      const gap = t - prevT;

      if (gap > 1 && gap <= maxSmartGap) {

        for (let s = 1; s < gap; s++) {
          powers[nn] = 0;
          heartRates[nn] = 0;
          cadences[nn] = 0;
          speeds[nn] = 0;
          altitudes[nn] = 0;
          latitudes[nn] = 0;
          longitudes[nn++] = 0;
          ++idx;

        }
      }
    }
    if (idx > 0) {
      powers[nn] = power - lastPower;
      heartRates[nn] = heartRate - lastHeartRate;
      cadences[nn] = cadence - lastCadence;
      speeds[nn] = speed - lastSpeed;
      altitudes[nn] = altitude - lastAltitude;
      latitudes[nn] = lat - lastLat;
      longitudes[nn++] = long - lastLong;
      ++idx;
    }
    else {
      baseValues[0] = power;
      baseValues[1] = heartRate;
      baseValues[2] = cadence;
      baseValues[3] = speed;
      baseValues[4] = altitude;
      baseValues[5] = lat;
      baseValues[6] = long;
      ++idx;
    }

    // -------------------------------

    lastPower = power;
    lastHeartRate = heartRate;
    lastCadence = cadence;
    lastSpeed = speed;
    lastAltitude = altitude;
    lastLat = lat;
    lastLong = long;

    prevT = t;
  }


  return buffer;
}




export {
  parseFit,
  extractGpsTrack,
  extractCleanGpsTrack,
  toGoogleMapsPath,
  aggregateSessions,
  mapToFileRow,
  processFitRecords,
  processFitRecords_v2
};