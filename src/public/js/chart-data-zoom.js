export function buildChartDataZoom({
  inside = {},
  slider = {},
  filterMode = "none",
  xAxisIndex = 0
} = {}) {
  return [
    {
      id: "chart-inside-zoom",
      type: "inside",
      xAxisIndex,
      filterMode,
      ...inside
    },
    {
      id: "chart-slider-zoom",
      type: "slider",
      xAxisIndex,
      filterMode,
      realtime: false,
      brushSelect: true,
      ...slider
    }
  ];
}

export function readChartZoomRange(chart) {
  const zoom = chart?.getOption?.()?.dataZoom?.[0] || {};
  const start = Number(zoom.start);
  const end = Number(zoom.end);
  return {
    start: Number.isFinite(start) ? start : 0,
    end: Number.isFinite(end) ? end : 100
  };
}
