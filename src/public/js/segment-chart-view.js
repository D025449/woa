import { buildMarkAreasSegment, buildMarkAreasCP } from "./chart-helpers.js";
import SegmentService from "../../shared/SegmentService.js";
import Utils from "../../shared/Utils.js";
import { createTranslator } from "./i18n.js";

export default class ChartView {

  constructor(containerId, handlers = {}) {
    this.t = createTranslator("segmentsPage.chart");
    this.container = document.getElementById(containerId);
    this.chart = echarts.init(this.container);

    this.handlers = handlers;

    this.selectionStart = null;
    this.currentWorkout = null;
    this.isSegmentMode = false;
    this.editMode = "";
    this.currentSegment = null;
    this.currentSegment = null;
    this.isHoveringSegmentArea = false;
    this.baseMarkAreas = [];
    this.previewMarkArea = null;
    this.activePointerId = null;

    this.editor = document.getElementById('segment-editor');
    this.input = document.getElementById('segment-name-input');

    this.initSegmentHoverTooltip();
    this.initUI();
    this.initChart();
    this.registerInteractions();
    this.registerPointerInteractions();
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
    const labels = this.getChartLabels();
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
        { type: "value", name: labels.axisPower, position: "left" },
        { type: "value", name: labels.axisHeartCadence, position: "right" },
        { type: "value", name: labels.axisSpeed, position: "left", offset: 40 },
        { type: "value", name: labels.axisAltitude, position: "right", offset: 50 }
      ],
      dataset: {
        dimensions: [
          "x", "Power", "Heartrate", "Cadence",
          "Speed", "Altitude", "DistanceKm"
        ],
        source: []
      },
      dataZoom: [
        { type: "inside", xAxisIndex: 0, filterMode: "none" },
        { type: "slider", xAxisIndex: 0 }
      ],
      series: [
        {
          name: labels.power,
          type: "line",
          showSymbol: false,
          sampling: "lttb",
          yAxisIndex: 0,
          markArea: { data: [] },
          encode: { x: "x", y: "Power" }
        },
        {
          name: labels.heartRate,
          type: "line",
          showSymbol: false,
          sampling: "lttb",
          yAxisIndex: 1,
          encode: { x: "x", y: "Heartrate" }
        },
        {
          name: labels.cadence,
          type: "line",
          showSymbol: false,
          sampling: "lttb",
          yAxisIndex: 1,
          encode: { x: "x", y: "Cadence" }
        },
        {
          name: labels.speed,
          type: "line",
          showSymbol: false,
          sampling: "lttb",
          yAxisIndex: 2,
          encode: { x: "x", y: "Speed" }
        },
        {
          name: labels.altitude,
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
  updateWorkout(workout, segment) {
    this.currentWorkout = workout;
    this.currentSegment = segment;
    const obj = workout.workoutObject;
    const result = obj.getAsStrideArray();
    const sd = obj.getStartTime();     
    const labels = this.getChartLabels();

    this.chart.setOption({
      title: { text: new Date(sd).toDateString() },
      xAxis: { min: 0, max: result.rowCount },
      dataset: { source: result.data },
      series: [{
        name: labels.power,
        markArea: { data: [] }
      }]
    });
    this.baseMarkAreas = buildMarkAreasSegment(segment);
    this.applyMarkAreas();
  }

  updateWorkoutCP(workout, cpview) {
    this.currentWorkout = workout;
    const labels = this.getChartLabels();
    

    this.chart.setOption({
      title: { text: new Date(cpview.startTime).toDateString() },
      xAxis: { min: 0, max: workout.recCount },
      dataset: { source: workout.series },
      series: [{
        name: labels.power,
        markArea: { data: [] }
      }]
    });
    this.baseMarkAreas = buildMarkAreasCP(cpview);
    this.applyMarkAreas();
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

    this.chart.on("mouseover", (params) => {
      if (params.componentType !== "markArea") {
        return;
      }

      const seg = this.getSegmentFromMarkAreaParams(params);
      if (!seg) {
        return;
      }

      this.isHoveringSegmentArea = true;
      this.chart.dispatchAction({ type: "hideTip" });
      this.showSegmentHoverTooltip(seg, params.event?.event);
    });

    this.chart.on("mousemove", (params) => {
      if (params.componentType !== "markArea" || !this.isHoveringSegmentArea) {
        return;
      }

      const seg = this.getSegmentFromMarkAreaParams(params);
      if (!seg) {
        return;
      }

      this.showSegmentHoverTooltip(seg, params.event?.event);
    });

    this.chart.on("mouseout", (params) => {
      if (params.componentType !== "markArea") {
        return;
      }

      this.hideSegmentHoverTooltip();
    });

    this.chart.on("globalout", () => {
      this.hideSegmentHoverTooltip();
    });
  }

  registerPointerInteractions() {
    const dom = this.chart?.getDom?.();
    if (!dom) {
      return;
    }

    dom.addEventListener("pointerdown", (event) => {
      if (!this.isSegmentMode) return;
      if (!event.isPrimary) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;

      const xValue = this.getPointerXValue(event);
      if (xValue == null || Number.isNaN(xValue)) {
        return;
      }

      this.activePointerId = event.pointerId;
      this.selectionStart = xValue;
      this.updateSelectionPreview(xValue);
      dom.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    }, { passive: false });

    dom.addEventListener("pointermove", (event) => {
      if (this.selectionStart == null) return;
      if (this.activePointerId != null && event.pointerId !== this.activePointerId) return;

      const xValue = this.getPointerXValue(event);
      if (xValue == null || Number.isNaN(xValue)) {
        return;
      }

      this.updateSelectionPreview(xValue);
      event.preventDefault();
    }, { passive: false });

    const finish = (event) => {
      if (this.selectionStart == null) return;
      if (this.activePointerId != null && event.pointerId !== this.activePointerId) return;

      const xValue = this.getPointerXValue(event);
      this.finishSelectionDrag(xValue);
      dom.releasePointerCapture?.(event.pointerId);
      event.preventDefault();
    };

    dom.addEventListener("pointerup", finish, { passive: false });
    dom.addEventListener("pointercancel", (event) => {
      if (this.activePointerId != null && event.pointerId !== this.activePointerId) return;
      this.selectionStart = null;
      this.activePointerId = null;
      this.clearSelectionPreview();
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
    this.activePointerId = null;
    this.selectionStart = null;
    this.clearSelectionPreview();
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

  getPointerXValue(event) {
    const rect = this.chart?.getDom?.().getBoundingClientRect?.();
    if (!rect) {
      return null;
    }

    const localX = event.clientX - rect.left;
    return this.chart.convertFromPixel({ xAxisIndex: 0 }, localX);
  }

  buildSelectionPreviewArea(startIndex, endIndex) {
    const left = Math.min(startIndex, endIndex);
    const right = Math.max(startIndex, endIndex);

    return [
      {
        xAxis: left,
        itemStyle: {
          color: "rgba(59, 130, 246, 0.2)",
          borderColor: "rgba(37, 99, 235, 0.85)",
          borderWidth: 1
        },
        label: {
          show: false
        }
      },
      {
        xAxis: right
      }
    ];
  }

  updateSelectionPreview(xValue) {
    if (this.selectionStart == null || xValue == null || Number.isNaN(xValue)) {
      return;
    }

    this.previewMarkArea = this.buildSelectionPreviewArea(this.selectionStart, xValue);
    this.applyMarkAreas();
  }

  clearSelectionPreview() {
    if (!this.previewMarkArea) {
      return;
    }
    this.previewMarkArea = null;
    this.applyMarkAreas();
  }

  applyMarkAreas() {
    const data = this.previewMarkArea
      ? [...this.baseMarkAreas, this.previewMarkArea]
      : this.baseMarkAreas;

    this.chart.setOption({
      series: [{
        markArea: { data }
      }]
    });
  }

  finishSelectionDrag(xValue) {
    if (this.selectionStart == null || xValue == null || Number.isNaN(xValue)) {
      this.selectionStart = null;
      this.activePointerId = null;
      this.clearSelectionPreview();
      return;
    }

    SegmentService.createAddNewSegment(this.currentWorkout, {
      startIndex: Math.round(this.selectionStart),
      endIndex: Math.round(xValue)
    });

    this.handlers.onUpdateWorkout?.(this.currentWorkout);
    this.selectionStart = null;
    this.activePointerId = null;
    this.clearSelectionPreview();
  }

  formatTooltip(params) {
    if (this.isHoveringSegmentArea) {
      return "";
    }

    const p = params?.[0];
    if (!p) return "";

    const row = p.data;
    const timeValue = Utils.formatSeconds(row[0] ?? 0);
    const rows = [
      [this.t("power"), Number.isFinite(row[1]) ? `${Math.round(row[1])} W` : "–"],
      [this.t("heartRate"), Number.isFinite(row[2]) ? `${Math.round(row[2])} bpm` : "–"],
      [this.t("cadence"), Number.isFinite(row[3]) ? `${Math.round(row[3])} rpm` : "–"],
      [this.t("speed"), Number.isFinite(row[4]) ? `${Number(row[4]).toFixed(1)} km/h` : "–"],
      [this.t("altitude"), Number.isFinite(row[5]) ? `${Math.round(row[5])} m` : "–"]
    ];

    return `
      <div style="min-width: 220px;">
        <div style="font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #94a3b8; margin-bottom: 4px;">${this.t("workout")}</div>
        <div style="font-size: 14px; font-weight: 700; color: #0f172a; margin-bottom: 2px;">${timeValue}</div>
        <div style="font-size: 12px; font-weight: 600; color: #334155; margin-bottom: 8px;">${this.t("snapshot")}</div>
        ${rows.map(([label, value]) => `
          <div style="display:flex; justify-content:space-between; gap:12px; margin:2px 0;">
            <span style="color:#64748b;">${label}</span>
            <span style="font-weight:600; color:#0f172a;">${value}</span>
          </div>
        `).join("")}
      </div>
    `;
  }

  initSegmentHoverTooltip() {
    this.segmentHoverTooltip = document.createElement("div");
    this.segmentHoverTooltip.style.position = "fixed";
    this.segmentHoverTooltip.style.zIndex = "2000";
    this.segmentHoverTooltip.style.pointerEvents = "none";
    this.segmentHoverTooltip.style.opacity = "0";
    this.segmentHoverTooltip.style.transform = "translate3d(0, 0, 0)";
    this.segmentHoverTooltip.style.transition = "opacity 120ms ease";
    this.segmentHoverTooltip.style.background = "rgba(255, 255, 255, 0.97)";
    this.segmentHoverTooltip.style.border = "1px solid rgba(148, 163, 184, 0.35)";
    this.segmentHoverTooltip.style.borderRadius = "14px";
    this.segmentHoverTooltip.style.boxShadow = "0 18px 44px rgba(15, 23, 42, 0.16)";
    this.segmentHoverTooltip.style.padding = "12px 14px";
    this.segmentHoverTooltip.style.backdropFilter = "blur(10px)";
    this.segmentHoverTooltip.style.maxWidth = "280px";
    this.segmentHoverTooltip.style.fontSize = "12px";
    this.segmentHoverTooltip.style.lineHeight = "1.4";
    document.body.appendChild(this.segmentHoverTooltip);
  }

  getSegmentFromMarkAreaParams(params) {
    const segmentId = params?.data?.segmentId;
    if (segmentId == null) {
      return this.currentSegment ?? null;
    }

    return this.currentWorkout?.segments?.find((segment) => segment.id === segmentId)
      ?? this.currentSegment
      ?? null;
  }

  showSegmentHoverTooltip(segment, nativeEvent) {
    if (!this.segmentHoverTooltip) {
      return;
    }

    this.segmentHoverTooltip.innerHTML = Utils.formatSegmentTooltip(segment);
    this.segmentHoverTooltip.style.opacity = "1";
    this.positionSegmentHoverTooltip(nativeEvent);
  }

  positionSegmentHoverTooltip(nativeEvent) {
    if (!this.segmentHoverTooltip || !nativeEvent) {
      return;
    }

    const margin = 18;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const rect = this.segmentHoverTooltip.getBoundingClientRect();
    const clientX = nativeEvent.clientX ?? 0;
    const clientY = nativeEvent.clientY ?? 0;

    let left = clientX + margin;
    let top = clientY + margin;

    if (left + rect.width > viewportWidth - 12) {
      left = clientX - rect.width - margin;
    }

    if (top + rect.height > viewportHeight - 12) {
      top = clientY - rect.height - margin;
    }

    left = Math.max(12, left);
    top = Math.max(12, top);

    this.segmentHoverTooltip.style.left = `${left}px`;
    this.segmentHoverTooltip.style.top = `${top}px`;
  }

  hideSegmentHoverTooltip() {
    this.isHoveringSegmentArea = false;

    if (!this.segmentHoverTooltip) {
      return;
    }

    this.segmentHoverTooltip.style.opacity = "0";
  }

  getChartLabels() {
    return {
      power: this.t("power"),
      heartRate: this.t("heartRate"),
      cadence: this.t("cadence"),
      speed: this.t("speed"),
      altitude: this.t("altitude"),
      axisPower: this.t("axisPower"),
      axisHeartCadence: this.t("axisHeartCadence"),
      axisSpeed: this.t("axisSpeed"),
      axisAltitude: this.t("axisAltitude")
    };
  }

  resize() { this.chart.resize(); }
  showLoading() { this.chart.showLoading(); }
  hideLoading() { this.chart.hideLoading(); }
}
