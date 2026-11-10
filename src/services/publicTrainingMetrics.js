// Public REST and MCP services share this retrospective UTC FTP/TSS policy.
export function trainingNumber(value) {
  return ["number", "string"].includes(typeof value) && String(value).trim() !== ""
    && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
}

export function prepareYearlyFtpSeries(rows) {
  return rows.map(row => ({ period: Number(row.period), ftp: trainingNumber(row.ftp) }))
    .filter(row => Number.isInteger(row.period) && row.period >= 1 && row.period <= 9999 && row.ftp > 0)
    .map(row => ({ ...row, time: Date.parse(String(row.period).padStart(4, "0") + "-01-01T00:00:00Z") }))
    .sort((a, b) => a.time - b.time);
}

export function yearlyFtpAt(series, time) {
  if (!Number.isFinite(time) || !series.length || time < series[0].time) return null;
  let low = 0, high = series.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (series[middle].time <= time) low = middle; else high = middle - 1;
  }
  const left = series[low], right = series[low + 1];
  const value = right ? left.ftp + (time - left.time) / (right.time - left.time) * (right.ftp - left.ftp) : left.ftp;
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function derivedCyclingMetrics(powerValue, durationValue, ftpValue, eligible) {
  const power = trainingNumber(powerValue), duration = trainingNumber(durationValue), ftp = trainingNumber(ftpValue);
  const basis = eligible && ftp > 0 ? ftp : null;
  const intensity = basis != null && power != null ? trainingNumber(power / basis) : null;
  const tss = intensity != null && duration != null ? trainingNumber(Math.round(duration / 3600 * intensity ** 2 * 100)) : null;
  return { tss, intensity_factor: intensity, ftp_used_watts: basis };
}
