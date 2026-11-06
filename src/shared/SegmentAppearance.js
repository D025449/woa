export const WORKOUT_ROUTE_COLOR = "#ff4d4f";
export const WORKOUT_ROUTE_THUMBNAIL_STYLE_VERSION = "3";
export const WORKOUT_THUMBNAIL_CACHE_VERSION = "3";

export const SEGMENT_COLORS = Object.freeze({
  criticalPower: Object.freeze({
    solid: "#f59e0b",
    area: "rgba(245, 158, 11, 0.24)"
  }),
  auto: Object.freeze({
    solid: "#2587df",
    area: "rgba(37, 135, 223, 0.26)"
  }),
  microintervals: Object.freeze({ solid: '#7c3aed', area: 'rgba(124, 58, 237, 0.12)' }),
  intervals: Object.freeze({ solid: '#0f8b8d', area: 'rgba(15, 139, 141, 0.16)' }),
  manual: Object.freeze({
    solid: "#ef4444",
    area: "rgba(239, 68, 68, 0.24)"
  }),
  gps: Object.freeze({
    solid: "#22a957",
    area: "rgba(34, 169, 87, 0.25)"
  })
});

export function getSegmentVisibilityKey(segment) {
  if (!segment?.isGPSSegment && segment?.structure_kind === 'intervals') return 'intervals';
  if (!segment?.isGPSSegment && segment?.structure_kind === 'microintervals') return 'microintervals';
  if (segment?.isGPSSegment || segment?.segmenttype === "gps") {
    return "gps";
  }

  if (segment?.segmenttype === "crit") {
    return "criticalPower";
  }

  if (segment?.segmenttype === "auto") {
    return "auto";
  }

  return "manual";
}

export function getSegmentColor(segment, variant = "solid") {
  const colors = SEGMENT_COLORS[getSegmentVisibilityKey(segment)] || SEGMENT_COLORS.manual;
  return colors[variant] || colors.solid;
}

export function buildSegmentHeaderLayout({ segments, isVisible = _segment => true, maxLanes = 10 }) {
  const normalizedMaxLanes = Math.max(1, Number(maxLanes) || 10);
  const candidates = (Array.isArray(segments) ? segments : [])
    .filter(segment => segment?.rowstate !== "DEL" && isVisible(segment))
    .map(segment => ({ segment,
      start: Math.min(Number(segment.start_offset), Number(segment.end_offset)),
      end: Math.max(Number(segment.start_offset), Number(segment.end_offset)) }))
    .filter(({ start, end }) => Number.isFinite(start) && Number.isFinite(end))
    .sort((left, right) => left.start - right.start || right.end - left.end);
  const laneEnds = [];
  const items = candidates.map(candidate => {
    let lane = laneEnds.findIndex(end => end < candidate.start);
    if (lane < 0) lane = laneEnds.length;
    lane = Math.min(lane, normalizedMaxLanes - 1);
    laneEnds[lane] = Math.max(laneEnds[lane] ?? Number.NEGATIVE_INFINITY, candidate.end);
    return { ...candidate, lane };
  });
  return { items, laneCount: Math.min(laneEnds.length, normalizedMaxLanes) };
}

export function buildMicroIntervalPhaseAreas(segment) {
  if (!["intervals", "microintervals"].includes(segment?.structure_kind)) return [];
  return (segment.phases || []).map(phase => [{
    xAxis: phase.start_offset, segmentId: segment.id,
    itemStyle: { color: getSegmentColor(segment), opacity: phase.phase_kind === "work" ? 0.28 : 0.04 },
    label: { show: false }
  }, { xAxis: phase.end_offset + 1 }]);
}
