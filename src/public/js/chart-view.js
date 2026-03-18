import { buildMarkAreas, formatSeconds } from "./chart-helpers.js";

export function createChartView(containerId, handlers = {}) {
  const chart = echarts.init(document.getElementById(containerId));

  const option = {
    title: { text: "..." },
    tooltip: {
      trigger: "axis",
      confine: true,
      alwaysShowContent: false,
      axisPointer: {
        type: "line",
        snap: true
      },
      formatter(params) {
        if (!params || !params.length) return "";

        const p = params.find((x) => x.seriesName === "Power") || params[0];
        const row = p.data;
        if (!row) return "";

        const power = row[1];
        const hr = row[2];
        const cadence = row[3];
        const speed = row[4] != null ? Number(row[4]).toFixed(1) : "-";
        const altitude = row[5] != null ? Number(row[5]).toFixed(1) : "-";

        return `
          ⚡ ${power ?? "-"} W<br/>
          ❤️ ${hr ?? "-"} bpm<br/>
          🔁 ${cadence ?? "-"} rpm<br/>
          🚴 ${speed} km/h<br/>
          ⛰ ${altitude} m
        `;
      }
    },
    animation: false,
    legend: {},
    grid: { top: 80 },
    xAxis: {
      type: "value",
      scale: true,
      minInterval: 1,
      axisLabel: {
        formatter: formatSeconds
      },
      axisPointer: {
        show: true,
        snap: true,
        lineStyle: {
          width: 1,
          type: "solid"
        },
        label: {
          show: true,
          formatter(params) {
            return formatSeconds(params.value);
          }
        }
      }
    },
    yAxis: [
      { type: "value", name: "Power (W)", position: "left" },
      { type: "value", name: "HR/Cad", position: "right" },
      { type: "value", name: "Speed", position: "left", offset: 60 },
      { type: "value", name: "Altitude", position: "right", offset: 60 }
    ],
    dataset: {
      dimensions: [
        "x",
        "Power",
        "Heartrate",
        "Cadence",
        "Speed",
        "Altitude",
        "PowerS5",
        "PowerS15",
        "SpeedS5",
        "AltitudeS7"
      ],
      source: new Float32Array()
    },
    dataZoom: [
      { type: "inside", xAxisIndex: 0, filterMode: "none" },
      { type: "slider", xAxisIndex: 0 }
    ],
    series: [
      {
        name: "Power",
        type: "line",
        showSymbol: false,
        sampling: "lttb",
        yAxisIndex: 0,
        markArea: { data: [] },
        encode: { x: "x", y: "PowerS15" }
      },
      {
        name: "Heartrate",
        type: "line",
        showSymbol: false,
        sampling: "lttb",
        yAxisIndex: 1,
        encode: { x: "x", y: "Heartrate" }
      },
      {
        name: "Cadence",
        type: "line",
        showSymbol: false,
        sampling: "lttb",
        yAxisIndex: 1,
        encode: { x: "x", y: "Cadence" }
      },
      {
        name: "Speed",
        type: "line",
        showSymbol: false,
        sampling: "lttb",
        yAxisIndex: 2,
        encode: { x: "x", y: "SpeedS5" }
      },
      {
        name: "Altitude",
        type: "line",
        showSymbol: false,
        sampling: "lttb",
        yAxisIndex: 3,
        encode: { x: "x", y: "AltitudeS7" }
      }
    ]
  };

  chart.setOption(option);

  registerChartInteractions(chart, handlers);

  function updateWorkout(workout) {
    chart.setOption({
      title: { text: workout.filename },
      xAxis: {
        min: 0,
        max: workout.recCount
      },
      dataset: {
        source: workout.series
      },
      series: [
        {
          name: "Power",
          markArea: {
            data: buildMarkAreas(workout.intervals)
          }
        }
      ]
    });
  }

  function zoomToSegment(start, end) {
    chart.dispatchAction({
      type: "dataZoom",
      startValue: start,
      endValue: end,
      animation: true
    });
  }

  return {
    chart,
    resize: () => chart.resize(),
    showLoading: () => chart.showLoading(),
    hideLoading: () => chart.hideLoading(),
    updateWorkout,
    zoomToSegment
  };
}

function registerChartInteractions(chart, handlers) {
  chart.on("click", (params) => {
    if (params.componentType !== "markArea") return;

    const start = Math.min(params.data.coord[0][0], params.data.coord[1][0]);
    const end = Math.max(params.data.coord[0][0], params.data.coord[1][0]);

    handlers.onZoomSegment?.(start, end);
  });

  chart.getZr().on("mousemove", (params) => {
    const xVal = chart.convertFromPixel({ xAxisIndex: 0 }, params.offsetX);
    if (xVal == null || Number.isNaN(xVal)) return;

    handlers.onChartHoverIndex?.(Math.round(xVal));
  });
}