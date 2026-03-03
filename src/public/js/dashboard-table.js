document.addEventListener("DOMContentLoaded", function () {



  const chartDom = document.getElementById("workout-chart");
  const chart = echarts.init(chartDom);

  const baseOption = {

    tooltip: {
      trigger: "axis"
    },

    legend: {
      data: ["Power", "Heart Rate", "Cadence"]
    },

    dataset: {
      source: []   // wird später befüllt
    },
    xAxis: {
      type: "value",
      axisLabel: {
        formatter: function (value) {
          const h = Math.floor(value / 3600);
          const m = Math.floor((value % 3600) / 60);
          const s = value % 60;
          return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
        }
      }
    },
    /*xAxis: {
      type: "category"
    },*/

    yAxis: [
      { type: "value", name: "Power (W)", position: "left" },
      { type: "value", name: "HR (bpm)", position: "right" },
      { type: "value", name: "Cadence", position: "right", offset: 60 }
    ],

    series: [
      {
        name: "Power",
        type: "line",
        yAxisIndex: 0,
        encode: { x: 0, y: 1 },
        showSymbol: false
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
      }
    ],

    dataZoom: [
      {
        type: "inside",
        xAxisIndex: 0,
        filterMode: "none"
      },
      {
        type: "slider",
        xAxisIndex: 0
      }
    ],

    animation: false
  };

  chart.setOption(baseOption);




  const table = new Tabulator("#file-table", {

    // 🔹 neue Route
    ajaxURL: "/files/workouts",
    ajaxConfig: "GET",

    pagination: "remote",
    paginationSize: 20,
    paginationInitialPage: 1,

    layout: "fitColumns",
    height: "600px",

    // Tabulator erwartet nur das data-Array zurück
    ajaxResponse: function (url, params, response) {
      return response.data;
    },

    columns: [
      {
        title: "File",
        field: "original_filename",
        sorter: "string",
        headerFilter: "input"
      },
      {
        title: "Distance (km)",
        field: "total_distance",
        sorter: "number",
        formatter: function (cell) {
          const meters = cell.getValue() || 0;
          return (meters / 1000).toFixed(2);
        }
      },
      {
        title: "Avg Speed (km/h)",
        field: "avg_speed",
        sorter: "number",
        formatter: function (cell) {
          const mps = cell.getValue() || 0;
          return (mps * 3.6).toFixed(1);
        }
      },
      {
        title: "Avg Power",
        field: "avg_power",
        sorter: "number"
      },
      {
        title: "Start Time",
        field: "start_time",
        sorter: "datetime",
        formatter: function (cell) {
          const value = cell.getValue();
          return value ? new Date(value).toLocaleDateString() : "";
        }
      }
    ],

  });

  // ----------------------
  // 3️⃣ Row Click Event
  // ----------------------


  table.on("rowClick", async function (e, row) {

    const workoutId = row.getData().id;

    chart.showLoading();

    try {
      const response = await fetch(`/files/workouts/${workoutId}/data`);
      const { t, p, h, c } = await response.json();

      // Dataset aufbauen
      const source = t.map((time, i) => [
        time,
        p[i],
        h[i],
        c[i]
      ]);

      chart.setOption({
        dataset: {
          source: source
        }
      });

    } catch (err) {
      console.error(err);
    } finally {
      chart.hideLoading();
    }
  });

  // Responsive
  window.addEventListener("resize", function () {
    chart.resize();
  });


});
