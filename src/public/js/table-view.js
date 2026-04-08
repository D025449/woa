import Utils from "../../shared/Utils.js";

export default class TableView {

  constructor(containerSelector, handlers = {}) {
    this.containerSelector = containerSelector;
    this.handlers = handlers;

    this.table = this.initTable();
    this.registerEvents();
  }

  // -----------------------------
  // INIT
  // -----------------------------
  initTable() {
    return new Tabulator(this.containerSelector, {
      ajaxURL: "/files/workouts",

      ajaxResponse: (url, params, response) => {
        console.log(response);

        document.getElementById("files_header").innerText =
          response.total_records + " Workouts";

        return response;
      },

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

      initialSort: [{ column: "start_time", dir: "desc" }],

      columns: this.buildColumns()
    });
  }

  // -----------------------------
  // COLUMNS
  // -----------------------------
  buildColumns() {
    return [
      {
        title: "ID",
        field: "id",
        sorter: "number",
        formatter: (cell) => cell.getValue()
      },      
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

/*import Utils from "../../shared/Utils.js";

export function createTableView(containerSelector, handlers = {}) {
  const table = new Tabulator(containerSelector, {
    ajaxURL: "/files/workouts",
    ajaxResponse: function (url, params, response) {
      // 🔥 hier hast du Zugriff auf deine API Response
      console.log(response);

      // Beispiel: total_records anzeigen
      document.getElementById("files_header").innerText = response.total_records + " Workouts";

      // 👉 WICHTIG: Daten zurückgeben!
      return response;
    },
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
    initialSort: [{ column: "start_time", dir: "desc" }],
    columns: [
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
        //headerFilter: "input",
        //headerFilterFunc: ">=",
        formatter: (cell) => cell.getValue().toFixed(0)
      },

      {
        title: "Actions",
        width: 160,
        formatter: () => `<button class="btn btn-sm btn-danger delete-btn">Delete</button>`,
        cellClick: async (e, cell) => {
          const row = cell.getRow();

          if (e.target.classList.contains("delete-btn")) {
            e.stopPropagation();
            await handlers.onRowDelete?.(row);
          }
        }
      }
    ]
  });

  table.on("rowClick", (e, row) => handlers.onRowOpen?.(e, row));

  return table;
}*/