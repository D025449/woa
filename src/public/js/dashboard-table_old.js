import { TypedArrayHelpers } from "/shared/TypedArrayHelpers.js";


/*let map;
let trackLayer;
let hoverMarker = null;
let currentTrackPoints = null;
let currentChart = null;*/


let map;
let trackLayer;
let hoverLayer;
let hoverMarker = null;
let currentTrackPoints = null;
let mapHoverBound = false;
let lastHoverIndex = -1;
let currentSeries = 'Power';


document.addEventListener("DOMContentLoaded", function () {
  map = initMap();
  const chart = initChart();
  const table = initTable(chart);

  window.addEventListener("resize", () => chart.resize());

});


// ---------------------------------------------------
// MAP INITIALISIERUNG
// ---------------------------------------------------
function initMap() {
  const map = L.map('workout-map');

  trackLayer = L.layerGroup().addTo(map);
  hoverLayer = L.layerGroup().addTo(map);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18
  }).addTo(map);

  return map;
}

// ---------------------------------------------------
// TRACK RENDERN
// ---------------------------------------------------
function renderTrack(track, chart) {
  const SEMI_TO_DEG = 18000 / 2147483648;

  trackLayer.clearLayers();
  hoverLayer.clearLayers();
  hoverMarker = null;
  currentTrackPoints = [];

  let lat = track.baselat;
  let lng = track.baselong;

  currentTrackPoints.push({
    lat: lat * SEMI_TO_DEG,
    lng: lng * SEMI_TO_DEG,
    idx: 0
  });

  for (let i = 0; i < track.recCount; ++i) {
    lat += track.deltalat[i];
    lng += track.deltalong[i];

    currentTrackPoints.push({
      lat: lat * SEMI_TO_DEG,
      lng: lng * SEMI_TO_DEG,
      idx: i + 1
    });
  }

  const latlngs = currentTrackPoints.map(p => [p.lat, p.lng]);

  const polyline = L.polyline(latlngs, {
    color: '#ff4d4f',
    weight: 4,
    opacity: 0.9
  }).addTo(trackLayer);

  map.fitBounds(polyline.getBounds(), { padding: [10, 10] });

  bindMapHover(chart);
}

// ---------------------------------------------------
// MAP-HOVER EINMALIG BINDEN
// ---------------------------------------------------
function bindMapHover(chart) {
  if (mapHoverBound) return;
  mapHoverBound = true;

  map.on('mousemove', function (e) {
    if (!currentTrackPoints || currentTrackPoints.length === 0) return;

    const nearest = findNearestTrackPointPx(map, e.latlng, currentTrackPoints, 18);

    if (!nearest) {
      //console.log({ hide: "hide" });
      hideTrackHover(chart);
      return;
    }

    moveHoverMarker(nearest.lat, nearest.lng);
    syncChartToTrackIndex(chart, nearest.idx);
  });

  map.on('mouseout', function () {
    //console.log({ hide: "hide2" });
    hideTrackHover(chart);
  });
}

// ---------------------------------------------------
// NÄCHSTEN TRACKPUNKT FINDEN (PIXELBASIERT)
// ---------------------------------------------------
function findNearestTrackPointPx(map, latlng, points, maxPxDistance = 18) {
  const mousePt = map.latLngToLayerPoint(latlng);

  let best = null;
  let bestDist2 = Infinity;

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const pt = map.latLngToLayerPoint([p.lat, p.lng]);

    const dx = pt.x - mousePt.x;
    const dy = pt.y - mousePt.y;
    const dist2 = dx * dx + dy * dy;

    if (dist2 < bestDist2) {
      bestDist2 = dist2;
      best = p;
    }
  }

  if (!best) return null;

  return bestDist2 <= maxPxDistance * maxPxDistance ? best : null;
}





lastHoverIndex = -1;

/*if (chart) {
  chart.dispatchAction({ type: 'hideTip' });
  chart.dispatchAction({
    type: 'updateAxisPointer',
    currTrigger: 'leave'
  });
}*/
// ---------------------------------------------------
// CHART AUF TRACK-INDEX SYNCHRONISIEREN
// ---------------------------------------------------
function syncChartToTrackIndex(chart, dataIndex) {
  if (!chart) return;
  if (dataIndex == null) return;
  if (dataIndex === lastHoverIndex) return;

  lastHoverIndex = dataIndex;
  console.log('Show Tip');
  chart.dispatchAction({
    type: 'updateAxisPointer',
    xAxisIndex: 0,
    value: dataIndex
  });

  chart.dispatchAction({
    type: 'showTip',
    seriesIndex: 0,
    dataIndex: dataIndex
  });
}

