
document.addEventListener("DOMContentLoaded", function () {

  const chart = initChart();
  const table = initTable(chart);

  window.addEventListener("resize", () => chart.resize());

});


// ---------------------------------------------------
// CHART INITIALISIERUNG
// ---------------------------------------------------

function initChart() {

  const chartDom = document.getElementById("workout-chart");
  const chart = echarts.init(chartDom);

  const option = {

    tooltip: {
      trigger: "item",
      formatter: function (params) {

        if (params.componentType === "markArea") {
          const d = params.data;
          return `
            <b>Segment</b><br/>
            Type: ${d.segmentType}<br/>
            AvgPwr: ${d.avgPower}
          `;
        }

        if (params.seriesType === "line") {
          return `
            ${params.seriesName}<br/>
            Value: ${params.value[1]}
          `;
        }
      }
    },

    legend: {
      data: ["Power", "Heart Rate", "Cadence", "NormPW"]
    },

    dataset: { source: [] },

    xAxis: {
      type: "value",
      boundaryGap: false,
      scale: true,
      axisLabel: {
        formatter: formatSeconds
      }
    },

    yAxis: [
      { type: "value", name: "Power (W)", position: "left" },
      { type: "value", name: "HR (bpm)", position: "right" },
      { type: "value", name: "Cadence", position: "right", offset: 60 },
      { type: "value", name: "NormPW (W)", position: "left", offset: 60 },
      //{ type: "value", name: "Smooth PW (W)", position: "right", offset: 120 },
      //{ type: "value", name: "Smooth PW Adp", position: "left", offset: 180 }     
    ],

    series: [
      {
        name: "Power",
        type: "line",
        yAxisIndex: 0,
        encode: {x: 0, y: 1 },
        showSymbol: false,
        markArea: { data: [] }
      },
      {
        name: "Heart Rate",
        type: "line",
        yAxisIndex: 1,
        encode: {x: 0, y: 2 },
        showSymbol: false
      },
      {
        name: "Cadence",
        type: "line",
        yAxisIndex: 2,
        encode: {x: 0, y: 3 },
        showSymbol: false
      },
      {
        name: "NormPW",
        type: "line",
        yAxisIndex: 3,
        encode: {x: 0, y: 5 },
        showSymbol: false
      }
    ],

    dataZoom: [
      { type: "inside", xAxisIndex: 0, filterMode: "none" },
      { type: "slider", xAxisIndex: 0 }
    ],
    animation: false
  };

  chart.setOption(option);

  // 👉 Interaktionen registrieren
  registerChartInteractions(chart);

  return chart;
}

function registerChartInteractions(chart) {

  chart.on("click", function (params) {

    // Nur reagieren wenn ein Segment geklickt wurde
    if (params.componentType !== "markArea") return;
    const start = Math.min(params.data.coord[0][0], params.data.coord[1][0]);
    const end = Math.max(params.data.coord[0][0], params.data.coord[1][0]);
    zoomToSegment(chart, start, end);

  });

}

function zoomToSegment(chart, start, end) {

  chart.dispatchAction({
    type: "dataZoom",
    startValue: start,
    endValue: end,
    animation: true
  });

}

// ---------------------------------------------------
// TABLE INITIALISIERUNG
// ---------------------------------------------------

function initTable(chart) {

  const table = new Tabulator("#file-table", {

    ajaxURL: "/files/workouts",
    ajaxConfig: "GET",


    layout: "fitColumns",
    height: "600px",

    sortMode: "remote",
    filterMode: "remote",
    paginationSize: 20,
    // -----------------------------------
    // entweder: paginationMode: "remote" + paginationDataSent
    //pagination: true,
    //paginationMode: "remote",
    // oder: progressiveLoad: "scroll" + progressiveLoadScrollMargin
    progressiveLoad: "scroll",
    progressiveLoadScrollMargin: 100,
    // -------------
    paginationDataSent: {
      page: "page",
      size: "size"
    },

    dataReceiveParams: {
      last_page: "last_page",
      last_row: "total_records"
    },

    initialSort: [
      { column: "start_time", dir: "desc" }
    ],

    columns: [
      /* {
         title: "File",
         field: "original_filename",
         sorter: "string",
         headerFilter: "input"
       },*/
      {
        title: "Start On",
        field: "start_time",
        sorter: "datetime",
        formatter: cell =>
          new Date(cell.getValue()).toLocaleString()
      },
      {
        title: "Duration",
        field: "total_timer_time",
        sorter: "number",
        formatter: function (cell) {
          return formatDuration(cell.getValue());
        }
      },
      {
        title: "Distance (km)",
        field: "total_distance",
        sorter: "number",
        formatter: cell => (cell.getValue() / 1000).toFixed(2)
      },
      {
        title: "Avg Speed (km/h)",
        field: "avg_speed",
        sorter: "number",
        formatter: cell => (cell.getValue() * 3.6).toFixed(1)
      },
      {
        title: "Avg Power",
        field: "avg_power",
        sorter: "number",
        headerFilter: "input",
        headerFilterFunc: ">=",
        formatter: cell => cell.getValue().toFixed(0)
      },
      {
        title: "Norm Power",
        field: "avg_normalized_power",
        sorter: "number",
        headerFilter: "input",
        headerFilterFunc: ">=",
        formatter: cell => cell.getValue().toFixed(0)
      }


    ]
  });

  table.on("rowClick", (e, row) => loadWorkout(chart, row));

  // 🔥 Trick: erstes Workout automatisch laden
  /*table.on("dataLoaded", function(data){

    if (!data || data.length === 0) return;

    const firstRow = table.getRows()[0];

    if (firstRow) {
      firstRow.select(); // optional visuelles Highlight
      loadWorkout(chart, firstRow);
    }
  });*/

  return table;
}

