export function buildChartDataZoom({ inside = {} } = {}) {
  return [
    {
      id: "chart-inside-zoom",
      type: "inside",
      xAxisIndex: 0,
      filterMode: "none",
      ...inside
    },
    {
      id: "chart-slider-zoom",
      type: "slider",
      xAxisIndex: 0,
      filterMode: "none",
      realtime: false,
      brushSelect: true
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
