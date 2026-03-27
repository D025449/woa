import { TypedArrayHelpers } from "/shared/TypedArrayHelpers.js";
import { SegmentService } from "../../shared/SegmentService.js";

export async function deleteWorkoutByRow(row) {
  const data = row.getData();
  const workoutId = data.id;
  const filename = data.original_filename || `Workout ${workoutId}`;

  const ok = window.confirm(`Workout wirklich löschen?\n\n${filename}`);
  if (!ok) return;

  const response = await fetch(`/files/workouts/${workoutId}`, {
    method: "DELETE"
  });

  if (response.status === 401) {
    window.location.href = "/";
    return;
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Delete fehlgeschlagen (${response.status})`);
  }

  await row.delete();
}

export async function loadWorkoutByRow(row) {
  const x = row;
  console.log(x);
  //return 'A';
  const wid = getWorkoutId(row);
  const metaResponse = await fetch(`/files/workouts/${wid}/data`);
  if (metaResponse.status === 401) {
    // Session abgelaufen → redirect
    window.location.href = '/login';
    return;
  }
  else {
    const { url } = await metaResponse.json();
    const response = await fetch(url);
    const buffer = await response.arrayBuffer();
    const workout = { id: wid, ...parseWorkoutBuffer(buffer, '') };
    await SegmentService.fetchSegments(workout);
    return workout;



    //const segs = await fetchSegments(wid);

    /*const manualIntervals = [];
    for (let i = 0; i < segs.length; ++i) {
      const seg = segs[i];
      manualIntervals.push(
        {
          start: seg.start_index,
          end: seg.end_index,
          power: seg.power,
          heartrate: seg.heartrate,
          duration: seg.duration,
          position: seg.position,
          segmenttype: seg.segmenttype           
        }

      );

    }*/


    //return {manualIntervals, id: wid, ...parseWorkoutBuffer(buffer, '') };// filename);    
  }


}

/*async function fetchSegments(workoutId) {
  const res = await fetch(`/files/workouts/${workoutId}/segments`);

  if (!res.ok) {
    throw new Error("Failed to load segments");
  }

  const json = await res.json();

  return json.data; // <- wichtig
}*/

function getWorkoutId(rowOrData) {
  // 🟢 Tabulator sicher erkennen
  if (rowOrData && typeof rowOrData.getData === 'function') {
    const d = rowOrData.getData();
    return d.fileId ?? d.id;
  }

  // 🔵 Plain Object (ECharts)
  if (rowOrData && typeof rowOrData === 'object') {
    return rowOrData.fileId ?? rowOrData.id;
  }

  console.warn("Unknown type:", rowOrData);
  return null;
}

function movingAverageCentered(values, windowSize = 10) {
  const out = new Array(values.length);
  const halfLeft = Math.floor((windowSize - 1) / 2);
  const halfRight = windowSize - 1 - halfLeft;

  for (let i = 0; i < values.length; i++) {
    const start = Math.max(0, i - halfLeft);
    const end = Math.min(values.length - 1, i + halfRight);

    let sum = 0;
    for (let j = start; j <= end; j++) {
      sum += values[j];
    }

    out[i] = Math.round(sum / (end - start + 1));
  }

  return out;
}

function smoothTypedArrayInPlace(arr, windowSize = 10) {
  const n = arr.length;
  if (n === 0) return arr;
  if (windowSize <= 1) return arr;

  const tmp = new Float64Array(n);
  let sum = 0;

  for (let i = 0; i < n; i++) {
    sum += arr[i];

    if (i >= windowSize) {
      sum -= arr[i - windowSize];
    }

    const divisor = Math.min(i + 1, windowSize);
    tmp[i] = sum / divisor;
  }

  // zurück ins Originalarray schreiben
  for (let i = 0; i < n; i++) {
    arr[i] = Math.round(tmp[i]);
  }

  return arr;
}


function parseWorkoutBuffer(buffer, filename) {
  const view = new DataView(buffer);

  const recCount = view.getUint32(8, true);
  let intervalCount = view.getUint32(12, true);
  if (intervalCount > 256) intervalCount = 0;

  const headerSize = 16;

  const [
    powers,
    heartRates,
    cadences,
    speeds,
    altitudes,
    latitudes,
    longitudes,
    starts,
    ends,
    durations,
    intpowers,
    intHeartRates,
    intSpeeds
  ] = TypedArrayHelpers.allocateViews(buffer, recCount, intervalCount, headerSize);



  const { series, STRIDE } = buildWorkoutSeries(
    recCount,
    movingAverageCentered(powers, 50),
    movingAverageCentered(heartRates, 50),
    movingAverageCentered(cadences, 50),
    movingAverageCentered(speeds, 50),
    altitudes
  );

  return {
    filename,
    recCount,
    series,
    STRIDE,
    intervals: {
      count: intervalCount,
      starts,
      ends,
      durations,
      powers: intpowers,
      heartRates: intHeartRates,
      speeds: intSpeeds
    },
    track: {
      deltalat: latitudes,
      deltalong: longitudes,
      recCount
    }
  };
}

function buildWorkoutSeries(
  recCount,
  powers,
  heartRates,
  cadences,
  speeds,
  altitudes
) {
  const STRIDE = 10;
  const WIN5 = 5;
  const WIN15 = 15;
  const WIN_SPEED = 15;
  const WIN_ALTITUDE = 7;

  let sumPower5 = 0;
  let sumPower15 = 0;
  let sumSpeed5 = 0;
  let sumAltitude7 = 0;

  const data = new Float32Array((recCount) * STRIDE);

  let idx = 0;
  /*const basePower = baseValues[0];
  const baseHeartRate = baseValues[1];
  const baseCadence = baseValues[2];
  const baseSpeed = baseValues[3] / 10;
  const baseAltitude = baseValues[4];*/

  /*data[idx] = 0;
  data[idx + 1] = basePower;
  data[idx + 2] = baseHeartRate;
  data[idx + 3] = baseCadence;
  data[idx + 4] = baseSpeed;
  data[idx + 5] = baseAltitude;

  sumPower5 = basePower;
  sumPower15 = basePower;
  sumSpeed5 = baseSpeed;
  sumAltitude7 = baseAltitude;

  data[idx + 6] = basePower;
  data[idx + 7] = basePower;
  data[idx + 8] = baseSpeed;
  data[idx + 9] = baseAltitude;*/

  for (let i = 0; i < recCount; i++) {
    idx = (i + 0) * STRIDE;
    //  const prev = i * STRIDE;

    const power = powers[i];
    const heartRate = heartRates[i];
    const cadence = cadences[i];
    const speed = speeds[i] / 10;
    const altitude = altitudes[i];

    data[idx] = i;  // xaxis
    data[idx + 1] = power;
    data[idx + 2] = heartRate;
    data[idx + 3] = cadence;
    data[idx + 4] = speed;
    data[idx + 5] = altitude;

    sumPower5 += power;
    if (i + 1 >= WIN5) {
      sumPower5 -= data[(i + 1 - WIN5) * STRIDE + 1];
    }
    data[idx + 6] = sumPower5 / Math.min(i + 2, WIN5);

    sumPower15 += power;
    if (i + 1 >= WIN15) {
      sumPower15 -= data[(i + 1 - WIN15) * STRIDE + 1];
    }
    data[idx + 7] = sumPower15 / Math.min(i + 2, WIN15);

    sumSpeed5 += speed;
    if (i + 1 >= WIN_SPEED) {
      sumSpeed5 -= data[(i + 1 - WIN_SPEED) * STRIDE + 4];
    }
    data[idx + 8] = sumSpeed5 / Math.min(i + 2, WIN_SPEED);

    sumAltitude7 += altitude;
    if (i + 1 >= WIN_ALTITUDE) {
      sumAltitude7 -= data[(i + 1 - WIN_ALTITUDE) * STRIDE + 5];
    }
    data[idx + 9] = sumAltitude7 / Math.min(i + 2, WIN_ALTITUDE);
  }

  return { series: data, STRIDE };
}