// ---------------------------------------------------
// Duration Formatter
// ---------------------------------------------------
function formatDuration(seconds) {

  if (seconds == null) return "";

  const total = Math.floor(seconds);

  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;

  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }

  return `${m}:${s.toString().padStart(2, "0")}`;
}

// ---------------------------------------------------
// WORKOUT LADEN
// ---------------------------------------------------

async function loadWorkout(chart, row) {

  const workoutId = row.getData().id;

  chart.showLoading();

  try {

    /*const response = await fetch(`/files/workouts/${workoutId}/data`);
    if (response.status === 401) {
      window.location.href = "/";
      return;
    }*/

const { url } = await fetch(`/files/workouts/${workoutId}/data`).then(r => r.json());
const { data } = await fetch(url).then(r => r.json());


    //const { data, segments } = await response.json();
    for( let i = 0; i < data.length; ++i)
    {
        data[i].unshift(i);
    }

    const segments = [];

    //computeNormalizedPowerSeries(data);
    //smoothPowerZeroAware(data);
    //smoothPowerAdaptive(data);

    /*for (let i = 0; i < data.length; i++) {
      data[i].push(npSeries[i]);
    }*/

    const maxX = data.length - 1;//data[data.length - 1][0];

    const segmentAreas = buildSegmentAreas(segments);

    updateChart(chart, data, maxX, segmentAreas);

  }
  catch (err) {
    console.error(err);
  }
  finally {
    chart.hideLoading();
  }
}


// ---------------------------------------------------
// CHART UPDATE
// ---------------------------------------------------

function updateChart(chart, data, maxX, segmentAreas) {

  chart.setOption({

    dataset: { source: data },

    xAxis: { max: maxX },

    series: [{
      name: "Power",
      markArea: {
        silent: false,
        label: { show: false },
        data: segmentAreas
      }
    }],

    dataZoom: [
      { type: "inside", start: 0, end: 100 },
      { type: "slider", start: 0, end: 100 }
    ]

  });
}


// ---------------------------------------------------
// SEGMENT HELPER
// ---------------------------------------------------

function buildSegmentAreas(segments) {

  return segments.map(seg => [
    {
      xAxis: seg.start,
      segmentType: seg.type,
      avgPower: seg.avgPower,
      itemStyle: { color: "rgba(255,0,0,0.15)" }
    },
    { xAxis: seg.end }
  ]);

}


// ---------------------------------------------------
// TIME FORMATTER
// ---------------------------------------------------

function formatSeconds(value) {

  const h = Math.floor(value / 3600);
  const m = Math.floor((value % 3600) / 60);
  const s = value % 60;

  return `${h}:${m.toString().padStart(2, "0")}:${s
    .toString()
    .padStart(2, "0")}`;

}

function computeNormalizedPowerSeries(records) {

  const WINDOW = 30;

  const buffer = new Array(WINDOW).fill(0);

  let bufferIndex = 0;
  let rollingSum = 0;

  let fourthSum = 0;
  let avgCount = 0;

  for (let i = 0; i < records.length; i++) {

    const power = records[i][1];

    // alten Wert aus dem Rolling Window entfernen
    rollingSum -= buffer[bufferIndex];

    // neuen Wert hinzufügen
    buffer[bufferIndex] = power;
    rollingSum += power;

    bufferIndex = (bufferIndex + 1) % WINDOW;

    if (i >= WINDOW - 1) {

      const avg30 = rollingSum / WINDOW;

      const p4 = avg30 * avg30 * avg30 * avg30;

      fourthSum += p4;
      avgCount++;

      const meanFourth = fourthSum / avgCount;

      const np = Math.pow(meanFourth, 0.25);

      // NP direkt an Record anhängen
      records[i].push(np);

    } else {

      records[i].push(null);

    }
  }

  return records;
}


function smoothPowerZeroAware(records, alpha = 0.25) {

  let ema = records[0][1];
  let zeroCount = 0;

  for (let i = 0; i < records.length; i++) {

    const power = records[i][1];

    if (power === 0) {

      zeroCount++;
      records[i].push(0);

    } else {

      if (zeroCount > 3) {
        ema = power;   // Reset nach Coasting
      }

      zeroCount = 0;

      ema = alpha * power + (1 - alpha) * ema;

      records[i].push(ema);

    }
  }

  return records;
}

function smoothPowerAdaptive(records) {

  let ema = records[0][1];
  let prevPower = records[0][1];

  const minAlpha = 0.08;   // starkes smoothing
  const maxAlpha = 0.5;    // schnelle Reaktion
  const maxDelta = 200;    // Poweränderung bei der maxAlpha erreicht wird

  for (let i = 0; i < records.length; i++) {

    const power = records[i][1];

    if (power === 0) {
      records[i].push(0);
      prevPower = 0;
      continue;
    }

    const delta = Math.abs(power - prevPower);

    let alpha = minAlpha + (maxAlpha - minAlpha) * (delta / maxDelta);

    alpha = Math.max(minAlpha, Math.min(maxAlpha, alpha));

    ema = alpha * power + (1 - alpha) * ema;

    records[i].push(ema);

    prevPower = power;
  }

  return records;
}