// ---------------------------------------------------
// HOVER-MARKER BEWEGEN
// ---------------------------------------------------
function moveHoverMarker(lat, lng) {
  if (!hoverMarker) {
    hoverMarker = L.circleMarker([lat, lng], {
      radius: 7,
      weight: 2,
      color: '#111',
      fillColor: '#ffd54f',
      fillOpacity: 1
    }).addTo(hoverLayer);
  } else {
    hoverMarker.setLatLng([lat, lng]);
  }
}

function hideHoverMarker() {
  if (hoverMarker) {
    hoverLayer.removeLayer(hoverMarker);
    hoverMarker = null;
  }
}

// ---------------------------------------------------
// HOVER AUSBLENDEN
// ---------------------------------------------------
function hideTrackHover(chart) {
  if (hoverMarker) {
    hoverLayer.removeLayer(hoverMarker);
    hoverMarker = null;
  }
}

/*
function renderTrack(track, chart) {
  const SEMI_TO_DEG = 18000 / 2147483648;
  trackLayer.clearLayers();
  currentTrackPoints = [];

  const firstLat = track.baselat * SEMI_TO_DEG;
  const firstLng = track.baselong * SEMI_TO_DEG;

  currentTrackPoints.push({ lat: firstLat, lng: firstLng, idx: 0 });

  let last = [track.baselat, track.baselong];
  for (let i = 0; i < track.recCount; ++i) {
    const d = [track.deltalat[i] + last[0], track.deltalong[i] + last[1]];
    currentTrackPoints.push({
      lat: d[0] * SEMI_TO_DEG,
      lng: d[1] * SEMI_TO_DEG,
      idx: i + 1
    });
    last = d;
  }

  const latlngs = currentTrackPoints.map(p => [p.lat, p.lng]);

  const polyline = L.polyline(latlngs, {
    color: '#ff4d4f',
    weight: 4
  }).addTo(trackLayer);

  polyline.on('mousemove', function (e) {
    const nearest = findNearestTrackPoint(e.latlng, currentTrackPoints);
    console.log({nearest});
    if (!nearest) return;

    syncChartToTrackIndex(chart, nearest.idx);
    moveHoverMarker(nearest.lat, nearest.lng);
  });

  polyline.on('mouseout', function () {
    hideTrackHover(chart);
  });

  map.fitBounds(polyline.getBounds());
}

function initMap() 
{ 
    const map = L.map('workout-map'); 
    trackLayer = L.layerGroup().addTo(map); 
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18 }).addTo(map); 
    return map; 
}

function findNearestTrackPoint(latlng, points) {
  if (!points || points.length === 0) return null;

  let best = null;
  let bestDist = Infinity;

  const { lat, lng } = latlng;

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const dLat = p.lat - lat;
    const dLng = p.lng - lng;
    const dist2 = dLat * dLat + dLng * dLng;

    if (dist2 < bestDist) {
      bestDist = dist2;
      best = p;
    }
  }

  return best;
}
function syncChartToTrackIndex(chart, dataIndex) {
  if (!chart) return;

  chart.dispatchAction({ type: 'hideTip' });

  chart.dispatchAction({
    type: 'showTip',
    seriesIndex: 0,
    dataIndex: dataIndex
  });

  chart.dispatchAction({
    type: 'updateAxisPointer',
    xAxisIndex: 0,
    value: dataIndex
  });
}

function moveHoverMarker(lat, lng) {
  if (!hoverMarker) {
    hoverMarker = L.circleMarker([lat, lng], {
      radius: 6,
      weight: 2,
      color: '#111',
      fillColor: '#fff',
      fillOpacity: 1
    }).addTo(trackLayer);
  } else {
    hoverMarker.setLatLng([lat, lng]);
  }
}

function hideTrackHover(chart) {
  if (hoverMarker) {
    trackLayer.removeLayer(hoverMarker);
    hoverMarker = null;
  }

  if (chart) {
    chart.dispatchAction({ type: 'hideTip' });
  }
}*/


