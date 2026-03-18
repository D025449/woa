import { TypedArrayHelpers } from "/shared/TypedArrayHelpers.js";

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
  const { id: workoutId, original_filename: filename } = row.getData();

  const metaResponse = await fetch(`/files/workouts/${workoutId}/data`);
  const { url } = await metaResponse.json();

  const response = await fetch(url);
  const buffer = await response.arrayBuffer();

  return parseWorkoutBuffer(buffer, filename);
}

function parseWorkoutBuffer(buffer, filename) {
  const view = new DataView(buffer);

  const recCount = view.getUint32(8, true);
  let intervalCount = view.getUint32(12, true);
  if (intervalCount > 256) intervalCount = 0;

  const headerSize = 16;

  const [
    baseValues,
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

  const series = buildWorkoutSeries(
    recCount,
    baseValues,
    powers,
    heartRates,
    cadences,
    speeds,
    altitudes
  );

  return {
    filename,
    recCount,
    series,
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
      baselat: baseValues[5],
      baselong: baseValues[6],
      deltalat: latitudes,
      deltalong: longitudes,
      recCount
    }
  };
}

function buildWorkoutSeries(
  recCount,
  baseValues,
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

  const data = new Float32Array((recCount + 1) * STRIDE);

  let idx = 0;
  const basePower = baseValues[0];
  const baseHeartRate = baseValues[1];
  const baseCadence = baseValues[2];
  const baseSpeed = baseValues[3] / 10;
  const baseAltitude = baseValues[4];

  data[idx] = 0;
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
  data[idx + 9] = baseAltitude;

  for (let i = 0; i < recCount; i++) {
    idx = (i + 1) * STRIDE;
    const prev = i * STRIDE;

    const power = data[prev + 1] + powers[i];
    const heartRate = data[prev + 2] + heartRates[i];
    const cadence = data[prev + 3] + cadences[i];
    const speed = data[prev + 4] + speeds[i] / 10;
    const altitude = data[prev + 5] + altitudes[i];

    data[idx] = i + 1;
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

  return data;
}