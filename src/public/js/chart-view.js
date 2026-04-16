import { buildMarkAreas, buildMarkAreasCP } from "./chart-helpers.js";
import SegmentService from "../../shared/SegmentService.js";
import Utils from "../../shared/Utils.js";

export default class ChartView {

  constructor(containerId, handlers = {}) {
    this.chart = echarts.init(document.getElementById(containerId));

    this.handlers = handlers;

    this.selectionStart = null;
    this.currentWorkout = null;
    this.mode = "";
    this.createButton = document.getElementById('draw-segment-toggle');
    this.createGpsButton = document.getElementById('draw-gps-segment-toggle');
    this.deleteButton = document.getElementById('delete-segments');

    this.initUI();
    this.initChart();
    this.registerInteractions();
  }

  // -----------------------------
  // INIT
  // -----------------------------
  initUI() {
    this.createButton?.addEventListener('click', () => {
      this.setMode(this.mode === "create" ? "" : "create");
    });
    this.createGpsButton?.addEventListener('click', () => {
      if (this.createGpsButton.disabled) {
        return;
      }

      this.setMode(this.mode === "gps-create" ? "" : "gps-create");
    });
    this.deleteButton?.addEventListener('click', () => {
      this.setMode(this.mode === "delete" ? "" : "delete");
    });

    this.syncModeButtons();
  }