// ---------------------------------------------------
// CHART INITIALISIERUNG
// ---------------------------------------------------
function initChart() {

  const chartDom = document.getElementById("workout-chart");
  const chart = echarts.init(chartDom);


  const option = {
    title: { text: '...' },
    tooltip: {
      trigger: 'axis',
      //triggerOn: 'none',
      confine: true,
      alwaysShowContent: false,
      axisPointer: {
        type: 'line',
        snap: true
      },
      formatter: function (params) {
        if (!params || !params.length) return '';

        const p = params.find(x => x.seriesName === 'Power') || params[0];
        const row = p.data;
        if (!row) return '';

        const power = row[1];
        const hr = row[2];
        const cadence = row[3];
        const speed = row[4] != null ? Number(row[4]).toFixed(1) : '-';
        const altitude = row[5] != null ? Number(row[5]).toFixed(1) : '-';

        return `
      ⚡ ${power ?? '-'} W<br/>
      ❤️ ${hr ?? '-'} bpm<br/>
      🔁 ${cadence ?? '-'} rpm<br/>
      🚴 ${speed} km/h<br/>
      ⛰ ${altitude} m
    `;
      }
    },
    animation: false,
    legend: {}, // Legende wird automatisch aus den series-Namen generiert

    /*legend: {
      selected: {
        Power: true,
        PowerS5: false,
        PowerS15: false
      }
    },*/

    grid: {
      top: 80 // 👈 DAS ist entscheidend
    },

    xAxis: {
      type: 'value',
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
          type: 'solid'
        },
        label: {
          show: true,
          formatter: function (params) {
            return formatSeconds(params.value);
          }
        }
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
      dimensions: ['x', 'Power', 'Heartrate', 'Cadence', 'Speed', 'Altitude', 'PowerS5', 'PowerS15', 'SpeedS5', 'AltitudeS7'],
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
        markArea: { data: [] },
        encode: { x: 'x', y: 'PowerS15' } // Nimmt den 2. Wert aus dem 4er-Block
      },
      /*{
        name: 'PowerS5',
        type: 'line',
        showSymbol: false,
        show: false,
        sampling: 'lttb',
        yAxisIndex: 0,
        markArea: { data: [] },
        encode: { x: 'x', y: 'PowerS5' } // Nimmt den 2. Wert aus dem 4er-Block
      },
      {
        name: 'PowerS15',
        type: 'line',
        showSymbol: false,
        show: false,
        sampling: 'lttb',
        yAxisIndex: 0,
        markArea: { data: [] },
        encode: { x: 'x', y: 'Power' } // Nimmt den 2. Wert aus dem 4er-Block
      },*/
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

        encode: { x: 'x', y: 'SpeedS5' } // Nimmt den 4. Wert aus dem 4er-Block
      },
      {
        name: 'Altitude',
        type: 'line',
        showSymbol: false,
        sampling: 'lttb',
        yAxisIndex: 3,

        encode: { x: 'x', y: 'AltitudeS7' } // Nimmt den 4. Wert aus dem 4er-Block
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
    if (params.componentType !== "markArea") return;
    const start = Math.min(params.data.coord[0][0], params.data.coord[1][0]);
    const end = Math.max(params.data.coord[0][0], params.data.coord[1][0]);
    zoomToSegment(chart, start, end);
  });

  chart.getZr().on('mousemove', function (params) {
    if (!currentTrackPoints || currentTrackPoints.length === 0) return;

    const xVal = chart.convertFromPixel({ xAxisIndex: 0 }, params.offsetX);
    if (xVal == null || Number.isNaN(xVal)) return;

    const idx = Math.round(xVal);
    const p = currentTrackPoints[idx];
    if (!p) return;

    moveHoverMarker(p.lat, p.lng);
  });

  chart.getZr().on('globalout', function () {
    hideHoverMarker();
  });

  /*chart.on("dataZoom", (e) => {
    const batch = e.batch?.[0] || e;
    const count = chart.getOption().dataset[0].source.length / 10;

    const start = Math.floor(batch.start / 100 * count);
    const end = Math.floor(batch.end / 100 * count);
    const range = end - start;

    let nextSeries;
    if (range > 2000) nextSeries = 'Power';
    else if (range > 500) nextSeries = 'PowerS5';
    else nextSeries = 'PowerS15';

    if (nextSeries === currentSeries) return;

    console.log("Switch to:", nextSeries);
    currentSeries = nextSeries;
  });*/
}

