let map;
let trackLayer;


document.addEventListener("DOMContentLoaded", function () {
  map = initMap();
  const chart = initChart();
  const table = initTable(chart);

  window.addEventListener("resize", () => chart.resize());

});



function renderTrack(track) {
  const SEMI_TO_DEG = 18000 / 2147483648;
  trackLayer.clearLayers();

  /*function semicirclesToDegrees(sc) {
    return sc * SEMI_TO_DEG;
  }*/
  //for (let i, )
  let data = [];
  data.push([track.baselat * SEMI_TO_DEG, track.baselong * SEMI_TO_DEG]);

  let last = [track.baselat, track.baselong];
  for (let i = 0; i < track.recCount; ++i) {
    const d = [track.deltalat[i] + last[0], track.deltalong[i] + last[1]];
    data.push([d[0] * SEMI_TO_DEG, d[1] * SEMI_TO_DEG]);
    last = d;
  }


  const polyline = L.polyline(data, {
    color: '#ff4d4f',
    weight: 4
  }).addTo(trackLayer);


  map.fitBounds(polyline.getBounds());

}

function initMap() {
  const map = L.map('workout-map');

  trackLayer = L.layerGroup().addTo(map);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18
  }).addTo(map);
  return map;
}

// ---------------------------------------------------
// CHART INITIALISIERUNG
// ---------------------------------------------------
function initChart() {

  const chartDom = document.getElementById("workout-chart");
  const chart = echarts.init(chartDom);

  /*const option = {

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
        encode: { x: 0, y: 1 },
        showSymbol: false,
        markArea: { data: [] }
      },
      {
        name: "Heart Rate",
        type: "line",
        yAxisIndex: 1,
        encode: { x: 0, y: 2 },
        showSymbol: false
      },
      {
        name: "Cadence",
        type: "line",
        yAxisIndex: 2,
        encode: { x: 0, y: 3 },
        showSymbol: false
      },
      {
        name: "NormPW",
        type: "line",
        yAxisIndex: 3,
        encode: { x: 0, y: 5 },
        showSymbol: false
      }
    ],

    dataZoom: [
      { type: "inside", xAxisIndex: 0, filterMode: "none" },
      { type: "slider", xAxisIndex: 0 }
    ],
    animation: false
  };*/

  const option = {
    title: { text: '...' },
    tooltip: { trigger: 'axis' },
    animation: false,
    legend: {}, // Legende wird automatisch aus den series-Namen generiert
    xAxis: {
      type: 'value',
      scale: true,
      axisLabel: {
        formatter: formatSeconds
      }
    },
    //yAxis: { type: 'value' },
    yAxis: [
      { type: "value", name: "Power (W)", position: "left" },
      { type: "value", name: "HR/Cad", position: "right" },
      { type: "value", name: "Speed", position: "left", offset: 60 },
      { type: "value", name: "Altitude", position: "right", offset: 60 }
      //{ type: "value", name: "Smooth PW (W)", position: "right", offset: 120 },
      //{ type: "value", name: "Smooth PW Adp", position: "left", offset: 180 }     
    ],

    // 2. Das Dataset definiert das 4er-Muster
    dataset: {
      dimensions: ['x', 'Power', 'Heartrate', 'Cadence', 'Speed', 'Altitude'],
      source: new Float32Array()
    },
    dataZoom: [
      { type: "inside", xAxisIndex: 0, filterMode: "none" },
      { type: "slider", xAxisIndex: 0 }
    ],
    series: [
      {
        name: 'Power',
        type: 'line',
        showSymbol: false,
        sampling: 'lttb',
        yAxisIndex: 0,
        encode: { x: 'x', y: 'Power' } // Nimmt den 2. Wert aus dem 4er-Block
      },
      {
        name: 'Heartrate',
        type: 'line',
        showSymbol: false,
        sampling: 'lttb',
        yAxisIndex: 1,
        encode: { x: 'x', y: 'Heartrate' } // Nimmt den 3. Wert aus dem 4er-Block
      },
      {
        name: 'Cadence',
        type: 'line',
        showSymbol: false,
        sampling: 'lttb',
        yAxisIndex: 1,

        encode: { x: 'x', y: 'Cadence' } // Nimmt den 4. Wert aus dem 4er-Block
      },
      {
        name: 'Speed',
        type: 'line',
        showSymbol: false,
        sampling: 'lttb',
        yAxisIndex: 2,

        encode: { x: 'x', y: 'Speed' } // Nimmt den 4. Wert aus dem 4er-Block
      },
      {
        name: 'Altitude',
        type: 'line',
        showSymbol: false,
        sampling: 'lttb',
        yAxisIndex: 3,

        encode: { x: 'x', y: 'Altitude' } // Nimmt den 4. Wert aus dem 4er-Block
      }
    ]

  }

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
    height: "300px",

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
        headerFilter: "input",
        headerFilterFunc: ">=",
        formatter: cell => (cell.getValue()).toFixed(2)
      },
      {
        title: "Avg Speed (km/h)",
        field: "avg_speed",
        sorter: "number",
        headerFilter: "input",
        headerFilterFunc: ">=",
        formatter: cell => (cell.getValue()).toFixed(1)
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
        title: "Avg Hr",
        field: "avg_heart_rate",
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

function buildIndex(n) {
  const arr = new Array(n)
  for (let i = 0; i < n; i++) arr[i] = i
  return arr
}

// ---------------------------------------------------
// WORKOUT LADEN
// ---------------------------------------------------

async function loadWorkout(chart, row) {

  const workoutId = row.getData().id;
  const filename = row.getData().original_filename;

  chart.showLoading();

  try {

    /*const response = await fetch(`/files/workouts/${workoutId}/data`);
    if (response.status === 401) {
      window.location.href = "/";
      return;
    }*/

    const { url } = await fetch(`/files/workouts/${workoutId}/data`).then(r => r.json());
    //const { data } = await fetch(url).then(r => r.json());
    const response = await fetch(url);
    const buffer = await response.arrayBuffer();

    const view = new DataView(buffer)

    const magic = view.getUint32(0);
    const version = view.getUint16(4, true);
    const recCount = view.getUint32(6, true);
    const delta_mode = view.getUint16(10, true);

    const headerSize = 12; // Uint32 record count

    console.log({ recCount });


    let offset = headerSize;

    const baseValues = new Int32Array(buffer, offset, 7);
    offset += baseValues.byteLength;



    const powers = new Int16Array(buffer, offset, recCount);
    offset += powers.byteLength;

    const heartRates = new Int8Array(buffer, offset, recCount);
    offset += heartRates.byteLength;

    const cadences = new Int8Array(buffer, offset, recCount);
    offset += cadences.byteLength;

    const speeds = new Int8Array(buffer, offset, recCount);
    offset += speeds.byteLength;

    const altitudes = new Int8Array(buffer, offset, recCount);
    offset += altitudes.byteLength;

    const latitudes = new Int32Array(buffer, offset, recCount);
    offset += latitudes.byteLength;

    const longitudes = new Int32Array(buffer, offset, recCount);


    const data = new Float32Array((recCount + 1) * 6);
    let idx = 0;
    data[idx] = 0;
    data[idx + 1] = baseValues[0];
    data[idx + 2] = baseValues[1];
    data[idx + 3] = baseValues[2];
    data[idx + 4] = baseValues[3] / 10;
    data[idx + 5] = baseValues[4];
    for (let i = 0; i < recCount; i++) {
      idx = (i + 1) * 6;
      const prev_idx = i * 6;
      data[idx] = i + 1;
      data[idx + 1] = data[prev_idx + 1] + powers[i];
      data[idx + 2] = data[prev_idx + 2] + heartRates[i];
      data[idx + 3] = data[prev_idx + 3] + cadences[i];
      data[idx + 4] = data[prev_idx + 4] + speeds[i] / 10;
      data[idx + 5] = data[prev_idx + 5] + altitudes[i];
    }

    updateChart(chart, data, recCount + 1, filename);
    renderTrack({ baselat: baseValues[5], baselong: baseValues[6], deltalat: latitudes, deltalong: longitudes, recCount: recCount });

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

function updateChart(chart, track, recCount, filename) {
  const index = buildIndex(track.count);
  chart.setOption({
    title: { text: filename },
    //tooltip: { trigger: 'axis' },
    //legend: {}, // Legende wird automatisch aus den series-Namen generiert
    //xAxis: { type: 'value' },
    //yAxis: { type: 'value' },
    // 2. Das Dataset definiert das 4er-Muster
    dataset: {
      //dimensions: ['x', 'Power', 'Heartrate', 'Cadence', 'Speed', 'Altitude'],
      source: track
    }


    // 3. Für jede Linie eine eigene Series definieren
    /*series: [
      {
        name: 'Power',
        type: 'line',
        showSymbol: false,
        sampling: 'lttb',
        encode: { x: 'x', y: 'Power' } // Nimmt den 2. Wert aus dem 4er-Block
      },
      {
        name: 'Heartrate',
        type: 'line',
        showSymbol: false,
        sampling: 'lttb',
        encode: { x: 'x', y: 'Heartrate' } // Nimmt den 3. Wert aus dem 4er-Block
      },
      {
        name: 'Cadence',
        type: 'line',
        showSymbol: false,
        sampling: 'lttb',
        encode: { x: 'x', y: 'Cadence' } // Nimmt den 4. Wert aus dem 4er-Block
      },
      {
        name: 'Speed',
        type: 'line',
        showSymbol: false,
        sampling: 'lttb',
        encode: { x: 'x', y: 'Speed' } // Nimmt den 4. Wert aus dem 4er-Block
      },
      {
        name: 'Altitude',
        type: 'line',
        showSymbol: false,
        sampling: 'lttb',
        encode: { x: 'x', y: 'Altitude' } // Nimmt den 4. Wert aus dem 4er-Block
      }
    ]*/
  });//, { replaceMerge: ["series", "xAxis"] });
  /*chart.setOption({

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

  });*/
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


