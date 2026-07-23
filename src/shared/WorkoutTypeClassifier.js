const METERS_PER_LATITUDE_DEGREE = 111_320;
const INDOOR_MAX_DISTANCE_METERS = 2_000;

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function gpsSpanMeters(bounds) {
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
  avgCadence = 0,
  gpsPathDistance = null,
  distanceStallActiveRatio = 0,
  longestActiveDistanceStallSeconds = 0,
  movingSpeedKmh = 0,
  roadClimbMinutes = 0,
  longestRoadClimbMinutes = 0,
  roadDescentMinutes = 0,
  longestRoadDescentMinutes = 0,
  roadClimbBeforeDescent = false
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

  if (!validGps && distanceMeters <= INDOOR_MAX_DISTANCE_METERS) return "indoor";

  if (
    !validGps
    && finiteNumber(distanceStallActiveRatio) >= 0.15
    && finiteNumber(longestActiveDistanceStallSeconds) >= 60
    && finiteNumber(movingSpeedKmh) >= 23.5
  ) {
    return "road";
  }

  if (
    !validGps
    && finiteNumber(roadClimbMinutes) >= 20
    && finiteNumber(longestRoadClimbMinutes) >= 10
    && finiteNumber(roadDescentMinutes) >= 3
    && finiteNumber(longestRoadDescentMinutes) >= 3
    && roadClimbBeforeDescent === true
  ) {
    return "road";
  }

  if (validGps) {
    const spanMeters = gpsSpanMeters(bounds);
    if (distanceMeters <= INDOOR_MAX_DISTANCE_METERS && spanMeters <= 250) return "indoor";
    const measuredGpsPathMeters = Math.max(0, finiteNumber(gpsPathDistance));
    if (
      distanceMeters >= 5_000
      && spanMeters <= 250
      && measuredGpsPathMeters > 0
      && distanceMeters / measuredGpsPathMeters >= 5
    ) {
      return "indoor";
    }
    if (spanMeters <= 250) return "unknown";
  }

  if (distanceKm < 5 || speedKmh <= 0) return "unknown";

  if (
    validGps
    && speedKmh <= 24
    && ascentPerKm >= 15
    && finiteNumber(roadClimbMinutes) >= 20
    && finiteNumber(longestRoadClimbMinutes) >= 10
    && finiteNumber(roadDescentMinutes) >= 3
    && roadClimbBeforeDescent === true
  ) {
    return "mountain";
  }

  if ((speedKmh <= 23.5 && ascentPerKm >= 14)
    || (speedKmh <= 21 && ascentPerKm >= 12)
    || (speedKmh <= 18 && ascentPerKm >= 6)) {
    return "mountain";
  }

  if (speedKmh >= 24 || (speedKmh >= 20 && ascentPerKm < 12)) return "road";

  return "unknown";
}

export function classifyFitWorkoutType({ sport = null, subSport = null } = {}) {
  const normalizedSport = typeof sport === "string" ? sport.toLowerCase() : Number(sport);
  const normalizedSubSport = typeof subSport === "string" ? subSport.toLowerCase() : Number(subSport);
  const isCycling = sport == null || normalizedSport === 2 || normalizedSport === "cycling";
  if (!isCycling) return "unknown";

  if ([5, 6, "spin", "indoor_cycling"].includes(normalizedSubSport)) return "indoor";
  if ([7, 13, "road", "track_cycling"].includes(normalizedSubSport)) return "road";
  if ([8, 9, 47, "mountain", "downhill", "e_bike_mountain"].includes(normalizedSubSport)) return "mountain";
  return "unknown";
}

export function classifyWorkoutTypeWithFitFallback(input = {}) {
  const inferredType = classifyWorkoutType(input);
  return inferredType === "unknown" ? classifyFitWorkoutType(input) : inferredType;
}

export default classifyWorkoutType;
