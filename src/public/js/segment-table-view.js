import Utils from "../../shared/Utils.js";
import { createTranslator } from "./i18n.js";

export default class TableView {

  constructor(containerSelector, handlers = {}) {
    this.t = createTranslator("segmentsPage");
    this.containerSelector = containerSelector;
    this.handlers = handlers;
    this.currentSegment = null;
    this.pollTimer = null;
    this.pollAttempt = 0;
    this.scopeValue = handlers.initialScope ?? "mine";
    this.scopeMineButton = document.getElementById(handlers.scopeMineButtonId || "segment-bestefforts-scope-mine");
    this.scopeSharedButton = document.getElementById(handlers.scopeSharedButtonId || "segment-bestefforts-scope-shared");
    this.scopeAllButton = document.getElementById(handlers.scopeAllButtonId || "segment-bestefforts-scope-all");
    this.scopeToggle = document.querySelector(handlers.scopeToggleSelector || ".segment-bestefforts-scope-toggle");

    this.table = this.initTable();
    this.updateScopeButtons();
    this.setScopeVisibility(false);
    this.registerEvents();
  }

  // -----------------------------
  // INIT
  // -----------------------------
  initTable() {
    const THAT = this;
    return new Tabulator(this.containerSelector, {
      //ajaxURL: "/files/workouts",

      ajaxResponse: (url, params, response) => {
        console.log(response);
        const hdr = document.getElementById("segment-header");
        if (hdr) {
          hdr.innerText = THAT.formatSegmentHeader(THAT.currentSegment, response.total_records);
        }


        return response;
      },

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

      initialSort: [{ column: "duration", dir: "asc" }],

      columns: this.buildColumns()
    });
  }

  // -----------------------------
  // COLUMNS
  // -----------------------------
  buildColumns() {
    return [
      {
        title: this.t("table.rank"),
        field: "rn",
        sorter: false,
        formatter: (cell) => cell.getValue()
      },
      {
        title: this.t("table.duration"),
        field: "duration",
        sorter: "number",
        formatter: (cell) => Utils.formatDuration(cell.getValue())
      },
      {
        title: this.t("table.workoutId"),
        field: "wid",
        sorter: "number",
        formatter: (cell) => {
          const workoutId = cell.getValue();
          if (!workoutId) {
            return "";
          }

          return `<a href="/dashboard-new?workoutId=${encodeURIComponent(workoutId)}" class="fw-semibold text-decoration-underline">#${workoutId}</a>`;
        }
      },
      {
        title: this.t("table.owner"),
        field: "owner_display_name",
        sorter: false,
        formatter: (cell) => {
          const rowd = cell.getRow().getData();
          const ownerId = rowd.uid == null ? "" : String(rowd.uid);
          const currentUserId = this.handlers.currentUserId == null ? "" : String(this.handlers.currentUserId);

          if (ownerId !== "" && ownerId === currentUserId) {
            return "";
          }

          return rowd.owner_display_name || rowd.owner_email || "";
        }
      },       
      {
        title: this.t("table.startOn"),
        field: "start_time",
        sorter: "datetime",
        formatter: (cell) =>  {
          const rowd = cell.getRow().getData();
          return `${new Date(cell.getValue()).toLocaleDateString()} + ${Utils.formatStartIndex(rowd.start_offset)} `;
        }
      },
      /*{
        title: "Distance (km)",
        field: "total_distance",
        sorter: "number",
        headerFilter: "input",
        headerFilterFunc: ">=",
        formatter: (cell) => cell.getValue().toFixed(2)
      },*/
      {
        title: this.t("table.avgSpeed"),
        field: "avg_speed",
        sorter: "number",
        headerFilter: "input",
        headerFilterFunc: ">=",
        formatter: (cell) => (cell.getValue()).toFixed(1)
      },
      {
        title: this.t("table.avgPower"),
        field: "avg_power",
        sorter: "number",
        headerFilter: "input",
        headerFilterFunc: ">=",
        formatter: (cell) => cell.getValue().toFixed(0)
      },
      {
        title: this.t("table.avgHr"),
        field: "avg_heart_rate",
        sorter: "number",
        headerFilter: "input",
        headerFilterFunc: ">=",
        formatter: (cell) => cell.getValue().toFixed(0)
      }
      /*{
        title: "Norm Power",
        field: "avg_normalized_power",
        sorter: "number",
        headerFilter: "input",
        headerFilterFunc: ">=",
        formatter: (cell) => cell.getValue().toFixed(0)
      },*/
      /*{
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
      },*/
      /*{
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
      }*/
    ];
  }

