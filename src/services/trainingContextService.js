import { FileDBService } from "./fileDBService.js";

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function sum(values) {
  return values.reduce((acc, value) => acc + safeNumber(value, 0), 0);
}

export default class TrainingContextService {
  static async buildUserContext(userId) {
    const [ctlAtlSeries, ftpSeries, workoutsResult] = await Promise.all([
      FileDBService.getCTLATL(userId, "date"),
      FileDBService.getFTPValues(userId, "year"),
      FileDBService.getWorkoutsByUser(
        userId,
        1,
        90,
        [{ field: "start_time", dir: "desc" }],
        [],
        "mine"
      )
    ]);

    const workouts = Array.isArray(workoutsResult?.data) ? workoutsResult.data : [];
    const latestLoad = Array.isArray(ctlAtlSeries) && ctlAtlSeries.length > 0
      ? ctlAtlSeries[ctlAtlSeries.length - 1]
      : null;
    const latestFtpPoint = Array.isArray(ftpSeries) && ftpSeries.length > 0
      ? ftpSeries[ftpSeries.length - 1]
      : null;

    const last7 = workouts.slice(0, 7);
    const last28 = workouts.slice(0, 28);

    const totalHours7d = sum(last7.map((workout) => safeNumber(workout.total_timer_time, 0) / 3600));
    const totalHours28d = sum(last28.map((workout) => safeNumber(workout.total_timer_time, 0) / 3600));
    const totalTss7d = sum(last7.map((workout) => workout.TSS));
    const totalTss28d = sum(last28.map((workout) => workout.TSS));

    const recentPowerTargets = last28
      .filter((workout) => safeNumber(workout.avg_power, 0) > 0)
      .slice(0, 5)
      .map((workout) => ({
        id: workout.id,
        date: workout.start_time,
        avgPower: Math.round(safeNumber(workout.avg_power, 0)),
        np: Math.round(safeNumber(workout.avg_normalized_power, 0)),
        durationHours: round1(safeNumber(workout.total_timer_time, 0) / 3600)
      }));

    return {
      latestLoad: latestLoad
        ? {
            date: latestLoad.date,
            ctl: safeNumber(latestLoad.ctl, 0),
            atl: safeNumber(latestLoad.atl, 0),
            tsb: safeNumber(latestLoad.tsb, 0),
            tss: safeNumber(latestLoad.tss, 0)
          }
        : null,
      latestFtp: latestFtpPoint
        ? {
            period: latestFtpPoint.period,
            ftp: Math.round(safeNumber(latestFtpPoint.ftp, 0)),
            cp8: Math.round(safeNumber(latestFtpPoint.cp8, 0)),
            cp15: Math.round(safeNumber(latestFtpPoint.cp15, 0)),
            confidence: safeNumber(latestFtpPoint.confidence, 0)
          }
        : null,
      workoutCount: safeNumber(workoutsResult?.total_records, workouts.length),
      recentVolume: {
        hours7d: round1(totalHours7d),
        hours28d: round1(totalHours28d),
        tss7d: Math.round(totalTss7d),
        tss28d: Math.round(totalTss28d)
      },
      recentPowerTargets
    };
  }
}
