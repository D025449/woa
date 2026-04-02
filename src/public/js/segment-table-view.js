import Utils from "../../shared/Utils.js";

export default class TableView {

  constructor(containerSelector, handlers = {}) {
    this.containerSelector = containerSelector;
    this.handlers = handlers;
    this.currentSegment = null;

    this.table = this.initTable();
    this.registerEvents();
  }

  // -----------------------------
  // INIT
  // -----------------------------
  initTable() {
    const THAT = this;
    return new Tabulator(this.containerSelector, {
      //ajaxURL: "/files/workouts",

      /*ajaxResponse: (url, params, response) => {
        console.log(response);

        document.getElementById("files_header").innerText =
          response.total_records + " Workouts";

        return response;
      },*/
      /*ajaxRequesting: function (url, params) {
        console.log("ID:", THAT.currentSegment.id);
        console.log("Params:", params);
        return true;
      },*/

      /*ajaxRequestFunc: function (url, config, params) {
        const query = new URLSearchParams(params).toString();
        return fetch(`${url}?${query}`, config)
          .then(response => {
            if (response.status === 401) {
              window.location.href = "/login";
              return {last_page: 0, total_records: 0, data: []  };
            }
            else if (response.status === 404) {
              console.error(response.status);
              return {last_page: 0, total_records: 0, data: []  };

            }
            return response.json();
          });
      },*/



      ajaxConfig: "GET",
      layout: "fitColumns",
      height: "300px",
      sortMode: "remote",
      filterMode: "remote",
      paginationSize: 20,
      progressiveLoad: "scroll",
      progressiveLoadScrollMargin: 100,

      paginationDataSent: {
        page: "page",
        size: "size"
      },

      dataReceiveParams: {
        last_page: "last_page",
        last_row: "total_records"
      },

      initialSort: [{ column: "avg_power", dir: "desc" }],

      columns: this.buildColumns()
    });
  }

  // -----------------------------
  // COLUMNS
  // -----------------------------
  buildColumns() {
    return [
      {
        title: "Start On",
        field: "start_time",
        sorter: "datetime",
        formatter: (cell) => new Date(cell.getValue()).toLocaleString()
      },
      {
        title: "Duration",
        field: "total_timer_time",
        sorter: "number",
        formatter: (cell) => Utils.formatDuration(cell.getValue())
      },
      {
        title: "Distance (km)",
        field: "total_distance",
        sorter: "number",
        headerFilter: "input",
        headerFilterFunc: ">=",
        formatter: (cell) => cell.getValue().toFixed(2)
      },
      {
        title: "Avg Speed (km/h)",
        field: "avg_speed",
        sorter: "number",
        headerFilter: "input",
        headerFilterFunc: ">=",
        formatter: (cell) => cell.getValue().toFixed(1)
      },
      {
        title: "Avg Power",
        field: "avg_power",
        sorter: "number",
        headerFilter: "input",
        headerFilterFunc: ">=",
        formatter: (cell) => cell.getValue().toFixed(0)
      },
      {
        title: "Avg Hr",
        field: "avg_heart_rate",
        sorter: "number",
        headerFilter: "input",
        headerFilterFunc: ">=",
        formatter: (cell) => cell.getValue().toFixed(0)
      },
      {
        title: "Norm Power",
        field: "avg_normalized_power",
        sorter: "number",
        headerFilter: "input",
        headerFilterFunc: ">=",
        formatter: (cell) => cell.getValue().toFixed(0)
      },
      {
        title: "FTP",
        field: "ftp",
        sorter: false,
        headerSort: false,
        headerFilter: false,
        formatter: (cell) => cell.getValue().toFixed(0)
      },
      {
        title: "TSS",
        field: "TSS",
        sorter: false,
        headerSort: false,
        headerFilter: false,
        formatter: (cell) => cell.getValue().toFixed(0)
      },
      {
        title: "Actions",
        width: 160,
        formatter: () =>
          `<button class="btn btn-sm btn-danger delete-btn">Delete</button>`,
        cellClick: async (e, cell) => {
          const row = cell.getRow();

          if (e.target.classList.contains("delete-btn")) {
            e.stopPropagation();
            await this.handlers.onRowDelete?.(row);
          }
        }
      }
    ];
  }

  // -----------------------------
  // EVENTS
  // -----------------------------
  registerEvents() {
    this.table.on("rowClick", (e, row) =>
      this.handlers.onRowOpen?.(e, row)
    );
  }

  async loadSegment(e, segment) {
    this.currentSegment = segment;
    const hdr = document.getElementById("segment-header");
    if (hdr) {
      hdr.innerText = `📍➡️📍 ${segment.start.name} - ${segment.end.name}: ${(segment.distance / 1000).toFixed(2)} km`;
    }
    await this.loadSegmentBestEfforts(segment);




  }

  async loadSegmentBestEfforts(segment) {
    //const segid 

    this.table.setData(`/segments/bestefforts/${segment.id}/data`);

  }


  // -----------------------------
  // PUBLIC API
  // -----------------------------
  getTable() {
    return this.table;
  }

  reload() {
    this.table.replaceData();
  }

  clear() {
    this.table.clearData();
  }
}