/*function registerChartInteractions(chart) {

  chart.on("click", function (params) {

    // Nur reagieren wenn ein Segment geklickt wurde
    if (params.componentType !== "markArea") return;
    const start = Math.min(params.data.coord[0][0], params.data.coord[1][0]);
    const end = Math.max(params.data.coord[0][0], params.data.coord[1][0]);
    zoomToSegment(chart, start, end);

  });

  chart.on('updateAxisPointer', function (event) {
  const xInfo = event.axesInfo?.[0];
  if (!xInfo) return;
  if (!currentTrackPoints || currentTrackPoints.length === 0) return;

  const idx = Math.round(xInfo.value);
  const p = currentTrackPoints[idx];
  if (!p) return;

  moveHoverMarker(p.lat, p.lng);
});

  chart.getDom().addEventListener('mouseleave', () => {
    hideTrackHover(chart);
  });

  const mapEl = document.getElementById('workout-map');
  if (mapEl) {
    mapEl.addEventListener('mouseleave', () => {
      hideTrackHover(chart);
    });
  }

  chart.on("dataZoom", (e) => {
    const batch = e.batch?.[0] || e;
    const count = chart.getOption().dataset[0].source.length / 10;
    // 👉 richtige Werte!
    const start = Math.floor(batch.start / 100 * count);
    const end = Math.floor(batch.end / 100 * count);

    const range = end - start;

    let nextSeries;
    if (range > 2000) nextSeries = 'Power';
    else if (range > 500) nextSeries = 'PowerS5';
    else nextSeries = 'PowerS15';

    if (nextSeries === currentSeries) return;


    console.log("Switch to:", nextSeries);


    //chart.dispatchAction({ type: 'legendUnSelect', name: currentSeries });
    //chart.dispatchAction({ type: 'legendSelect', name: nextSeries });

    currentSeries = nextSeries;
    // 👉 Tooltip crash vermeiden
    //chart.dispatchAction({ type: "hideTip" });


  });


}*/

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
      },
      {
        title: "Actions",
        formatter: function () {

          /*  return `
        <button class="btn btn-sm btn-danger delete-btn">Delete</button>
        <button class="btn btn-sm btn-primary open-btn">Open</button>
      `;*/
          return `
      <button class="btn btn-sm btn-danger delete-btn">Delete</button>
    `;
        },

        width: 160,

        cellClick: async function (e, cell) {

          const row = cell.getRow();
          const data = row.getData();

          if (e.target.classList.contains("delete-btn")) {

            //deleteWorkout(row.id);
            e.stopPropagation();
            await deleteWorkout(row, data);
            return;

          }

          if (e.target.classList.contains("open-btn")) {

            //loadWorkout(row.id);
            e.stopPropagation();

          }

        }

      }


    ]
  });

  table.on("rowClick", (e, row) => loadWorkout(e, chart, row));

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

async function deleteWorkout(row, data) {
  const workoutId = data.id;
  const filename = data.original_filename || `Workout ${workoutId}`;

  const ok = window.confirm(`Workout wirklich löschen?\n\n${filename}`);
  if (!ok) return;

  try {
    const response = await fetch(`/files/workouts/${workoutId}`, {
      method: "DELETE"
    });

    if (response.status === 401) {
      window.location.href = "/";
      return;
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `Delete fehlgeschlagen (${response.status})`);
    }

    row.delete();
  }
  catch (err) {
    console.error("Delete failed:", err);
    alert(`Löschen fehlgeschlagen: ${err.message}`);
  }
}