  // -----------------------------
  // EVENTS
  // -----------------------------
  registerEvents() {
    this.table.on("rowClick", (e, row) => {
      if (e.target.closest("a")) {
        return;
      }

      this.handlers.onRowOpen?.(e, row);
    });

    [this.scopeMineButton, this.scopeSharedButton, this.scopeAllButton].forEach((button) => {
      button?.addEventListener("click", async () => {
        this.scopeValue = button.dataset.segmentBesteffortsScope || "mine";
        this.updateScopeButtons();
        this.handlers.onScopeChange?.(this.scopeValue);
        if (this.currentSegment) {
          await this.loadSegmentBestEfforts(this.currentSegment);
        }
      });
    });
  }

  async loadSegment(e, segment) {
    this.currentSegment = segment;
    this.stopBestEffortsPolling();
    const hdr = document.getElementById("segment-header");
    if (hdr) {
      hdr.innerText = this.formatSegmentHeader(segment);
    }
    await this.loadSegmentBestEfforts(segment);




  }

  async loadSegmentBestEfforts(segment) {
    //const segid 

    await this.table.setData(`/segments/bestefforts/${segment.id}/data?scope=${encodeURIComponent(this.scopeValue || "mine")}`);

    if (this.shouldPollBestEfforts(segment)) {
      this.startBestEffortsPolling(segment.id);
    }

  }

  clear() {
    this.currentSegment = null;
    this.stopBestEffortsPolling();
    this.table.clearData();
  }

  shouldPollBestEfforts(segment) {
    return segment?.bestEffortsStatus === "queued" || segment?.bestEffortsStatus === "processing";
  }

  startBestEffortsPolling(segmentId) {
    this.stopBestEffortsPolling();
    this.pollAttempt = 0;

    const tick = async () => {
      if (!this.currentSegment || this.currentSegment.id !== segmentId) {
        this.stopBestEffortsPolling();
        return;
      }

      this.pollAttempt += 1;

      try {
        const res = await fetch(`/segments/${segmentId}/best-efforts-status`);
        if (!res.ok) {
          throw new Error(this.t("messages.failedBestEffortsStatus"));
        }

        const data = await res.json();
        this.currentSegment.bestEffortsStatus = data.status;

        if (data.status === "completed" || data.status === "failed") {
          await this.table.setData(`/segments/bestefforts/${segmentId}/data?scope=${encodeURIComponent(this.scopeValue || "mine")}`);
          this.stopBestEffortsPolling();
          return;
        }

        if (this.pollAttempt >= 20) {
          this.stopBestEffortsPolling();
          return;
        }

        this.pollTimer = window.setTimeout(tick, 1000);
      } catch (err) {
        console.error(err);
        this.stopBestEffortsPolling();
      }
    };

    this.pollTimer = window.setTimeout(tick, 1000);
  }

  stopBestEffortsPolling() {
    if (this.pollTimer) {
      window.clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  updateScopeButtons() {
    this.scopeMineButton?.classList.toggle("active", this.scopeValue === "mine");
    this.scopeSharedButton?.classList.toggle("active", this.scopeValue === "shared");
    this.scopeAllButton?.classList.toggle("active", this.scopeValue === "all");
  }

  setScopeVisibility(visible) {
    this.scopeToggle?.classList.toggle("is-hidden", !visible);
  }

  formatSegmentHeader(segment, matchCount = null) {
    if (!segment) {
      return this.t("insightsTitle");
    }

    const ownerLabel = segment.ownerDisplayName || segment.ownerEmail || null;
    const ownerPart = ownerLabel ? ` · ${this.t("table.ownerShort")}: ${ownerLabel}` : "";
    const matchPart = Number.isFinite(matchCount) ? ` · ${this.t("table.matches", { count: matchCount })}` : "";
    return `📍➡️📍 #${segment.id}: ${segment.start.name} - ${segment.end.name}: ${(segment.distance / 1000).toFixed(2)} km ${segment.ascent} hm${ownerPart}${matchPart}`;
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
}
