export function resolveSessionEndTimeMs(session) {
  const startMs = session?.start_time == null ? NaN : new Date(session.start_time).getTime();
  const endMs = session?.timestamp == null ? NaN : new Date(session.timestamp).getTime();
  const elapsedSeconds = Number(session?.total_elapsed_time);
  if (Number.isFinite(startMs)
    && (!Number.isFinite(endMs) || endMs <= startMs)
    && Number.isFinite(elapsedSeconds)
    && elapsedSeconds > 0) {
    return startMs + elapsedSeconds * 1000;
  }
  return endMs;
}