async function loadWorkout(e, chart, row) {
  if (e.target.closest("button")) return;
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

    const view = new DataView(buffer);

    const magic = view.getUint32(0);
    const version = view.getUint32(4, true);
    const recCount = view.getUint32(8, true);
    const intervalCount = view.getUint32(12, true);
    if (intervalCount > 256) {
      intervalCount = 0;
    }

    const headerSize = 16; // Uint32 record count

    //const bytes = TypedArrayHelpers.computeSizeForFitRecords(recCount, headerSize);
    const [baseValues, powers, heartRates, cadences, speeds, altitudes, latitudes, longitudes, starts, ends, durations, intpowers, intHeartRates, intSpeeds] = TypedArrayHelpers.allocateViews(buffer, recCount, intervalCount, headerSize);

    console.log({ recCount });

    const STRIDE = 10;

    const WIN5 = 5;
    const WIN15 = 5;
    const WIN_SPEED = 15;
    const WIN_ALTITUDE = 7;

    let sumPower5 = 0;
    let sumPower15 = 0;
    let sumSpeed5 = 0;
    let sumAltitude7 = 0;

    const data = new Float32Array((recCount + 1) * STRIDE);

    // ---- FIRST ROW ----
    let idx = 0;

    const basePower = baseValues[0];
    const baseHeartRate = baseValues[1];
    const baseCadence = baseValues[2];
    const baseSpeed = baseValues[3] / 10;
    const baseAltitude = baseValues[4];

    data[idx] = 0;
    data[idx + 1] = basePower;
    data[idx + 2] = baseHeartRate;
    data[idx + 3] = baseCadence;
    data[idx + 4] = baseSpeed;
    data[idx + 5] = baseAltitude;

    // smoothing init
    sumPower5 = basePower;
    sumPower15 = basePower;
    sumSpeed5 = baseSpeed;
    sumAltitude7 = baseAltitude;

    data[idx + 6] = basePower;     // PowerS5
    data[idx + 7] = basePower;     // PowerS15
    data[idx + 8] = baseSpeed;     // SpeedS5
    data[idx + 9] = baseAltitude;  // AltitudeS7

    // ---- MAIN LOOP ----
    for (let i = 0; i < recCount; i++) {
      idx = (i + 1) * STRIDE;
      const prev = i * STRIDE;

      // ---- reconstruct raw ----
      const power = data[prev + 1] + powers[i];
      const heartRate = data[prev + 2] + heartRates[i];
      const cadence = data[prev + 3] + cadences[i];
      const speed = data[prev + 4] + speeds[i] / 10;
      const altitude = data[prev + 5] + altitudes[i];

      data[idx] = i + 1;
      data[idx + 1] = power;
      data[idx + 2] = heartRate;
      data[idx + 3] = cadence;
      data[idx + 4] = speed;
      data[idx + 5] = altitude;

      // ---- Power smoothing window 5 ----
      sumPower5 += power;
      if (i + 1 >= WIN5) {
        const old = data[(i + 1 - WIN5) * STRIDE + 1];
        sumPower5 -= old;
      }
      data[idx + 6] = sumPower5 / Math.min(i + 2, WIN5);

      // ---- Power smoothing window 15 ----
      sumPower15 += power;
      if (i + 1 >= WIN15) {
        const old = data[(i + 1 - WIN15) * STRIDE + 1];
        sumPower15 -= old;
      }
      data[idx + 7] = sumPower15 / Math.min(i + 2, WIN15);

      // ---- Speed smoothing window 5 ----
      sumSpeed5 += speed;
      if (i + 1 >= WIN_SPEED) {
        const old = data[(i + 1 - WIN_SPEED) * STRIDE + 4];
        sumSpeed5 -= old;
      }
      data[idx + 8] = sumSpeed5 / Math.min(i + 2, WIN_SPEED);

      // ---- Altitude smoothing window 7 ----
      sumAltitude7 += altitude;
      if (i + 1 >= WIN_ALTITUDE) {
        const old = data[(i + 1 - WIN_ALTITUDE) * STRIDE + 5];
        sumAltitude7 -= old;
      }
      data[idx + 9] = sumAltitude7 / Math.min(i + 2, WIN_ALTITUDE);
    }

    // intervals....

    const intervals = {
      count: intervalCount,
      starts: starts,
      ends: ends,
      durations: durations,
      powers: intpowers,
      heartRates: intHeartRates,
      speeds: intSpeeds

    };

    updateChart(chart, data, recCount, intervals, filename);
    renderTrack({ baselat: baseValues[5], baselong: baseValues[6], deltalat: latitudes, deltalong: longitudes, recCount: recCount }, chart);

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

function updateChart(chart, track, recCount, intervals, filename) {
  const markAreas = buildMarkAreas(intervals);


  //const index = buildIndex(track.Count);
  chart.setOption({
    title: { text: filename },
    xAxis: {
      min: 0,
      max: recCount
    },
    //tooltip: { trigger: 'axis' },
    //legend: {}, // Legende wird automatisch aus den series-Namen generiert
    //xAxis: { type: 'value' },
    //yAxis: { type: 'value' },
    // 2. Das Dataset definiert das 4er-Muster
    dataset: {
      //dimensions: ['x', 'Power', 'Heartrate', 'Cadence', 'Speed', 'Altitude'],
      source: track
    },

    series: [
      {
        name: 'Power',
        markArea: {
          data: markAreas
        }
      }
    ]

  });
}


// ---------------------------------------------------
// SEGMENT HELPER
// ---------------------------------------------------


function buildMarkAreas(intervals) {
  const {
    count,
    starts,
    ends,
    durations,
    powers,
    heartRates,
    speeds
  } = intervals;

  const areas = new Array(count);

  for (let i = 0; i < count; i++) {
    areas[i] = [
      {
        xAxis: starts[i],
        label: {
          show: true,
          position: "insideTop",
          distance: 8,
          formatter: `${formatDuration(durations[i])}\n${powers[i]}W\n${heartRates[i]}bpm`
        }
      },
      {
        xAxis: ends[i]
      }
    ];
  }

  return areas;
}


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

  const total = Math.round(value);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;

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


