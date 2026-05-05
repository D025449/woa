import { buildMarkAreas, buildMarkAreasCP } from "./chart-helpers.js";
import SegmentService from "../../shared/SegmentService.js";
import Utils from "../../shared/Utils.js";
import { createTranslator } from "./i18n.js";

export default class ChartView {

  constructor(containerId, handlers = {}) {
    this.container = document.getElementById(containerId);
    this.chart = echarts.init(this.container);

    this.handlers = handlers;
    this.t = createTranslator("dashboardNewPage");

    this.selectionStart = null;
    this.currentWorkout = null;
    this.xAxisMode = "time";
    this.distanceAxisToggle = null;
    this.seriesToggleSlot = document.getElementById("dashboard-series-toggle-slot");
    this.segmentToggleSlot = document.getElementById("dashboard-segment-toggle-slot");
    this.seriesVisibility = {
      power: true,
      heartRate: true,
      cadence: true,
      speed: true,
      altitude: true
    };
    this.segmentVisibility = {
      criticalPower: true,
      auto: true,
      manual: true,
      gps: true
    };
    this.seriesToggleButtons = new Map();
    this.segmentToggleButtons = new Map();
    this.distanceKmByIndex = null;
    this.mode = "";
    this.isHoveringSegmentArea = false;
    this.baseMarkAreas = [];
    this.previewMarkArea = null;
    this.activePointerId = null;
    this.createButton = document.getElementById('draw-segment-toggle');
    this.createGpsButton = document.getElementById('draw-gps-segment-toggle');
    this.deleteButton = document.getElementById('delete-segments');
    this.actionsMenu = document.querySelector(".dashboard-actions-menu");

    this.applyInitialPreferences(handlers.initialState || null);

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

    this.initAxisModeToggle();
    this.initSegmentToggleControls();
    this.initSeriesToggleControls();
    this.initActionsMenuBehaviour();
    this.syncModeButtons();
  }

  applyInitialPreferences(state) {
    if (!state || typeof state !== "object") {
      return;
    }

    if (state.xAxisMode === "time" || state.xAxisMode === "distance") {
      this.xAxisMode = state.xAxisMode;
    }

    if (state.seriesVisibility && typeof state.seriesVisibility === "object") {
      this.seriesVisibility = {
        ...this.seriesVisibility,
        ...state.seriesVisibility
      };
    }

    if (state.segmentVisibility && typeof state.segmentVisibility === "object") {
      this.segmentVisibility = {
        ...this.segmentVisibility,
        ...state.segmentVisibility
      };
    }
  }

  emitPreferenceChange() {
    this.handlers.onPreferencesChange?.({
      xAxisMode: this.xAxisMode,
      seriesVisibility: { ...this.seriesVisibility },
      segmentVisibility: { ...this.segmentVisibility }
    });
  }

