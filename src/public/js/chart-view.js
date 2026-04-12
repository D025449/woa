import { buildMarkAreas, buildMarkAreasCP } from "./chart-helpers.js";
import SegmentService from "../../shared/SegmentService.js";
import Utils from "../../shared/Utils.js";

export default class ChartView {

  constructor(containerId, handlers = {}) {
    this.chart = echarts.init(document.getElementById(containerId));

    this.handlers = handlers;

    this.selectionStart = null;
    this.currentWorkout = null;
    this.isSegmentMode = false;
    this.editMode = "";
    this.currentSegment = null;

    this.editor = document.getElementById('segment-editor');
    this.input = document.getElementById('segment-name-input');

    this.initUI();
    this.initChart();
    this.registerInteractions();
  }

  // -----------------------------
  // INIT
  // -----------------------------
  initUI() {
    document.getElementById('draw-segment-toggle')?.addEventListener('click', (e) => {
      this.isSegmentMode = !this.isSegmentMode;

      e.target.classList.toggle('btn-primary', this.isSegmentMode);
      e.target.classList.toggle('btn-outline-primary', !this.isSegmentMode);

      this.setDrawingMode(this.isSegmentMode);
      this.editMode = this.isSegmentMode ? 'CreSeg' : '';
    });

    document.getElementById('save-segments')?.addEventListener('click', () => {
      SegmentService.storeSegments(this.currentWorkout);
    });

    document.getElementById('delete-segments')?.addEventListener('click', () => {
      this.isSegmentMode = !this.isSegmentMode;
      this.editMode = this.isSegmentMode ? 'DelSeg' : '';
    });

    this.input?.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.hideSegmentEditor();

      if (e.key === 'Enter') {
        if (this.currentSegment && this.currentSegment.name !== this.input.value) {
          this.currentSegment.segmentname = this.input.value;

          if (this.currentSegment.rowstate === 'DB') {
            this.currentSegment.rowstate = 'UPD';
            this.handlers.onUpdateWorkout?.(this.currentWorkout);
          }
        }
        this.hideSegmentEditor();
      }
    });
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
    const obj = workout.workoutObject;
    const result = obj.getAsStrideArray();
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
    this.chart.on("click", (params) => {
      if (params.componentType !== "markArea") return;

      const seg = this.currentWorkout.segments.find(s => s.id === params.data.segmentId);

      if (this.editMode === 'DelSeg') {
        seg.rowstate = 'DEL';
        this.handlers.onUpdateWorkout?.(this.currentWorkout);
      } else {
        this.handlers.onZoomSegment?.(
          params.data.coord[0][0],
          params.data.coord[1][0]
        );
      }

      this.showSegmentEditor(seg);
    });

    this.chart.getZr().on("mousemove", (p) => {
      const x = this.chart.convertFromPixel({ xAxisIndex: 0 }, p.offsetX);
      if (!isNaN(x)) this.handlers.onChartHoverIndex?.(Math.round(x));
    });

    this.chart.getZr().on('mousedown', (e) => {
      if (!this.isSegmentMode) return;

      const data = this.chart.convertFromPixel({ seriesIndex: 0 }, [e.offsetX, e.offsetY]);
      this.selectionStart = data[0];
    });

    this.chart.getZr().on('mouseup', (e) => {
      if (this.selectionStart == null) return;

      const data = this.chart.convertFromPixel({ seriesIndex: 0 }, [e.offsetX, e.offsetY]);

      SegmentService.createAddNewSegment(this.currentWorkout, {
        startIndex: Math.round(this.selectionStart),
        endIndex: Math.round(data[0])
      });

      this.handlers.onUpdateWorkout?.(this.currentWorkout);
      this.selectionStart = null;
    });
  }

  // -----------------------------
  // UI HELPERS
  // -----------------------------
  showSegmentEditor(segment) {
    this.currentSegment = segment;
    this.input.value = segment.segmentname || '';
    this.editor.classList.remove('d-none');
    this.input.focus();
  }

  hideSegmentEditor() {
    this.currentSegment = null;
    this.editor.classList.add('d-none');
  }

  setDrawingMode(enabled) {
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
