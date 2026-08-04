function getIsoWeekUtc(timestamp) {
  const source = new Date(timestamp);
  const date = new Date(Date.UTC(
    source.getUTCFullYear(),
    source.getUTCMonth(),
    source.getUTCDate()
  ));

  let day = date.getUTCDay();
  if (day === 0) {
    day = 7;
  }

  date.setUTCDate(date.getUTCDate() + 4 - day);

  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const isoWeek = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);

  return {
    isoYear: date.getUTCFullYear(),
    isoWeek
  };
}

export function aggregateWorkoutSessions(payload) {
  const sessions = Array.isArray(payload) ? payload : payload?.sessions;
  if (!Array.isArray(sessions) || sessions.length === 0) {
    return null;
  }

  const sum = (key) => sessions.reduce((total, session) => total + (session[key] ?? 0), 0);
  const weightedAverage = (key) => {
    const totalTime = sum("total_timer_time");
    if (!totalTime) {
      return 0;
    }

    return sessions.reduce(
      (total, session) => total + ((session[key] ?? 0) * (session.total_timer_time ?? 0)),
      0
    ) / totalTime;
  };
  const maximum = (key) => Math.max(...sessions.map((session) => session[key] ?? 0));
  const minimumDate = (key) => new Date(Math.min(
    ...sessions.map((session) => new Date(session[key]).getTime())
  )).toISOString();
  const maximumDate = (key) => new Date(Math.max(
    ...sessions.map((session) => new Date(session[key]).getTime())
  )).toISOString();
  const validValues = (key) => sessions
    .map((session) => session[key])
    .filter((value) => value != null);

  return {
    start_time: minimumDate("start_time"),
    end_time: maximumDate("timestamp"),
    total_elapsed_time: sum("total_elapsed_time"),
    total_timer_time: sum("total_timer_time"),
    total_distance: sum("total_distance"),
    total_cycles: sum("total_cycles"),
    total_work: sum("total_work"),
    total_calories: sum("total_calories"),
    total_ascent: sum("total_ascent"),
    total_descent: sum("total_descent"),
    avg_speed: weightedAverage("avg_speed"),
    avg_power: weightedAverage("avg_power"),
    avg_heart_rate: weightedAverage("avg_heart_rate"),
    avg_cadence: weightedAverage("avg_cadence"),
    avg_normalized_power: weightedAverage("normalized_power"),
    max_speed: maximum("max_speed"),
    max_power: maximum("max_power"),
    max_heart_rate: maximum("max_heart_rate"),
    max_cadence: maximum("max_cadence"),
    nec_lat: validValues("nec_lat").length ? Math.max(...validValues("nec_lat")) : null,
    nec_long: validValues("nec_long").length ? Math.max(...validValues("nec_long")) : null,
    swc_lat: validValues("swc_lat").length ? Math.min(...validValues("swc_lat")) : null,
    swc_long: validValues("swc_long").length ? Math.min(...validValues("swc_long")) : null
  };
}

export function mapWorkoutSummaryToFileRow(aggregated, fileMeta, normalizedPower) {
  if (!aggregated) {
    throw new Error("No sessions found in payload");
  }

  const speedMsToKmh = (value) => Number.isFinite(value) ? value * 3.6 : 0;
  const sessionAverageSpeed = Number(aggregated.avg_speed);
  const distanceMeters = Number(aggregated.total_distance);
  const durationSeconds = Number(aggregated.total_timer_time);
  const averageSpeedMs = Number.isFinite(sessionAverageSpeed) && sessionAverageSpeed > 0
    ? sessionAverageSpeed
    : Number.isFinite(distanceMeters) && distanceMeters > 0
      && Number.isFinite(durationSeconds) && durationSeconds > 0
      ? distanceMeters / durationSeconds
      : 0;
  const date = new Date(aggregated.start_time);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const quarter = Math.ceil(month / 3);
  const yearMonth = Number(`${year}${String(month).padStart(2, "0")}`);
  const { isoYear, isoWeek } = getIsoWeekUtc(aggregated.start_time);

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
    avg_speed: speedMsToKmh(averageSpeedMs),
    max_speed: speedMsToKmh(aggregated.max_speed),
    avg_power: aggregated.avg_power,
    avg_normalized_power: Math.round(normalizedPower),
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
    year_quarter: year * 10 + quarter,
    year_month: yearMonth,
    year_week: Number(`${isoYear}${String(isoWeek).padStart(2, "0")}`)
  };
}
