export function formatCPDuration(durationSeconds) {
  return durationSeconds < 60
    ? `CP${durationSeconds}S`
    : `CP${durationSeconds / 60}`;
}

export const CP_SERIES_COLORS = Object.freeze({
  5: '#6D28D9',
  15: '#9333EA',
  60: '#C026D3',
  120: '#DB2777',
  240: '#E11D48',
  360: '#EA580C',
  480: '#F59E0B',
  720: '#84A11D',
  900: '#16A34A',
  960: '#0D9488',
  1800: '#0284C7'
});
const FALLBACK_SERIES_COLOR = '#5470C6';

export function getCPSeriesColor(durationSeconds) {
  return CP_SERIES_COLORS[durationSeconds] || FALLBACK_SERIES_COLOR;
}