  initActionsMenuBehaviour() {
    if (!this.actionsMenu) {
      return;
    }

    this.actionsMenu.addEventListener("click", (event) => {
      event.stopPropagation();
    });

    this.actionsMenu.querySelectorAll(".dashboard-actions-submenu").forEach((submenu) => {
      submenu.addEventListener("toggle", () => {
        if (!submenu.open) {
          return;
        }

        this.actionsMenu
          ?.querySelectorAll(".dashboard-actions-submenu")
          ?.forEach((otherSubmenu) => {
            if (otherSubmenu !== submenu) {
              otherSubmenu.removeAttribute("open");
            }
          });
      });
    });

    document.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Node)) {
          return;
      }

      if (this.actionsMenu?.contains(target)) {
        return;
      }

      this.actionsMenu?.removeAttribute("open");
    });

    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") {
        return;
      }

      const openSubmenu = this.actionsMenu?.querySelector(".dashboard-actions-submenu[open]");
      if (openSubmenu) {
        openSubmenu.removeAttribute("open");
        event.preventDefault();
        return;
      }

      if (this.actionsMenu?.open) {
        this.actionsMenu.removeAttribute("open");
        event.preventDefault();
      }
    });
  }

  initAxisModeToggle() {
    const slot = document.getElementById("dashboard-axis-toggle-slot");
    const toolbar = slot
      || this.createButton?.closest(".dashboard-toolbar")
      || this.deleteButton?.closest(".dashboard-toolbar")
      || this.createGpsButton?.closest(".dashboard-toolbar")
      || null;

    if (!toolbar) {
      return;
    }

    const wrapper = document.createElement("div");
    wrapper.className = "btn-group btn-group-sm";
    wrapper.setAttribute("role", "group");
    wrapper.setAttribute("aria-label", this.t("xAxisAria"));

    const timeButton = document.createElement("button");
    timeButton.type = "button";
    timeButton.className = "btn btn-outline-dark";
    timeButton.textContent = this.t("timeAxis");
    timeButton.dataset.xAxisMode = "time";

    const distanceButton = document.createElement("button");
    distanceButton.type = "button";
    distanceButton.className = "btn btn-outline-dark";
    distanceButton.textContent = this.t("distanceAxis");
    distanceButton.dataset.xAxisMode = "distance";
    distanceButton.disabled = true;
    distanceButton.title = this.t("distanceAxisUnavailable");

    wrapper.appendChild(timeButton);
    wrapper.appendChild(distanceButton);
    toolbar.appendChild(wrapper);
    this.distanceAxisToggle = { wrapper, timeButton, distanceButton };

    wrapper.addEventListener("click", (event) => {
      const target = event.target?.closest?.("button[data-x-axis-mode]");
      if (!target || target.disabled) {
        return;
      }
      this.setXAxisMode(target.dataset.xAxisMode || "time");
    });
  }

  initChart() {
    const labels = this.getChartLabels();
    this.chart.setOption({
      tooltip: {
        trigger: "axis",
        confine: true,
        axisPointer: { type: "line", snap: true },
        formatter: (params) => this.formatTooltip(params)
      },
      animation: false,
      legend: {
        show: false,
        selected: this.getLegendSelection(labels)
      },
      grid: { top: 40 },
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
          //, "PowerS5", "PowerS15",
          //"SpeedS5", "AltitudeS7"
        ],
        source: []
      },
      dataZoom: [
        { type: "inside", xAxisIndex: 0, filterMode: "none" },
        { type: "slider", xAxisIndex: 0 }
      ],
      series: this.buildSeriesDefinitions(labels)
    });
    this.renderSegmentToggles();
    this.renderSeriesToggles(labels);
  }

  // -----------------------------
  // DATA UPDATE
  // -----------------------------
  updateWorkout(workout) {
    this.currentWorkout = workout;
    this.distanceKmByIndex = null;
    if (!this.isWorkoutEditable() && this.mode) {
      this.setMode("");
    } else if (!workout?.validGps && this.mode === "gps-create") {
      this.setMode("");
    } else {
      this.syncModeButtons();
    }
    const obj = workout.workoutObject;
    this.syncXAxisModeButtons();
    if (this.xAxisMode === "distance" && !this.hasDistanceXAxis()) {
      this.xAxisMode = "time";
    }
    const result = obj.getAsStrideArray({ smoothing: { power: 10, speed: 30, cadence: 30 } });
    const source = result.data;
    const sd = obj.getStartTime();
    const xRange = this.getXAxisRange(result.rowCount, workout);
    const xField = this.getXAxisField();
    const labels = this.getChartLabels();

    this.chart.setOption({
      xAxis: {
        min: xRange.min,
        max: xRange.max,
        axisLabel: { formatter: (value) => this.formatXAxisLabel(value) }
      },
      legend: {
        selected: this.getLegendSelection(labels)
      },
      dataset: { source }, //workout.series },
      series: this.buildSeriesDefinitions(labels, xField)
    });
    this.renderSegmentToggles();
    this.renderSeriesToggles(labels);
    this.baseMarkAreas = this.buildMarkAreasForMode(workout);
    this.applyMarkAreas();
  }

  updateWorkoutCP(workout, cpview) {
    this.currentWorkout = workout;
    this.distanceKmByIndex = null;
    if (!this.isWorkoutEditable() && this.mode) {
      this.setMode("");
    } else if (!workout?.validGps && this.mode === "gps-create") {
      this.setMode("");
    } else {
      this.syncModeButtons();
    }
    this.syncXAxisModeButtons();
    if (this.xAxisMode === "distance" && !this.hasDistanceXAxis()) {
      this.xAxisMode = "time";
    }
    const obj = workout.workoutObject;
    const result = obj.getAsStrideArray();
    const source = result.data;
    const xRange = this.getXAxisRange(result.rowCount, workout);
    const sd = obj.getStartTime();
    const xField = this.getXAxisField();
    const labels = this.getChartLabels();

    this.chart.setOption({
      xAxis: {
        min: xRange.min,
        max: xRange.max,
        axisLabel: { formatter: (value) => this.formatXAxisLabel(value) }
      },
      legend: {
        selected: this.getLegendSelection(labels)
      },
      dataset: { source }, //workout.series },
      series: this.buildSeriesDefinitions(labels, xField)
    });
    this.renderSegmentToggles();
    this.renderSeriesToggles(labels);
    this.baseMarkAreas = this.buildMarkAreasCPForMode(cpview);
    this.applyMarkAreas();
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
            `GPS segments cannot be deleted here. <a href="/segments?focusSegmentId=${encodeURIComponent(seg.sid)}" class="fw-semibold text-decoration-underline">Go to Segments page</a>`
          );
          return;
        }

        //seg.rowstate = 'DEL';
        SegmentService.deleteSegment(this.currentWorkout, seg) 
        this.handlers.onUpdateWorkout?.(this.currentWorkout);
      } else {
        this.handlers.onZoomSegment?.(
          this.xValueToIndex(params.data.coord[0][0]),
          this.xValueToIndex(params.data.coord[1][0])
        );
      }
    });

    this.chart.getZr().on("mousemove", (p) => {
      const x = this.chart.convertFromPixel({ xAxisIndex: 0 }, p.offsetX);
      if (!isNaN(x)) {
        this.handlers.onChartHoverIndex?.(this.xValueToIndex(x));
      }
      if (this.selectionStart != null && (this.mode === "create" || this.mode === "gps-create")) {
        this.updateSelectionPreview(x);
      }
      this.syncSegmentHoverFromPointer(x, p.event);
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
      if (!this.isWorkoutEditable()) return;
      if (this.mode !== "create" && this.mode !== "gps-create") return;
      if (!event.isPrimary) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;

      const xValue = this.getPointerXValue(event);
      if (xValue == null || Number.isNaN(xValue)) {
        return;
      }

      this.activePointerId = event.pointerId;
      this.selectionStart = this.xValueToIndex(xValue);
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

    const finish = async (event) => {
      if (this.selectionStart == null) return;
      if (this.activePointerId != null && event.pointerId !== this.activePointerId) return;

      const xValue = this.getPointerXValue(event);
      await this.finishSelectionDrag(xValue);
      dom.releasePointerCapture?.(event.pointerId);
      event.preventDefault();
    };

    dom.addEventListener("pointerup", (event) => {
      finish(event).catch((err) => console.error(err));
    }, { passive: false });

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
  isWorkoutEditable() {
    const access = this.currentWorkout?.access;
    return access == null || access.isOwner !== false;
  }

  setMode(mode) {
    this.mode = mode;
    this.selectionStart = null;
    this.activePointerId = null;
    this.clearSelectionPreview();
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
          ? "Shared workouts are read-only."
          : isCreate
          ? this.t("createSegmentActive")
          : this.t("btnCreateSegmentTitle")
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
          ? "Shared workouts are read-only."
          : canCreateGps
          ? (
              isGpsCreate
                ? this.t("createGpsSegmentActive")
                : this.t("btnCreateGpsTitle")
            )
          : "Only available when the workout has valid GPS data."
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
          ? "Shared workouts are read-only."
          : isDelete
          ? this.t("deleteSegmentActive")
          : this.t("enableDeleteSegment")
      );
      this.deleteButton.setAttribute(
        "aria-pressed",
        isDelete ? "true" : "false"
      );
    }
  }

  setXAxisMode(mode) {
    const normalized = mode === "distance" ? "distance" : "time";
    if (normalized === "distance" && !this.hasDistanceXAxis()) {
      return;
    }
    if (this.xAxisMode === normalized) {
      return;
    }
    this.xAxisMode = normalized;
    this.syncXAxisModeButtons();
    this.emitPreferenceChange();
    if (this.currentWorkout) {
      this.updateWorkout(this.currentWorkout);
    }
  }

  syncXAxisModeButtons() {
    if (!this.distanceAxisToggle) {
      return;
    }

    const hasDistance = this.hasDistanceXAxis();
    const { timeButton, distanceButton } = this.distanceAxisToggle;
    distanceButton.disabled = !hasDistance;
    if (!hasDistance && this.xAxisMode === "distance") {
      this.xAxisMode = "time";
    }

    timeButton.classList.toggle("btn-dark", this.xAxisMode === "time");
    timeButton.classList.toggle("btn-outline-dark", this.xAxisMode !== "time");
    distanceButton.classList.toggle("btn-dark", this.xAxisMode === "distance");
    distanceButton.classList.toggle("btn-outline-dark", this.xAxisMode !== "distance");
  }

  initSeriesToggleControls() {
    if (!this.seriesToggleSlot) {
      return;
    }

    this.seriesToggleSlot.addEventListener("click", (event) => {
      const button = event.target?.closest?.("button[data-series-key]");
      if (!button) {
        return;
      }

      const seriesKey = button.dataset.seriesKey;
      if (!seriesKey || !(seriesKey in this.seriesVisibility)) {
        return;
      }

      this.seriesVisibility[seriesKey] = !this.seriesVisibility[seriesKey];
      this.applySeriesSelection();
      this.syncSeriesToggleState();
      this.emitPreferenceChange();
    });
  }

  initSegmentToggleControls() {
    if (!this.segmentToggleSlot) {
      return;
    }

    this.segmentToggleSlot.addEventListener("click", (event) => {
      const button = event.target?.closest?.("button[data-segment-key]");
      if (!button) {
        return;
      }

      const segmentKey = button.dataset.segmentKey;
      if (!segmentKey || !(segmentKey in this.segmentVisibility)) {
        return;
      }

      this.segmentVisibility[segmentKey] = !this.segmentVisibility[segmentKey];
      this.syncSegmentToggleState();
      this.baseMarkAreas = this.buildMarkAreasForMode(this.currentWorkout);
      this.applyMarkAreas();
      this.emitPreferenceChange();
    });
  }

  hasDistanceXAxis() {
    const obj = this.currentWorkout?.workoutObject;
    return !!(obj && typeof obj.hasDistanceSeries === "function" && obj.hasDistanceSeries());
  }

  getXAxisField() {
    if (this.xAxisMode === "distance" && this.hasDistanceXAxis()) {
      return "DistanceKm";
    }
    return "x";
  }

  getDistanceKmByIndex() {
    if (Array.isArray(this.distanceKmByIndex)) {
      return this.distanceKmByIndex;
    }

    const obj = this.currentWorkout?.workoutObject;
    if (!obj || typeof obj.getDistanceAt !== "function") {
      this.distanceKmByIndex = [];
      return this.distanceKmByIndex;
    }

    const out = new Array(obj.length);
    for (let i = 0; i < obj.length; i++) {
      const distanceM = obj.getDistanceAt(i);
      out[i] = Number.isFinite(distanceM) ? distanceM / 1000 : i;
    }
    this.distanceKmByIndex = out;
    return out;
  }

  getXAxisRange(rowCount, workout) {
    if (this.xAxisMode !== "distance" || !this.hasDistanceXAxis()) {
      return { min: 0, max: rowCount };
    }

    const distances = this.getDistanceKmByIndex();
    const max = distances.length > 0
      ? distances[distances.length - 1]
      : rowCount;

    return { min: 0, max };
  }

  formatXAxisLabel(value) {
    if (this.xAxisMode === "distance" && this.hasDistanceXAxis()) {
      return `${Number(value).toFixed(1)} km`;
    }
    return Utils.formatSeconds(value);
  }

  xValueToIndex(xValue) {
    if (this.xAxisMode !== "distance" || !this.hasDistanceXAxis()) {
      return Math.max(0, Math.round(xValue));
    }

    const values = this.getDistanceKmByIndex();
    if (values.length === 0) {
      return Math.max(0, Math.round(xValue));
    }

    let lo = 0;
    let hi = values.length - 1;

    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (values[mid] < xValue) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }

    const right = lo;
    const left = Math.max(0, right - 1);
    const nearest = Math.abs(values[right] - xValue) < Math.abs(values[left] - xValue)
      ? right
      : left;
    return nearest;
  }

  xIndexToValue(index) {
    if (this.xAxisMode !== "distance" || !this.hasDistanceXAxis()) {
      return index;
    }
    const values = this.getDistanceKmByIndex();
    return values[index] ?? index;
  }

  buildMarkAreasForMode(workout) {
    if (!workout) {
      return [];
    }

    const areas = buildMarkAreas(workout);
    if (this.xAxisMode !== "distance" || !this.hasDistanceXAxis()) {
      return this.filterMarkAreasByVisibility(areas);
    }

    return this.filterMarkAreasByVisibility(areas).map((area) => ([
      {
        ...area[0],
        xAxis: this.xIndexToValue(area[0].xAxis)
      },
      {
        ...area[1],
        xAxis: this.xIndexToValue(area[1].xAxis)
      }
    ]));
  }

  buildMarkAreasCPForMode(cpview) {
    const areas = buildMarkAreasCP(cpview);
    if (this.xAxisMode !== "distance" || !this.hasDistanceXAxis()) {
      return areas;
    }

    return areas.map((area) => ([
      {
        ...area[0],
        xAxis: this.xIndexToValue(area[0].xAxis)
      },
      {
        ...area[1],
        xAxis: this.xIndexToValue(area[1].xAxis)
      }
    ]));
  }

  buildSelectionPreviewArea(startIndex, endIndex) {
    const left = Math.min(startIndex, endIndex);
    const right = Math.max(startIndex, endIndex);

    return [
      {
        xAxis: this.xIndexToValue(left),
        itemStyle: {
          color: this.mode === "gps-create"
            ? "rgba(34, 197, 94, 0.22)"
            : "rgba(59, 130, 246, 0.2)",
          borderColor: this.mode === "gps-create"
            ? "rgba(22, 163, 74, 0.85)"
            : "rgba(37, 99, 235, 0.85)",
          borderWidth: 1
        },
        label: {
          show: false
        }
      },
      {
        xAxis: this.xIndexToValue(right)
      }
    ];
  }

  getPointerXValue(event) {
    const rect = this.chart?.getDom?.().getBoundingClientRect?.();
    if (!rect) {
      return null;
    }

    const localX = event.clientX - rect.left;
    return this.chart.convertFromPixel({ xAxisIndex: 0 }, localX);
  }

  updateSelectionPreview(xValue) {
    if (this.selectionStart == null || Number.isNaN(xValue) || xValue == null) {
      return;
    }

    const endIndex = this.xValueToIndex(xValue);
    this.previewMarkArea = this.buildSelectionPreviewArea(this.selectionStart, endIndex);
    this.applyMarkAreas();
  }

  clearSelectionPreview() {
    if (!this.previewMarkArea) {
      return;
    }
    this.previewMarkArea = null;
    this.applyMarkAreas();
  }

  async finishSelectionDrag(xValue) {
    if (!this.isWorkoutEditable()) {
      this.selectionStart = null;
      this.activePointerId = null;
      this.clearSelectionPreview();
      return;
    }

    if (this.mode !== "create" && this.mode !== "gps-create") {
      this.selectionStart = null;
      this.activePointerId = null;
      this.clearSelectionPreview();
      return;
    }

    if (this.selectionStart == null || xValue == null || Number.isNaN(xValue)) {
      this.selectionStart = null;
      this.activePointerId = null;
      this.clearSelectionPreview();
      return;
    }

    const startEnd = {
      startIndex: Math.round(this.selectionStart),
      endIndex: this.xValueToIndex(xValue)
    };

    this.clearSelectionPreview();

    if (this.mode === "gps-create") {
      const gpsSegment = await SegmentService.createAddNewGpsSegment(this.currentWorkout, startEnd);
      this.handlers.onGpsSegmentCreated?.(gpsSegment);
    } else {
      await SegmentService.createAddNewSegment(this.currentWorkout, startEnd);
      this.handlers.onUpdateWorkout?.(this.currentWorkout);
    }

    this.selectionStart = null;
    this.activePointerId = null;
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
      startValue: this.xIndexToValue(start),
      endValue: this.xIndexToValue(end)
    });
  }

  formatTooltip(params) {
    if (this.isHoveringSegmentArea) {
      return "";
    }

    const p = params?.[0];
    if (!p) return "";

    const row = p.data;
    const index = Number.isFinite(p.dataIndex) ? p.dataIndex : 0;
    const axisValue = this.getXAxisField() === "DistanceKm"
      ? (row[6] ?? 0)
      : (row[0] ?? 0);
    const headline = this.xAxisMode === "distance" && this.hasDistanceXAxis()
      ? `${Number(axisValue).toFixed(2)} km`
      : Utils.formatSeconds(axisValue);
    const subline = this.xAxisMode === "distance" && this.hasDistanceXAxis()
      ? `${this.t("chart.timeLabel")}: ${Utils.formatSeconds(index)}`
      : this.t("chart.snapshot");
    const rows = [
      [this.t("chart.power"), Number.isFinite(row[1]) ? `${Math.round(row[1])} W` : "–"],
      [this.t("chart.heartRate"), Number.isFinite(row[2]) ? `${Math.round(row[2])} bpm` : "–"],
      [this.t("chart.cadence"), Number.isFinite(row[3]) ? `${Math.round(row[3])} rpm` : "–"],
      [this.t("chart.speed"), Number.isFinite(row[4]) ? `${Number(row[4]).toFixed(1)} km/h` : "–"],
      [this.t("chart.altitude"), Number.isFinite(row[5]) ? `${Math.round(row[5])} m` : "–"]
    ];

    return `
      <div style="min-width: 220px;">
        <div style="font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #94a3b8; margin-bottom: 4px;">${this.t("chart.workout")}</div>
        <div style="font-size: 14px; font-weight: 700; color: #0f172a; margin-bottom: 2px;">${headline}</div>
        <div style="font-size: 12px; font-weight: 600; color: #334155; margin-bottom: 8px;">${subline}</div>
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

  getHoveredSegmentAtXValue(xValue) {
    if (Number.isNaN(xValue) || xValue == null) {
      return null;
    }

    const index = this.xValueToIndex(xValue);
    const segments = this.currentWorkout?.segments?.filter((segment) => {
      if (segment.rowstate === "DEL") {
        return false;
      }
      if (!this.isSegmentTypeVisible(segment)) {
        return false;
      }
      return index >= segment.start_offset && index <= segment.end_offset;
    }) ?? [];

    if (segments.length === 0) {
      return null;
    }

    segments.sort((left, right) => {
      const leftSpan = Math.abs((left.end_offset ?? 0) - (left.start_offset ?? 0));
      const rightSpan = Math.abs((right.end_offset ?? 0) - (right.start_offset ?? 0));
      return leftSpan - rightSpan;
    });

    return segments[0] ?? null;
  }

  syncSegmentHoverFromPointer(xValue, nativeEvent) {
    const segment = this.getHoveredSegmentAtXValue(xValue);

    if (!segment) {
      this.hideSegmentHoverTooltip();
      return;
    }

    this.isHoveringSegmentArea = true;
    this.chart.dispatchAction({ type: "hideTip" });
    this.showSegmentHoverTooltip(segment, nativeEvent);
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
      power: this.t("chart.power"),
      heartRate: this.t("chart.heartRate"),
      cadence: this.t("chart.cadence"),
      speed: this.t("chart.speed"),
      altitude: this.t("chart.altitude"),
      axisPower: this.t("chart.axisPower"),
      axisHeartCadence: this.t("chart.axisHeartCadence"),
      axisSpeed: this.t("chart.axisSpeed"),
      axisAltitude: this.t("chart.axisAltitude")
    };
  }

  getSeriesPalette() {
    return {
      power: "#2563eb",
      heartRate: "#16a34a",
      cadence: "#f59e0b",
      speed: "#ef4444",
      altitude: "#38bdf8"
    };
  }

  buildSeriesDefinitions(labels, xField = "x") {
    const colors = this.getSeriesPalette();

    return [
      {
        name: labels.power,
        type: "line",
        showSymbol: false,
        sampling: "lttb",
        yAxisIndex: 0,
        markArea: { data: [] },
        lineStyle: { color: colors.power, width: 1.8 },
        itemStyle: { color: colors.power },
        encode: { x: xField, y: "Power" }
      },
      {
        name: labels.heartRate,
        type: "line",
        showSymbol: false,
        sampling: "lttb",
        yAxisIndex: 1,
        lineStyle: { color: colors.heartRate, width: 1.7 },
        itemStyle: { color: colors.heartRate },
        encode: { x: xField, y: "Heartrate" }
      },
      {
        name: labels.cadence,
        type: "line",
        showSymbol: false,
        sampling: "lttb",
        yAxisIndex: 1,
        lineStyle: { color: colors.cadence, width: 1.7 },
        itemStyle: { color: colors.cadence },
        encode: { x: xField, y: "Cadence" }
      },
      {
        name: labels.speed,
        type: "line",
        showSymbol: false,
        sampling: "lttb",
        yAxisIndex: 2,
        lineStyle: { color: colors.speed, width: 1.7 },
        itemStyle: { color: colors.speed },
        encode: { x: xField, y: "Speed" }
      },
      {
        name: labels.altitude,
        type: "line",
        showSymbol: false,
        sampling: "lttb",
        yAxisIndex: 3,
        lineStyle: { color: colors.altitude, width: 1.7 },
        itemStyle: { color: colors.altitude },
        encode: { x: xField, y: "Altitude" }
      }
    ];
  }

  getLegendSelection(labels = this.getChartLabels()) {
    return {
      [labels.power]: this.seriesVisibility.power,
      [labels.heartRate]: this.seriesVisibility.heartRate,
      [labels.cadence]: this.seriesVisibility.cadence,
      [labels.speed]: this.seriesVisibility.speed,
      [labels.altitude]: this.seriesVisibility.altitude
    };
  }

  getSeriesToggleDefinitions(labels = this.getChartLabels()) {
    const colors = this.getSeriesPalette();
    return [
      { key: "power", label: labels.power, color: colors.power },
      { key: "heartRate", label: labels.heartRate, color: colors.heartRate },
      { key: "cadence", label: labels.cadence, color: colors.cadence },
      { key: "speed", label: labels.speed, color: colors.speed },
      { key: "altitude", label: labels.altitude, color: colors.altitude }
    ];
  }

  getSegmentToggleDefinitions() {
    return [
      { key: "criticalPower", label: this.t("segmentTypeCriticalPower"), color: "rgba(17, 230, 42, 0.2)" },
      { key: "auto", label: this.t("segmentTypeAuto"), color: "rgba(0, 123, 255, 0.3)" },
      { key: "manual", label: this.t("segmentTypeManual"), color: "rgba(255, 0, 0, 0.3)" },
      { key: "gps", label: this.t("segmentTypeGps"), color: "rgba(17, 230, 42, 0.2)" }
    ];
  }

  renderSeriesToggles(labels = this.getChartLabels()) {
    if (!this.seriesToggleSlot) {
      return;
    }

    this.seriesToggleButtons.clear();
    this.seriesToggleSlot.innerHTML = "";

    this.getSeriesToggleDefinitions(labels).forEach((series) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "dashboard-series-toggle";
      button.dataset.seriesKey = series.key;
      button.innerHTML = `
        <span class="dashboard-series-toggle__identity">
          <span class="dashboard-series-toggle__swatch" style="background:${series.color};"></span>
          <span class="dashboard-series-toggle__label">${series.label}</span>
        </span>
        <span class="dashboard-series-toggle__state" aria-hidden="true">✓</span>
      `;
      this.seriesToggleSlot.appendChild(button);
      this.seriesToggleButtons.set(series.key, button);
    });

    this.syncSeriesToggleState();
  }

  renderSegmentToggles() {
    if (!this.segmentToggleSlot) {
      return;
    }

    this.segmentToggleButtons.clear();
    this.segmentToggleSlot.innerHTML = "";

    this.getSegmentToggleDefinitions().forEach((segmentType) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "dashboard-series-toggle";
      button.dataset.segmentKey = segmentType.key;
      button.innerHTML = `
        <span class="dashboard-series-toggle__identity">
          <span class="dashboard-series-toggle__swatch" style="background:${segmentType.color};"></span>
          <span class="dashboard-series-toggle__label">${segmentType.label}</span>
        </span>
        <span class="dashboard-series-toggle__state" aria-hidden="true">✓</span>
      `;
      this.segmentToggleSlot.appendChild(button);
      this.segmentToggleButtons.set(segmentType.key, button);
    });

    this.syncSegmentToggleState();
  }

  syncSeriesToggleState() {
    this.seriesToggleButtons.forEach((button, key) => {
      const isActive = this.seriesVisibility[key] !== false;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-pressed", isActive ? "true" : "false");
    });
  }

  syncSegmentToggleState() {
    this.segmentToggleButtons.forEach((button, key) => {
      const isActive = this.segmentVisibility[key] !== false;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-pressed", isActive ? "true" : "false");
    });
  }

  isSegmentTypeVisible(segment) {
    if (!segment) {
      return false;
    }

    if (segment.isGPSSegment || segment.segmenttype === "gps") {
      return this.segmentVisibility.gps !== false;
    }

    if (segment.segmenttype === "crit") {
      return this.segmentVisibility.criticalPower !== false;
    }

    if (segment.segmenttype === "auto") {
      return this.segmentVisibility.auto !== false;
    }

    return this.segmentVisibility.manual !== false;
  }

  filterMarkAreasByVisibility(areas = []) {
    return areas.filter((area) => {
      const segmentId = area?.[0]?.segmentId;
      if (segmentId == null) {
        return true;
      }

      const segment = this.currentWorkout?.segments?.find((entry) => entry.id === segmentId);
      return this.isSegmentTypeVisible(segment);
    });
  }

  applySeriesSelection() {
    const labels = this.getChartLabels();
    this.chart.setOption({
      legend: {
        selected: this.getLegendSelection(labels)
      }
    });
  }

  resize() { this.chart.resize(); }
  showLoading() { this.chart.showLoading(); }
  hideLoading() { this.chart.hideLoading(); }
}
