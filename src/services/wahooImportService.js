import WahooConnectionService from "./wahooConnectionService.js";

function failure(code, statusCode = 502) {
  return Object.assign(new Error("Wahoo import failed"), { code, statusCode });
}
export function validateWahooId(value) {
  if (!["string", "number"].includes(typeof value) || !/^[1-9][0-9]{0,19}$/.test(String(value))) throw failure("wahoo_invalid_id", 400);
  return String(value);
}
export function validateWahooStart(value) {
  if (!["string", "number"].includes(typeof value) || !/^(0|[1-9][0-9]*)$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) % 20 !== 0) {
    throw failure("wahoo_invalid_start", 400);
  }
  return Number(value);
}
export function validateWahooFileUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "cdn.wahooligan.com" || url.port || url.username || url.password || url.hash) {
    throw failure("wahoo_file_unavailable");
  }
  return url.href;
}
export default class WahooImportService {
  static async activities(userId, start = 0) {
    const offset = validateWahooStart(start);
    const payload = await WahooConnectionService.apiRequest(userId, `/v1/workouts?page=${offset / 20 + 1}&per_page=20`);
    if (!Array.isArray(payload?.workouts) || payload.workouts.length > 20) throw failure("wahoo_unavailable");
    return payload.workouts.map(workout => ({
      id: validateWahooId(workout.id),
      name: typeof workout.name === "string" ? workout.name.slice(0, 500) : "",
      startTime: typeof workout.starts === "string" ? workout.starts.slice(0, 100) : "",
      sport: "",
      duration: Number.isFinite(Number(workout.minutes)) && Number(workout.minutes) >= 0 ? Number(workout.minutes) * 60 : 0
    }));
  }
  static async file(userId, activityId) {
    const id = validateWahooId(activityId);
    const summary = await WahooConnectionService.apiRequest(userId, `/v1/workouts/${id}/workout_summary`);
    if (!summary?.file?.url) throw failure("wahoo_file_unavailable");
    const url = validateWahooFileUrl(summary.file.url);
    // CDN requests never receive OAuth credentials or follow redirects.
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(60000) });
    if (!response.ok) { await response.body?.cancel(); throw failure("wahoo_file_unavailable"); }
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 50 * 1024 * 1024) throw failure("wahoo_file_unavailable");
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel(); }
    const data = Buffer.concat(chunks);
    if (data.length < 12 || ![12, 14].includes(data[0]) || data.toString("ascii", 8, 12) !== ".FIT") {
      throw failure("wahoo_file_unavailable");
    }
    return data;
  }
}
