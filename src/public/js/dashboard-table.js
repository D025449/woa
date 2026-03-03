document.addEventListener("DOMContentLoaded", function () {



  const chartDom = document.getElementById("workout-chart");
  const chart = echarts.init(chartDom);

  const baseOption = {

    /*tooltip: {
      trigger: "axis"
    },*/

    tooltip: {
      trigger: "item",
      formatter: function (params) {

        // Falls markArea Hover
    // markArea
    if (params.componentType === "markArea") {
      const d = params.data;
      return `
        <b>Segment</b><br/>
        Type: ${d.segmentType}<br/>
        AvgPwr: ${d.avgPower}
      `;
    }

        // Normale Linienanzeige
        let result = params[0].axisValueLabel + "<br/>";
        params.forEach(p => {
          result += `${p.marker} ${p.seriesName}: ${p.value[1]}<br/>`;
        });

        return result;
      }
    },


    legend: {
      data: ["Power", "Heart Rate", "Cadence"]
    },

    dataset: {
      source: []   // wird später befüllt
    },
    xAxis: {
      type: "value",
      boundaryGap: false,
      scale: true,
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
        showSymbol: false,
        markArea: {
          silent: false,
          label: { show: false },
          data: []
        }
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
      //const { t, p, h, c } = await response.json();
      const { data, segments } = await response.json();

      //segments.push( { start : 200, end : 560 });

      const maxX = data[data.length - 1][0];
      console.log(data[data.length - 1][0]);

      const segmentAreas = segments.map(seg => [
        {
          xAxis: seg.start,
          segmentType: seg.type,
          name: seg.type,
          segmentDuration: seg.segmentDuration,
          avgPower: seg.avgPower,
          itemStyle: { color: "rgba(255,0,0,0.15)" }
        },
        { xAxis: seg.end }
      ]);

      chart.setOption({
        dataset: {
          source: data
        },

        xAxis: {
          max: maxX
        },

        series: [{
          name: "Power",
          markArea: {
            silent: false,
            label: { show: false },
            tooltip: {
              formatter: function (params) {
                const data = params.data;

                return `
          <b>Segment</b><br/>
          Type: ${data.segmentType}<br/>
          AgvPwr: ${data.avgPower}<br/>
        `;
              }
            },
            data: segmentAreas
          }
        }],
        dataZoom: [
          {
            type: "inside",
            start: 0,
            end: 100
          },
          {
            type: "slider",
            start: 0,
            end: 100
          }
        ]
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
