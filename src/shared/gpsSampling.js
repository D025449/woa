export const DEFAULT_GPS_SAMPLE_RATE_SECONDS = 5;

export function normalizeGpsSampleRateSeconds(sampleRateSeconds, fallback = DEFAULT_GPS_SAMPLE_RATE_SECONDS) {
  const normalizedFallback = Math.max(1, Math.round(Number(fallback) || 1));
  const normalized = Math.round(Number(sampleRateSeconds) || 0);
  return normalized > 0 ? normalized : normalizedFallback;
}
