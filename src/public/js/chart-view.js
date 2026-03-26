import { buildMarkAreas, buildMarkAreasCP, formatSeconds, storeSegments } from "./chart-helpers.js";

let selectionStart = null;
let currentWorkout = null;
let manualIntervals = [];
let isSegmentMode = false;

export function createChartView(containerId, handlers = {}) {
  const chart = echarts.init(document.getElementById(containerId));
  document.getElementById('draw-segment-toggle')?.addEventListener('click', async (e) => {
    isSegmentMode = !isSegmentMode;

    e.target.classList.toggle('btn-primary', isSegmentMode);
    e.target.classList.toggle('btn-outline-primary', !isSegmentMode);

    setDrawingMode( isSegmentMode );

  });
  document.getElementById('save-segments')?.addEventListener('click', async (e) => {
     const wid = currentWorkout.id;
     storeSegments(wid, manualIntervals);

    /*isSegmentMode = !isSegmentMode;

    e.target.classList.toggle('btn-primary', isSegmentMode);
    e.target.classList.toggle('btn-outline-primary', !isSegmentMode);

    setDrawingMode( isSegmentMode );*/

  });
  
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
    if (currentWorkout !== null && currentWorkout.startDate != workout.startDate) {
      currentWorkout = workout;
      manualIntervals = workout.manualIntervals;
    }
    currentWorkout = workout;
    const dte = new Date(workout.startDate);
    chart.setOption({
      title: { text: dte.toDateString() },
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
            data: buildMarkAreas(workout.intervals, manualIntervals)
          }
        }
      ]
    });
  }

  function updateWorkoutCP(workout, cpview) {
    currentWorkout = workout;
    manualIntervals = [];
    const tem = new Date(cpview.startTime).toDateString();
    chart.setOption({
      title: { text: tem },
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
            data: buildMarkAreasCP(cpview)
          }
        }
      ]
    });
  }
function setDrawingMode(enabled) {
chart.setOption({
  dataZoom: [
    {
      type: 'inside',
      zoomOnMouseWheel: true,   // ✅ Zoom bleibt
      moveOnMouseMove: !enabled,   // ❌ kein Drag mehr
      moveOnMouseWheel: true   // ❌ kein horizontales Scroll-Pan
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
    updateWorkoutCP,
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

  chart.getZr().on('mousedown', (event) => {
    if (isSegmentMode) {
      event.event.preventDefault();
      event.event.stopPropagation();

      const point = [event.offsetX, event.offsetY];
      const data = chart.convertFromPixel({ seriesIndex: 0 }, point);

      selectionStart = data[0]; // x-Achse

      console.log(selectionStart);
    }

  });


  chart.getZr().on('mouseup', (event) => {
    if (selectionStart === null) return;

    const point = [event.offsetX, event.offsetY];
    const data = chart.convertFromPixel({ seriesIndex: 0 }, point);

    const selectionEnd = data[0];

    createNewInterval({ startIndex: Math.round(selectionStart), endIndex: Math.round(selectionEnd) });

    //handlers.createMarkArea(selectionStart, selectionEnd);


    console.log(selectionEnd);
    selectionStart = null;
  });



  function createNewInterval(startEnd) {
    let startIndex = startEnd.startIndex;
    let endIndex = startEnd.endIndex;
    if (endIndex < startIndex) {
      const aaa = endIndex;
      endIndex = startIndex;
      startIndex = aaa;
    }
    if ((endIndex - startIndex) < 2) {
      return null;
    }

    const { series, STRIDE } = currentWorkout;

    let power = 0;
    let heartrate = 0;
    let cnt = 0;
    for (let i = startIndex * STRIDE; i < endIndex * STRIDE; i += STRIDE) {
      power += series[i];
      heartrate += series[i];
      ++cnt;
    }
    power = Math.round(power / cnt);
    heartrate = Math.round(heartrate / cnt);




    manualIntervals.push({
      start: startIndex,
      end: endIndex,
      duration: endIndex - startIndex,
      power: power,
      heartrate: heartrate
    });

    currentWorkout.manualIntervals = manualIntervals;

    handlers.onUpdateWorkout?.(currentWorkout);



  }


}