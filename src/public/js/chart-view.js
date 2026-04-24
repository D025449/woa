import { buildMarkAreas, buildMarkAreasCP } from "./chart-helpers.js";
import SegmentService from "../../shared/SegmentService.js";
import Utils from "../../shared/Utils.js";

export default class ChartView {

  constructor(containerId, handlers = {}) {
    this.container = document.getElementById(containerId);
    this.chart = echarts.init(this.container);

    this.handlers = handlers;

    this.selectionStart = null;
    this.currentWorkout = null;
    this.mode = "";
    this.isHoveringSegmentArea = false;
    this.createButton = document.getElementById('draw-segment-toggle');
    this.createGpsButton = document.getElementById('draw-gps-segment-toggle');
    this.deleteButton = document.getElementById('delete-segments');

    this.initSegmentHoverTooltip();
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
    if (!this.isWorkoutEditable() && this.mode) {
      this.setMode("");
    } else if (!workout?.validGps && this.mode === "gps-create") {
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
    if (!this.isWorkoutEditable() && this.mode) {
      this.setMode("");
    } else if (!workout?.validGps && this.mode === "gps-create") {
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
      const isGpsSegment = !!seg?.isGPSSegment;

      if (this.mode === "create" || this.mode === "gps-create") {
        return;
      }

      if (this.mode === "delete") {
        if (!this.isWorkoutEditable()) {
          return;
        }

        if (isGpsSegment) {
          this.handlers.onToast?.(
            `GPS-Segmente können hier nicht gelöscht werden. <a href="/segments?focusSegmentId=${encodeURIComponent(seg.sid)}" class="fw-semibold text-decoration-underline">Zur Segments-Seite</a>`
          );
          return;
        }

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
      if (!this.isWorkoutEditable()) return;
      if (this.mode !== "create" && this.mode !== "gps-create") return;

      const data = this.chart.convertFromPixel({ seriesIndex: 0 }, [e.offsetX, e.offsetY]);
      this.selectionStart = data[0];
    });

    this.chart.getZr().on('mouseup', async (e) => {
      if (!this.isWorkoutEditable()) {
        this.selectionStart = null;
        return;
      }

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

  // -----------------------------
  // UI HELPERS
  // -----------------------------
  isWorkoutEditable() {
    const access = this.currentWorkout?.access;
    return access == null || access.isOwner !== false;
  }

  setMode(mode) {
    this.mode = mode;
    this.selectionStart = null;
    this.setDrawingMode(mode === "create" || mode === "gps-create");
    this.syncModeButtons();
  }

  syncModeButtons() {
    const canCreateGps = !!this.currentWorkout?.validGps;
    const isEditable = this.isWorkoutEditable();

    if (this.createButton) {
      const isCreate = this.mode === "create";
      this.createButton.classList.toggle("d-none", !isEditable);
      this.createButton.disabled = !isEditable;
      this.createButton.classList.toggle('btn-primary', isCreate);
      this.createButton.classList.toggle('btn-outline-primary', !isCreate);
      this.createButton.setAttribute(
        "title",
        !isEditable
          ? "Geteilte Workouts sind schreibgeschützt."
          : isCreate
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
      this.createGpsButton.classList.toggle("d-none", !isEditable);
      this.createGpsButton.disabled = !isEditable || !canCreateGps;
      this.createGpsButton.classList.toggle('btn-success', isGpsCreate);
      this.createGpsButton.classList.toggle('btn-outline-success', !isGpsCreate);
      this.createGpsButton.setAttribute(
        "title",
        !isEditable
          ? "Geteilte Workouts sind schreibgeschützt."
          : canCreateGps
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
      this.deleteButton.classList.toggle("d-none", !isEditable);
      this.deleteButton.disabled = !isEditable;
      this.deleteButton.classList.toggle('btn-danger', isDelete);
      this.deleteButton.classList.toggle('btn-outline-danger', !isDelete);
      this.deleteButton.setAttribute(
        "title",
        !isEditable
          ? "Geteilte Workouts sind schreibgeschützt."
          : isDelete
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
    if (this.isHoveringSegmentArea) {
      return "";
    }

    const p = params?.[0];
    if (!p) return "";

    const row = p.data;
    const timeValue = Utils.formatSeconds(row[0] ?? 0);
    const rows = [
      ["Leistung", Number.isFinite(row[1]) ? `${Math.round(row[1])} W` : "–"],
      ["Herzfrequenz", Number.isFinite(row[2]) ? `${Math.round(row[2])} bpm` : "–"],
      ["Kadenz", Number.isFinite(row[3]) ? `${Math.round(row[3])} rpm` : "–"],
      ["Speed", Number.isFinite(row[4]) ? `${Number(row[4]).toFixed(1)} km/h` : "–"],
      ["Höhe", Number.isFinite(row[5]) ? `${Math.round(row[5])} m` : "–"]
    ];

    return `
      <div style="min-width: 220px;">
        <div style="font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #94a3b8; margin-bottom: 4px;">Workout</div>
        <div style="font-size: 14px; font-weight: 700; color: #0f172a; margin-bottom: 2px;">${timeValue}</div>
        <div style="font-size: 12px; font-weight: 600; color: #334155; margin-bottom: 8px;">Momentaufnahme entlang des Tracks</div>
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
      return null;
    }

    return this.currentWorkout?.segments?.find((segment) => segment.id === segmentId) ?? null;
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

  resize() { this.chart.resize(); }
  showLoading() { this.chart.showLoading(); }
  hideLoading() { this.chart.hideLoading(); }
}