  initChart() {
    this.chart.setOption({
      title: { text: "..." },
      tooltip: {
        trigger: "axis",
        confine: true,
        axisPointer: { type: "line", snap: true },
        formatter: (params) => this.formatTooltip(params)
      },
      animation: false,
      legend: {},
      grid: { top: 80 },
      xAxis: {
        type: "value",
        scale: true,
        minInterval: 1,
        axisLabel: { formatter: Utils.formatSeconds }
      },
      yAxis: [
        { type: "value", name: "Power (W)", position: "left" },
        { type: "value", name: "HR/Cad", position: "right" },
        { type: "value", name: "Sp", position: "left", offset: 40 },
        { type: "value", name: "Alt", position: "right", offset: 50 }
      ],
      dataset: {
        dimensions: [
          "x", "Power", "Heartrate", "Cadence",
          "Speed", "Altitude"
          //, "PowerS5", "PowerS15",
          //"SpeedS5", "AltitudeS7"
        ],
        source: []
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
          encode: { x: "x", y: "Power" }
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
          encode: { x: "x", y: "Speed" }
        },
        {
          name: "Altitude",
          type: "line",
          showSymbol: false,
          sampling: "lttb",
          yAxisIndex: 3,
          encode: { x: "x", y: "Altitude" }
        }
      ]
    });
  }

  // -----------------------------
  // DATA UPDATE
  // -----------------------------
  updateWorkout(workout) {
    this.currentWorkout = workout;
    if (!workout?.validGps && this.mode === "gps-create") {
      this.setMode("");
    } else {
      this.syncModeButtons();
    }
    const obj = workout.workoutObject;
    const result = obj.getAsStrideArray({ smoothing: { power: 10, speed: 30, cadence: 30 } });
    const sd = obj.getStartTime();

    this.chart.setOption({
      title: { text: new Date(sd).toDateString() },
      xAxis: { min: 0, max: result.rowCount },
      dataset: { source: result.data }, //workout.series },
      series: [{
        name: "Power",
        markArea: { data: buildMarkAreas(workout) }
      }]
    });
  }

  updateWorkoutCP(workout, cpview) {
    this.currentWorkout = workout;
    if (!workout?.validGps && this.mode === "gps-create") {
      this.setMode("");
    } else {
      this.syncModeButtons();
    }
    const obj = workout.workoutObject;
    const result = obj.getAsStrideArray();
    const sd = obj.getStartTime();

    this.chart.setOption({
      title: { text: new Date(cpview.startTime).toDateString() },
      xAxis: { min: 0, max: result.rowCount },
      dataset: { source: result.data }, //workout.series },
      series: [{
        name: "Power",
        markArea: { data: buildMarkAreasCP(cpview) }
      }]
    });
  }

  // -----------------------------
  // INTERACTIONS
  // -----------------------------
  registerInteractions() {
    this.chart.on("click", async (params) => {
      if (params.componentType !== "markArea") return;

      const seg = this.currentWorkout.segments.find(s => s.id === params.data.segmentId);

      if (this.mode === "create" || this.mode === "gps-create") {
        return;
      }

      if (this.mode === "delete") {
        //seg.rowstate = 'DEL';
        SegmentService.deleteSegment(this.currentWorkout, seg) 
        this.handlers.onUpdateWorkout?.(this.currentWorkout);
      } else {
        this.handlers.onZoomSegment?.(
          params.data.coord[0][0],
          params.data.coord[1][0]
        );
      }
    });

    this.chart.getZr().on("mousemove", (p) => {
      const x = this.chart.convertFromPixel({ xAxisIndex: 0 }, p.offsetX);
      if (!isNaN(x)) this.handlers.onChartHoverIndex?.(Math.round(x));
    });

    this.chart.getZr().on('mousedown', (e) => {
      if (this.mode !== "create" && this.mode !== "gps-create") return;

      const data = this.chart.convertFromPixel({ seriesIndex: 0 }, [e.offsetX, e.offsetY]);
      this.selectionStart = data[0];
    });

    this.chart.getZr().on('mouseup', async (e) => {
      if (this.mode !== "create" && this.mode !== "gps-create") {
        this.selectionStart = null;
        return;
      }

      if (this.selectionStart == null) return;

      const data = this.chart.convertFromPixel({ seriesIndex: 0 }, [e.offsetX, e.offsetY]);

      const startEnd = {
        startIndex: Math.round(this.selectionStart),
        endIndex: Math.round(data[0])
      };

      if (this.mode === "gps-create") {
        const gpsSegment = await SegmentService.createAddNewGpsSegment(this.currentWorkout, startEnd);
        this.handlers.onGpsSegmentCreated?.(gpsSegment);
      } else {
        await SegmentService.createAddNewSegment(this.currentWorkout, startEnd);
        this.handlers.onUpdateWorkout?.(this.currentWorkout);
      }
      this.selectionStart = null;
    });
  }

  // -----------------------------
  // UI HELPERS
  // -----------------------------
  setMode(mode) {
    this.mode = mode;
    this.selectionStart = null;
    this.setDrawingMode(mode === "create");
    this.syncModeButtons();
  }

  syncModeButtons() {
    const canCreateGps = !!this.currentWorkout?.validGps;

    if (this.createButton) {
      const isCreate = this.mode === "create";
      this.createButton.classList.toggle('btn-primary', isCreate);
      this.createButton.classList.toggle('btn-outline-primary', !isCreate);
      this.createButton.setAttribute(
        "title",
        isCreate
          ? "Create-Segment-Modus aktiv. Ziehe im Chart einen Bereich auf, um ein neues Segment anzulegen."
          : "Create-Segment-Modus aktivieren."
      );
      this.createButton.setAttribute(
        "aria-pressed",
        isCreate ? "true" : "false"
      );
    }

    if (this.createGpsButton) {
      const isGpsCreate = this.mode === "gps-create";
      this.createGpsButton.disabled = !canCreateGps;
      this.createGpsButton.classList.toggle('btn-success', isGpsCreate);
      this.createGpsButton.classList.toggle('btn-outline-success', !isGpsCreate);
      this.createGpsButton.setAttribute(
        "title",
        canCreateGps
          ? (
              isGpsCreate
                ? "Create-GPS-Segment-Modus aktiv. Ziehe im Chart einen Bereich auf, um ein GPS-Segment zu erzeugen."
                : "Create-GPS-Segment-Modus aktivieren."
            )
          : "Nur verfuegbar, wenn das Workout gueltige GPS-Daten hat."
      );
      this.createGpsButton.setAttribute(
        "aria-pressed",
        isGpsCreate ? "true" : "false"
      );
    }

    if (this.deleteButton) {
      const isDelete = this.mode === "delete";
      this.deleteButton.classList.toggle('btn-danger', isDelete);
      this.deleteButton.classList.toggle('btn-outline-danger', !isDelete);
      this.deleteButton.setAttribute(
        "title",
        isDelete
          ? "Delete-Segment-Modus aktiv. Klicke auf ein vorhandenes Segment, um es zu löschen."
          : "Delete-Segment-Modus aktivieren."
      );
      this.deleteButton.setAttribute(
        "aria-pressed",
        isDelete ? "true" : "false"
      );
    }
  }

  setDrawingMode(enabled) {
    this.chart.getZr().setCursorStyle(enabled ? "crosshair" : "default");
    this.chart.setOption({
      dataZoom: [{
        type: 'inside',
        zoomOnMouseWheel: true,
        moveOnMouseMove: !enabled
      }]
    });
  }

  zoomToSegment(start, end) {
    this.chart.dispatchAction({
      type: "dataZoom",
      startValue: start,
      endValue: end
    });
  }

  formatTooltip(params) {
    const p = params?.[0];
    if (!p) return "";

    const row = p.data;
    return `
      ⚡ ${row[1] ?? "-"} W<br/>
      ❤️ ${row[2] ?? "-"} bpm<br/>
      🔁 ${row[3] ?? "-"} rpm
    `;
  }

  resize() { this.chart.resize(); }
  showLoading() { this.chart.showLoading(); }
  hideLoading() { this.chart.hideLoading(); }
}
