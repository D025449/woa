const METERS_PER_LATITUDE_DEGREE = 111_320;

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function gpsSpanMeters(bounds) {
  if (!bounds) return 0;

  const minLat = finiteNumber(bounds.minLat, Number.NaN);
  const maxLat = finiteNumber(bounds.maxLat, Number.NaN);
  const minLng = finiteNumber(bounds.minLng, Number.NaN);
  const maxLng = finiteNumber(bounds.maxLng, Number.NaN);
  if (![minLat, maxLat, minLng, maxLng].every(Number.isFinite)) return 0;

  const latitudeMeters = Math.abs(maxLat - minLat) * METERS_PER_LATITUDE_DEGREE;
  const middleLatitudeRadians = ((minLat + maxLat) * 0.5) * Math.PI / 180;
  const longitudeMeters = Math.abs(maxLng - minLng)
    * METERS_PER_LATITUDE_DEGREE
    * Math.max(0.01, Math.cos(middleLatitudeRadians));
  return Math.hypot(latitudeMeters, longitudeMeters);
}

export function classifyWorkoutType({
  validGps = false,
  bounds = null,
  totalDistance = 0,
  totalTimerTime = 0,
  totalAscent = 0,
  avgSpeed = 0,
  avgPower = 0,
  avgCadence = 0
} = {}) {
  const distanceMeters = Math.max(0, finiteNumber(totalDistance));
  const durationSeconds = Math.max(0, finiteNumber(totalTimerTime));
  const ascentMeters = Math.max(0, finiteNumber(totalAscent));
  const speedKmh = Math.max(0, finiteNumber(avgSpeed));
  const distanceKm = distanceMeters / 1000;
  const ascentPerKm = distanceKm > 0 ? ascentMeters / distanceKm : 0;
  const hasTrainingSignal = distanceMeters >= 1000
    || finiteNumber(avgPower) > 0
    || finiteNumber(avgCadence) > 0;

  if (durationSeconds < 300 || !hasTrainingSignal) return "unknown";

  if (!validGps) return "indoor";

  const spanMeters = gpsSpanMeters(bounds);
  if (distanceMeters >= 5000 && spanMeters > 0 && spanMeters <= 250) return "indoor";

  if (distanceKm < 5 || speedKmh <= 0) return "unknown";

  if ((speedKmh <= 21 && ascentPerKm >= 12)
    || (speedKmh <= 18 && ascentPerKm >= 6)) {
    return "mountain";
  }

  if (speedKmh >= 24 || (speedKmh >= 20 && ascentPerKm < 12)) return "road";

  return "unknown";
}

export default classifyWorkoutType;
