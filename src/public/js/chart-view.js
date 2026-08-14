import { buildMarkAreas, buildMarkAreasCP } from "./chart-helpers.js";
import SegmentService from "../../shared/SegmentService.js";
import Utils from "../../shared/Utils.js";
import { createTranslator } from "./i18n.js";
import {
  DEFAULT_SEGMENT_VISIBILITY,
  SEGMENT_COLORS,
  getSegmentColor,
  isSegmentVisible
} from "./segment-visibility.js";
import {
  ADAPTIVE_CHART_RESOLUTION_ENABLED,
  buildAdaptiveChartResolutionLevels,
  selectAdaptiveChartResolution
} from "./adaptive-chart-resolution.js";
import { buildChartDataZoom, readChartZoomRange } from "./chart-data-zoom.js";

const MIN_DISTANCE_AXIS_SPAN_METERS = 100;
const ADAPTIVE_CHART_ZOOM_DELAY_MS = 100;
const SEGMENT_RESIZE_HIT_RADIUS_PX = 10;
const SEGMENT_RESIZE_MIN_DURATION_SECONDS = 2;
const SEGMENT_HEADER_HEIGHT_PX = 8;
const SEGMENT_HEADER_GAP_PX = 2;
const SEGMENT_HEADER_PADDING_TOP_PX = 4;
const SEGMENT_HEADER_BASE_GRID_TOP_PX = 40;
const SEGMENT_HEADER_MAX_LANES = 10;

function isPersistedManualSegment(segment) {
  const segmentId = Number(segment?.id);
  return !segment?.isGPSSegment
    && String(segment?.segmenttype || "").toLowerCase() === "manual"
    && segment?.rowstate !== "DEL"
    && Number.isInteger(segmentId)
    && segmentId > 0;
}

export function buildSegmentHeaderLayout({
  segments,
  isVisible = () => true,
  maxLanes = SEGMENT_HEADER_MAX_LANES
}) {
  const normalizedMaxLanes = Math.max(1, Number(maxLanes) || SEGMENT_HEADER_MAX_LANES);
  const candidates = (Array.isArray(segments) ? segments : [])
    .filter((segment) => segment?.rowstate !== "DEL" && isVisible(segment))
    .map((segment) => ({
      segment,
      start: Math.min(Number(segment.start_offset), Number(segment.end_offset)),
      end: Math.max(Number(segment.start_offset), Number(segment.end_offset))
    }))
    .filter(({ start, end }) => Number.isFinite(start) && Number.isFinite(end))
    .sort((left, right) => left.start - right.start || right.end - left.end);

  const laneEnds = [];
  const items = candidates.map((candidate) => {
    let lane = laneEnds.findIndex((end) => end < candidate.start);
    if (lane < 0) {
      lane = laneEnds.length;
    }
    lane = Math.min(lane, normalizedMaxLanes - 1);
    laneEnds[lane] = Math.max(laneEnds[lane] ?? Number.NEGATIVE_INFINITY, candidate.end);
    return { ...candidate, lane };
  });

  return {
    items,
    laneCount: Math.min(laneEnds.length, normalizedMaxLanes)
  };
}

export function buildSegmentHeaderGraphicId(segment, index, workoutId = null) {
  const displayId = Utils.getSegmentDisplayId(segment) ?? "unidentified";
  const kind = segment?.isGPSSegment ? "gps" : String(segment?.segmenttype || "manual");
  const start = Number(segment?.start_offset);
  const end = Number(segment?.end_offset);
  const range = Number.isFinite(start) && Number.isFinite(end)
    ? `${Math.min(start, end)}-${Math.max(start, end)}`
    : "unknown-range";
  const workout = workoutId == null || String(workoutId).trim() === ""
    ? "unknown-workout"
    : String(workoutId).trim();

  // A GPS segment can occur more than once in a workout and therefore shares its display ID.
  return `workout-segment-header-${workout}-${kind}-${displayId}-${range}-${index}`;
}

export function findManualSegmentResizeEdge({
  segments,
  focusedSegment,
  pointerPixel,
  toPixel,
  isVisible = () => true,
  hitRadius = SEGMENT_RESIZE_HIT_RADIUS_PX
}) {
  if (!Number.isFinite(pointerPixel) || typeof toPixel !== "function") {
    return null;
  }

  const focusedId = focusedSegment?.id == null ? null : String(focusedSegment.id);
  const candidates = [];
  for (const segment of Array.isArray(segments) ? segments : []) {
    if (!isPersistedManualSegment(segment) || !isVisible(segment)) {
      continue;
    }

    const startPixel = Number(toPixel(Number(segment.start_offset)));
    const endPixel = Number(toPixel(Number(segment.end_offset)));
    if (!Number.isFinite(startPixel) || !Number.isFinite(endPixel)) {
      continue;
    }

    for (const [edge, edgePixel] of [["start", startPixel], ["end", endPixel]]) {
      const distance = Math.abs(pointerPixel - edgePixel);
      if (distance <= hitRadius) {
        candidates.push({
          segment,
          edge,
          distance,
          span: Math.abs(endPixel - startPixel),
          focused: focusedId != null && String(segment.id) === focusedId
        });
      }
    }
  }

  candidates.sort((left, right) => (
    Number(right.focused) - Number(left.focused)
    || left.distance - right.distance
    || left.span - right.span
    || Number(left.segment.id) - Number(right.segment.id)
    || left.edge.localeCompare(right.edge)
  ));
  return candidates[0] || null;
}

function isValidLeftRightBalance(value) {
  return value !== null
    && value !== undefined
    && Number.isFinite(Number(value))
    && Number(value) >= 0
    && Number(value) <= 100;
}

export function hasMeaningfulDistanceSeries(
  workoutObject,
  minSpanMeters = MIN_DISTANCE_AXIS_SPAN_METERS
) {
  if (
    !workoutObject
    || typeof workoutObject.hasDistanceSeries !== "function"
    || !workoutObject.hasDistanceSeries()
    || typeof workoutObject.getDistanceAt !== "function"
    || Number(workoutObject.length) < 2
  ) {
    return false;
  }

  const firstDistance = Number(workoutObject.getDistanceAt(0));
  const lastDistance = Number(workoutObject.getDistanceAt(workoutObject.length - 1));
  return Number.isFinite(firstDistance)
    && Number.isFinite(lastDistance)
    && lastDistance - firstDistance >= Math.max(0, Number(minSpanMeters) || 0);
}

export function getAvailableWorkoutSeries(workoutObject) {
  const availability = {
    power: false,
    heartRate: false,
    cadence: false,
    speed: false,
    altitude: false,
    leftRightBalance: false
  };
  const length = Math.max(0, Number(workoutObject?.length) || 0);

  if (length === 0 || typeof workoutObject?.getMetricsAt !== "function") {
    return availability;
  }

  const balanceSeries = workoutObject?.leftRightBalanceSeriesPct;
  const hasBalanceSeries = balanceSeries?.length === length;
  if (hasBalanceSeries) {
    for (let index = 0; index < length; index += 1) {
      if (
        isValidLeftRightBalance(balanceSeries[index])
        && Number(balanceSeries[index]) !== 50
      ) {
        availability.leftRightBalance = true;
        break;
      }
    }
  }

  for (let index = 0; index < length; index += 1) {
    const metrics = workoutObject.getMetricsAt(index);
    availability.power ||= Number(metrics?.power) > 0;
    availability.heartRate ||= Number(metrics?.hr) > 0;
    availability.cadence ||= Number(metrics?.cadence) > 0;
    availability.speed ||= Number(metrics?.speed) > 0;
    availability.altitude ||= Number.isFinite(Number(metrics?.altitude))
      && Number(metrics.altitude) !== 0;
    if (!hasBalanceSeries) {
      availability.leftRightBalance ||= isValidLeftRightBalance(metrics?.leftRightBalance)
        && Number(metrics.leftRightBalance) !== 50;
    }

    if (
      availability.power
      && availability.heartRate
      && availability.cadence
      && availability.speed
      && availability.altitude
    ) {
      break;
    }
  }

  return availability;
}

function roundAxisMaximum(value, quantum) {
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }

  return Math.ceil((value * 1.05) / quantum) * quantum;
}

export function calculateStableYAxisBounds(workoutObject) {
  const bounds = {
    power: { min: 0, max: null },
    heartCadence: { min: 0, max: null },
    speed: { min: 0, max: null },
    altitude: { min: null, max: null }
  };
  const length = Math.max(0, Number(workoutObject?.length) || 0);

  if (length === 0 || typeof workoutObject?.getMetricsAt !== "function") {
    return bounds;
  }

  let maxPower = 0;
  let maxHeartCadence = 0;
  let maxSpeed = 0;
  let minAltitude = Infinity;
  let maxAltitude = -Infinity;

  for (let index = 0; index < length; index += 1) {
    const metrics = workoutObject.getMetricsAt(index);
    const power = Number(metrics?.power);
    const heartRate = Number(metrics?.hr);
    const cadence = Number(metrics?.cadence);
    const speed = Number(metrics?.speed);
    const altitude = Number(metrics?.altitude);

    if (Number.isFinite(power) && power > maxPower) {
      maxPower = power;
    }
    if (Number.isFinite(heartRate) && heartRate > maxHeartCadence) {
      maxHeartCadence = heartRate;
    }
    if (Number.isFinite(cadence) && cadence > maxHeartCadence) {
      maxHeartCadence = cadence;
    }
    if (Number.isFinite(speed) && speed > maxSpeed) {
      maxSpeed = speed;
    }
    // Zero is the compact representation for a missing altitude sample.
    if (Number.isFinite(altitude) && altitude !== 0) {
      minAltitude = Math.min(minAltitude, altitude);
      maxAltitude = Math.max(maxAltitude, altitude);
    }
  }

  bounds.power.max = roundAxisMaximum(maxPower, 25);
  bounds.heartCadence.max = roundAxisMaximum(maxHeartCadence, 10);
  bounds.speed.max = roundAxisMaximum(maxSpeed, 5);

  if (Number.isFinite(minAltitude) && Number.isFinite(maxAltitude)) {
    const altitudeRange = Math.max(0, maxAltitude - minAltitude);
    const padding = Math.max(10, altitudeRange * 0.05);
    bounds.altitude.min = Math.floor((minAltitude - padding) / 10) * 10;
    bounds.altitude.max = Math.ceil((maxAltitude + padding) / 10) * 10;
  }

  return bounds;
}

export function getChartSeriesSamplingOption(seriesKey, smoothingLevel) {
  if (smoothingLevel === "off") {
    return {};
  }
  return {
    sampling: seriesKey === "power" ? "average" : "lttb"
  };
}

export default class ChartView {

  constructor(containerId, handlers = {}) {
    this.container = document.getElementById(containerId);
    this.chart = echarts.init(this.container);

    this.handlers = handlers;
    this.t = createTranslator("dashboardNewPage");

    this.selectionStart = null;
    this.currentWorkout = null;
    this.xAxisMode = "time";
    this.smoothingLevel = "automatic";
    this.bridgePowerCadenceZeros = false;
    this.distanceAxisToggle = null;
    this.smoothingSlot = document.getElementById("dashboard-smoothing-slot");
    this.seriesToggleSlot = document.getElementById("dashboard-series-toggle-slot");
    this.segmentToggleSlot = document.getElementById("dashboard-segment-toggle-slot");
    this.seriesVisibility = {
      power: true,
      heartRate: true,
      cadence: true,
      speed: true,
      altitude: true,
      leftRightBalance: false
    };
    this.seriesAvailability = {
      power: true,
      heartRate: true,
      cadence: true,
      speed: true,
      altitude: true,
      leftRightBalance: false
    };
    this.segmentVisibility = { ...DEFAULT_SEGMENT_VISIBILITY };
    this.seriesToggleButtons = new Map();
    this.segmentToggleButtons = new Map();
    this.smoothingButtons = new Map();
    this.zeroBridgeButton = null;
    this.distanceKmByIndex = null;
    this.adaptiveResolutionCache = null;
    this.yAxisBoundsCache = new WeakMap();
    this.currentAdaptiveResolution = null;
    this.adaptiveResolutionTimer = null;
    this.mode = "";
    this.baseMarkAreas = [];
    this.previewMarkArea = null;
    this.focusedSegment = null;
    this.hoveredSegment = null;
    this.tooltipHoveredSegment = null;
    this.activePointerId = null;
    this.resizeDrag = null;
    this.resizeSavePending = false;
    this.createButton = document.getElementById('draw-segment-toggle');
    this.createGpsButton = document.getElementById('draw-gps-segment-toggle');
    this.showAllButton = document.getElementById("dashboard-chart-show-all");
    this.actionsMenu = document.querySelector(".dashboard-actions-menu");
    this.modeStatus = document.getElementById("dashboard-chart-mode-status");
    this.modeStatusText = document.getElementById("dashboard-chart-mode-status-text");

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
    this.showAllButton?.addEventListener("click", () => this.showAll());
    this.initAxisModeToggle();
    this.initSegmentToggleControls();
    this.initSeriesToggleControls();
    this.initSmoothingControls();
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

    if (typeof state.smoothingLevel === "string" && state.smoothingLevel.trim()) {
      this.smoothingLevel = state.smoothingLevel.trim();
    }

    if (typeof state.bridgePowerCadenceZeros === "boolean") {
      this.bridgePowerCadenceZeros = state.bridgePowerCadenceZeros;
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

  applyPreferences(state) {
    this.applyInitialPreferences(state);
    this.syncSeriesToggleState();
    this.syncSegmentToggleState();
    this.syncSmoothingState();

    if (this.currentWorkout) {
      this.updateWorkout(this.currentWorkout);
    }
  }

  emitPreferenceChange() {
    this.handlers.onPreferencesChange?.({
      xAxisMode: this.xAxisMode,
      smoothingLevel: this.smoothingLevel,
      bridgePowerCadenceZeros: this.bridgePowerCadenceZeros,
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
        return;
      }

      if (this.mode) {
        this.setMode("");
        event.preventDefault();
      }
    });
  }

  initAxisModeToggle() {
    const slot = document.getElementById("dashboard-axis-toggle-slot");
    const toolbar = slot
      || this.createButton?.closest(".dashboard-toolbar")
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
      grid: { top: SEGMENT_HEADER_BASE_GRID_TOP_PX },
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
        { type: "value", name: labels.axisAltitude, position: "right", offset: 50 },
        {
          type: "value",
          name: labels.axisLeftRightBalance,
          position: "right",
          offset: 96,
          min: 0,
          max: 100,
          interval: 25,
          show: false,
          axisLine: { show: true, lineStyle: { color: "#d946ef" } },
          axisLabel: { color: "#a21caf", formatter: "{value}%" },
          splitLine: { show: false }
        }
      ],
      dataset: {
        dimensions: [
          "x", "Power", "Heartrate", "Cadence",
          "Speed", "Altitude", "DistanceKm", "LeftRightBalance"
          //, "PowerS5", "PowerS15",
          //"SpeedS5", "AltitudeS7"
        ],
        source: []
      },
      dataZoom: buildChartDataZoom({
        inside: {
          disabled: false,
          zoomOnMouseWheel: true,
          moveOnMouseWheel: false,
          moveOnMouseMove: true,
          preventDefaultMouseMove: true
        }
      }),
      series: this.buildSeriesDefinitions(labels)
    });
    this.renderSegmentToggles();
    this.renderSeriesToggles(labels);
    this.syncShowAllButton();
  }

  // -----------------------------
  // DATA UPDATE
  // -----------------------------
  updateWorkout(workout) {
    const previousWorkoutId = this.currentWorkout?.id;
    const nextWorkoutId = workout?.id;
    const workoutChanged = previousWorkoutId != null && nextWorkoutId != null
      ? String(previousWorkoutId) !== String(nextWorkoutId)
      : this.currentWorkout !== workout;
    this.currentWorkout = workout;
    if (workoutChanged) {
      this.chart.dispatchAction({
        type: "dataZoom",
        start: 0,
        end: 100
      });
    }
    this.distanceKmByIndex = null;
    if (!this.isWorkoutEditable() && this.mode) {
      this.setMode("");
    } else if (!workout?.validGps && this.mode === "gps-create") {
      this.setMode("");
    } else {
      this.syncModeButtons();
    }
    const obj = workout.workoutObject;
    this.seriesAvailability = getAvailableWorkoutSeries(obj);
    this.syncXAxisModeButtons();
    if (this.xAxisMode === "distance" && !this.hasDistanceXAxis()) {
      this.xAxisMode = "time";
    }
    const result = this.getChartDataset(obj);
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
      yAxis: this.buildStableYAxisOptions(obj, labels),
      legend: {
        selected: this.getLegendSelection(labels)
      },
      dataset: { source }, //workout.series },
      series: this.buildSeriesDefinitions(labels, xField)
    }, { replaceMerge: ["series"] });
    this.renderSegmentToggles();
    this.renderSeriesToggles(labels);
    this.renderSmoothingControls();
    this.baseMarkAreas = this.buildMarkAreasForMode(workout);
    this.applyMarkAreas();
  }

  updateWorkoutCP(workout, cpview) {
    this.currentWorkout = workout;
    this.showAll();
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
    this.seriesAvailability = getAvailableWorkoutSeries(obj);
    const result = this.getChartDataset(obj);
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
      yAxis: this.buildStableYAxisOptions(obj, labels),
      legend: {
        selected: this.getLegendSelection(labels)
      },
      dataset: { source }, //workout.series },
      series: this.buildSeriesDefinitions(labels, xField)
    }, { replaceMerge: ["series"] });
    this.renderSegmentToggles();
    this.renderSeriesToggles(labels);
    this.renderSmoothingControls();
    this.baseMarkAreas = this.buildMarkAreasCPForMode(cpview);
    this.applyMarkAreas();
    this.zoomToCriticalPowerEffort(cpview);
  }

  // -----------------------------
  // INTERACTIONS
  // -----------------------------
  registerInteractions() {
    this.chart.getZr().on("mousemove", (p) => {
      const x = this.chart.convertFromPixel({ xAxisIndex: 0 }, p.offsetX);
      if (!isNaN(x)) {
        this.handlers.onChartHoverIndex?.(this.xValueToIndex(x));
      }
      if (this.selectionStart != null && (this.mode === "create" || this.mode === "gps-create")) {
        this.updateSelectionPreview(x);
      }
    });

    this.chart.on("globalout", () => {
      this.hideSegmentHoverTooltip();
    });

    this.chart.on("dataZoom", () => {
      this.scheduleAdaptiveResolutionUpdate();
      this.syncShowAllButton();
      window.requestAnimationFrame(() => this.syncChartGraphics());
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
      if (this.resizeSavePending) return;
      if (!event.isPrimary) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;

      const xValue = this.getPointerXValue(event);
      if (xValue == null || Number.isNaN(xValue)) {
        return;
      }

      this.activePointerId = event.pointerId;
      const resizeHit = this.mode === "create"
        ? this.getResizeEdgeHit(event, event.pointerType === "touch" ? 16 : SEGMENT_RESIZE_HIT_RADIUS_PX)
        : null;
      if (resizeHit) {
        this.startResizeDrag(resizeHit);
        dom.setPointerCapture?.(event.pointerId);
        event.preventDefault();
        return;
      }

      this.selectionStart = this.xValueToIndex(xValue);
      this.updateSelectionPreview(xValue);
      dom.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    }, { passive: false });

    dom.addEventListener("pointermove", (event) => {
      if (this.selectionStart == null && !this.resizeDrag) {
        this.updateCreateModeCursor(event);
        return;
      }
      if (this.activePointerId != null && event.pointerId !== this.activePointerId) return;

      const xValue = this.getPointerXValue(event);
      if (xValue == null || Number.isNaN(xValue)) {
        return;
      }

      if (this.resizeDrag) {
        this.updateResizePreview(xValue);
      } else {
        this.updateSelectionPreview(xValue);
      }
      event.preventDefault();
    }, { passive: false });

    const finish = async (event) => {
      if (this.selectionStart == null && !this.resizeDrag) return;
      if (this.activePointerId != null && event.pointerId !== this.activePointerId) return;

      const xValue = this.getPointerXValue(event);
      const completion = this.resizeDrag
        ? this.finishResizeDrag(xValue)
        : this.finishSelectionDrag(xValue);
      dom.releasePointerCapture?.(event.pointerId);
      event.preventDefault();

      if (this.resizeDrag) {
        this.chart.getZr().setCursorStyle("ew-resize");
      }
      await completion;
      this.updateCreateModeCursor(event);
    };

    dom.addEventListener("pointerup", (event) => {
      finish(event).catch((err) => console.error(err));
    }, { passive: false });

    dom.addEventListener("pointercancel", (event) => {
      if (this.activePointerId != null && event.pointerId !== this.activePointerId) return;
      this.selectionStart = null;
      this.activePointerId = null;
      this.resizeDrag = null;
      this.clearSelectionPreview();
      this.updateCreateModeCursor(event);
    });

    dom.addEventListener("pointerleave", () => {
      if (this.selectionStart == null && !this.resizeDrag) {
        this.chart.getZr().setCursorStyle(this.mode === "create" || this.mode === "gps-create" ? "crosshair" : "default");
      }
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
    this.resizeDrag = null;
    this.clearSelectionPreview();
    this.setDrawingMode(mode === "create" || mode === "gps-create");
    this.syncModeButtons();
    this.syncModeStatus();
    this.actionsMenu?.removeAttribute("open");
    this.syncChartGraphics();
  }

  syncModeStatus() {
    if (!this.modeStatus || !this.modeStatusText) {
      return;
    }

    const message = this.mode === "create"
      ? this.t("createSegmentActive")
      : this.mode === "gps-create"
      ? this.t("createGpsSegmentActive")
      : "";

    this.modeStatusText.textContent = message;
    this.modeStatus.hidden = !message;
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

    this.syncModeStatus();
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

  initSmoothingControls() {
    if (!this.smoothingSlot) {
      return;
    }

    this.smoothingSlot.addEventListener("click", (event) => {
      const button = event.target?.closest?.("button[data-smoothing-level]");
      const zeroBridgeButton = event.target?.closest?.("button[data-zero-bridge]");
      if (zeroBridgeButton) {
        if (zeroBridgeButton.disabled) {
          return;
        }
        this.bridgePowerCadenceZeros = !this.bridgePowerCadenceZeros;
        this.syncSmoothingState();
        this.emitPreferenceChange();
        if (this.currentWorkout) {
          this.updateWorkout(this.currentWorkout);
        }
        return;
      }

      if (!button) {
        return;
      }

      const nextLevel = String(button.dataset.smoothingLevel || "").trim();
      if (!nextLevel || nextLevel === this.smoothingLevel) {
        return;
      }

      this.smoothingLevel = nextLevel;
      this.syncSmoothingState();
      this.emitPreferenceChange();
      if (this.currentWorkout) {
        this.updateWorkout(this.currentWorkout);
      }
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
      this.clearHiddenSegmentFocus();
      this.syncSegmentToggleState();
      this.baseMarkAreas = this.buildMarkAreasForMode(this.currentWorkout);
      this.applyMarkAreas();
      this.emitPreferenceChange();
    });
  }

  hasDistanceXAxis() {
    return hasMeaningfulDistanceSeries(this.currentWorkout?.workoutObject);
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

    const areas = buildMarkAreas(workout, {
      isVisible: (segment) => this.isSegmentTypeVisible(segment)
    });
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

  getResizeEdgeHit(event, hitRadius = SEGMENT_RESIZE_HIT_RADIUS_PX) {
    const rect = this.chart?.getDom?.().getBoundingClientRect?.();
    if (!rect) {
      return null;
    }

    return findManualSegmentResizeEdge({
      segments: this.currentWorkout?.segments,
      focusedSegment: this.focusedSegment,
      pointerPixel: event.clientX - rect.left,
      toPixel: (offset) => this.chart.convertToPixel(
        { xAxisIndex: 0 },
        this.xIndexToValue(offset)
      ),
      isVisible: (segment) => this.isSegmentTypeVisible(segment),
      hitRadius
    });
  }

  updateCreateModeCursor(event) {
    if (this.mode !== "create" || this.resizeDrag) {
      this.chart.getZr().setCursorStyle(
        this.mode === "create" || this.mode === "gps-create" ? "crosshair" : "default"
      );
      return;
    }

    const hit = this.getResizeEdgeHit(
      event,
      event.pointerType === "touch" ? 16 : SEGMENT_RESIZE_HIT_RADIUS_PX
    );
    this.chart.getZr().setCursorStyle(hit ? "ew-resize" : "crosshair");
  }

  startResizeDrag(hit) {
    const segment = hit.segment;
    this.focusedSegment = segment;
    this.hoveredSegment = null;
    this.resizeDrag = {
      segment,
      edge: hit.edge,
      original: { ...segment },
      startOffset: Number(segment.start_offset),
      endOffset: Number(segment.end_offset)
    };
    this.hideSegmentHoverTooltip();
    this.handlers.onSegmentFocusRequested?.(segment);
    this.chart.getZr().setCursorStyle("ew-resize");
    this.applyMarkAreas();
  }

  updateResizePreview(xValue) {
    if (!this.resizeDrag || xValue == null || Number.isNaN(xValue)) {
      return;
    }

    const maximumIndex = Math.max(
      0,
      Number(this.currentWorkout?.workoutObject?.length || 1) - 1
    );
    const nextIndex = Math.max(0, Math.min(maximumIndex, this.xValueToIndex(xValue)));
    if (this.resizeDrag.edge === "start") {
      this.resizeDrag.startOffset = Math.min(
        nextIndex,
        this.resizeDrag.endOffset - SEGMENT_RESIZE_MIN_DURATION_SECONDS
      );
    } else {
      this.resizeDrag.endOffset = Math.max(
        nextIndex,
        this.resizeDrag.startOffset + SEGMENT_RESIZE_MIN_DURATION_SECONDS
      );
    }

    this.previewMarkArea = this.buildSelectionPreviewArea(
      this.resizeDrag.startOffset,
      this.resizeDrag.endOffset
    );
    this.applyMarkAreas();
  }

  async finishResizeDrag(xValue) {
    const drag = this.resizeDrag;
    if (!drag) {
      return;
    }
    if (xValue != null && !Number.isNaN(xValue)) {
      this.updateResizePreview(xValue);
    }

    const startIndex = Math.round(drag.startOffset);
    const endIndex = Math.round(drag.endOffset);
    const changed = startIndex !== Number(drag.original.start_offset)
      || endIndex !== Number(drag.original.end_offset);
    this.activePointerId = null;

    if (!changed) {
      this.resizeDrag = null;
      this.clearSelectionPreview();
      return;
    }

    this.resizeSavePending = true;
    try {
      const updated = await SegmentService.updateManualSegment(
        this.currentWorkout,
        drag.segment,
        { startIndex, endIndex }
      );
      Object.assign(drag.segment, updated);
      this.resizeDrag = null;
      this.previewMarkArea = null;
      this.handlers.onUpdateWorkout?.(this.currentWorkout);
      this.handlers.onToast?.(this.t("segmentResizeSuccess"));
    } catch (error) {
      Object.assign(drag.segment, drag.original);
      this.resizeDrag = null;
      this.previewMarkArea = null;
      this.applyMarkAreas();
      this.handlers.onToast?.(this.t("segmentResizeFailed"));
      console.error("Failed to resize manual segment", error);
    } finally {
      this.resizeSavePending = false;
      this.chart.getZr().setCursorStyle(this.mode === "create" ? "crosshair" : "default");
      this.syncChartGraphics();
    }
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
    const highlightedSegment = this.hoveredSegment || this.focusedSegment;
    const highlightedMarkArea = this.buildHighlightedSegmentArea(
      highlightedSegment,
      this.hoveredSegment ? "hover" : "focus"
    );
    const data = [
      ...this.baseMarkAreas,
      ...(highlightedMarkArea ? [highlightedMarkArea] : []),
      ...(this.previewMarkArea ? [this.previewMarkArea] : [])
    ];

    this.chart.setOption({
      grid: { top: this.getSegmentHeaderGridTop() },
      series: [{
        markArea: { silent: true, data }
      }],
      graphic: this.buildChartGraphics()
    }, { replaceMerge: ["graphic"] });
  }

  getSegmentHeaderLayout() {
    return buildSegmentHeaderLayout({
      segments: this.currentWorkout?.segments,
      isVisible: (segment) => this.isSegmentTypeVisible(segment)
    });
  }

  getSegmentHeaderGridTop() {
    const { laneCount } = this.getSegmentHeaderLayout();
    if (laneCount === 0) {
      return SEGMENT_HEADER_BASE_GRID_TOP_PX;
    }
    return Math.max(
      SEGMENT_HEADER_BASE_GRID_TOP_PX,
      SEGMENT_HEADER_PADDING_TOP_PX
        + laneCount * (SEGMENT_HEADER_HEIGHT_PX + SEGMENT_HEADER_GAP_PX)
        + SEGMENT_HEADER_GAP_PX
    );
  }

  getXAxisPixelExtent() {
    const axis = this.chart?.getModel?.()?.getComponent?.("xAxis", 0)?.axis;
    const extent = axis?.getExtent?.();
    if (!Array.isArray(extent) || extent.length < 2) {
      return { left: 0, right: this.chart?.getWidth?.() || 0 };
    }
    const first = typeof axis.toGlobalCoord === "function" ? axis.toGlobalCoord(extent[0]) : extent[0];
    const second = typeof axis.toGlobalCoord === "function" ? axis.toGlobalCoord(extent[1]) : extent[1];
    return { left: Math.min(first, second), right: Math.max(first, second) };
  }

  getSegmentHeaderId(segment, index) {
    return buildSegmentHeaderGraphicId(segment, index, this.currentWorkout?.id);
  }

  buildSegmentHeaderGraphics() {
    const { items } = this.getSegmentHeaderLayout();
    if (items.length === 0) {
      return [];
    }

    const { left: axisLeft, right: axisRight } = this.getXAxisPixelExtent();
    const isDrawing = this.mode === "create" || this.mode === "gps-create";
    return items.flatMap(({ segment, start, end, lane }, index) => {
      const startPixel = Number(this.chart.convertToPixel({ xAxisIndex: 0 }, this.xIndexToValue(start)));
      const endPixel = Number(this.chart.convertToPixel({ xAxisIndex: 0 }, this.xIndexToValue(end)));
      if (!Number.isFinite(startPixel) || !Number.isFinite(endPixel)) {
        return [];
      }

      const rawLeft = Math.min(startPixel, endPixel);
      const rawRight = Math.max(startPixel, endPixel);
      if (rawRight < axisLeft || rawLeft > axisRight) {
        return [];
      }

      const left = Math.max(axisLeft, rawLeft);
      const right = Math.min(axisRight, rawRight);
      const width = Math.max(4, right - left);
      const y = SEGMENT_HEADER_PADDING_TOP_PX
        + lane * (SEGMENT_HEADER_HEIGHT_PX + SEGMENT_HEADER_GAP_PX);
      const color = getSegmentColor(segment);
      const displayId = Utils.getSegmentDisplayId(segment);
      const isHighlighted = this.hoveredSegment === segment || this.focusedSegment === segment;
      const opacity = isHighlighted ? 0.86 : 0.62;

      return [{
        id: this.getSegmentHeaderId(segment, index),
        type: "group",
        silent: isDrawing,
        z: 120 + lane,
        children: [
          {
            type: "rect",
            silent: isDrawing,
            cursor: isDrawing ? "crosshair" : "pointer",
            shape: { x: left, y, width, height: SEGMENT_HEADER_HEIGHT_PX, r: 3 },
            style: {
              fill: color,
              opacity,
              stroke: color,
              lineWidth: isHighlighted ? 1.5 : 0.75
            },
            onmouseover: (event) => this.handleSegmentHeaderMouseOver(segment, event),
            onmousemove: (event) => this.positionSegmentHoverTooltip(event?.event || event),
            onmouseout: (event) => this.handleSegmentHeaderMouseOut(segment, event),
            onclick: (event) => this.handleSegmentHeaderClick(segment, event)
          },
          ...(displayId != null && width >= 42 ? [{
            type: "text",
            silent: true,
            style: {
              text: `S-${displayId}`,
              x: left + 5,
              y: y + SEGMENT_HEADER_HEIGHT_PX / 2,
              width: Math.max(0, width - 10),
              overflow: "truncate",
              fill: "#ffffff",
              font: "700 8px sans-serif",
              verticalAlign: "middle"
            }
          }] : [])
        ]
      }];
    });
  }

  buildChartGraphics() {
    return [
      ...this.buildSegmentHeaderGraphics(),
      ...this.buildResizeHandleGraphics()
    ];
  }

  buildResizeHandleGraphics() {
    const segment = this.resizeDrag?.segment || this.focusedSegment;
    if (
      this.mode !== "create"
      || !isPersistedManualSegment(segment)
      || !this.isSegmentTypeVisible(segment)
    ) {
      return [];
    }

    const startOffset = this.resizeDrag?.startOffset ?? Number(segment.start_offset);
    const endOffset = this.resizeDrag?.endOffset ?? Number(segment.end_offset);
    const startPixel = Number(this.chart.convertToPixel(
      { xAxisIndex: 0 },
      this.xIndexToValue(startOffset)
    ));
    const endPixel = Number(this.chart.convertToPixel(
      { xAxisIndex: 0 },
      this.xIndexToValue(endOffset)
    ));
    if (!Number.isFinite(startPixel) || !Number.isFinite(endPixel)) {
      return [];
    }

    const top = 40;
    const bottom = Math.max(top + 24, this.chart.getHeight() - 70);
    const color = getSegmentColor(segment);
    return [startPixel, endPixel].map((x, index) => ({
      id: `manual-segment-resize-${index === 0 ? "start" : "end"}`,
      type: "group",
      silent: true,
      z: 200,
      children: [
        {
          type: "rect",
          shape: { x: x - 1.5, y: top, width: 3, height: bottom - top },
          style: { fill: color, opacity: 0.92, shadowBlur: 4, shadowColor: "rgba(15, 23, 42, 0.28)" }
        },
        {
          type: "rect",
          shape: { x: x - 6, y: top - 2, width: 12, height: 18, r: 4 },
          style: { fill: "#ffffff", stroke: color, lineWidth: 2 }
        }
      ]
    }));
  }

  syncChartGraphics() {
    this.chart.setOption({
      graphic: this.buildChartGraphics()
    }, { replaceMerge: ["graphic"] });
  }

  setDrawingMode(enabled) {
    this.chart.getZr().setCursorStyle(enabled ? "crosshair" : "default");
    this.chart.setOption({
      dataZoom: [{
        id: "chart-inside-zoom",
        type: "inside",
        xAxisIndex: 0,
        filterMode: "none",
        disabled: false,
        zoomOnMouseWheel: true,
        moveOnMouseWheel: false,
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

  zoomToCriticalPowerEffort(cpview) {
    const start = Number(cpview?.startOffset);
    const end = Number(cpview?.endOffset);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      this.showAll();
      return;
    }

    const left = Math.min(start, end);
    const right = Math.max(start, end);
    const duration = Math.max(1, right - left + 1);
    const context = Math.max(60, duration * 0.5);
    const maxIndex = Math.max(0, Number(this.currentWorkout?.workoutObject?.length || 1) - 1);
    this.zoomToSegment(
      Math.max(0, left - context),
      Math.min(maxIndex, right + context)
    );
  }

  showAll() {
    if (!this.currentWorkout) {
      return;
    }

    this.chart.dispatchAction({
      type: "dataZoom",
      start: 0,
      end: 100
    });
  }

  syncShowAllButton() {
    if (!this.showAllButton) {
      return;
    }

    const zoom = this.chart?.getOption?.()?.dataZoom?.[0] || {};
    const start = Number(zoom.start);
    const end = Number(zoom.end);
    const showsFullWorkout = Number.isFinite(start)
      && Number.isFinite(end)
      && start <= 0.001
      && end >= 99.999;

    this.showAllButton.disabled = !this.currentWorkout || showsFullWorkout;
  }

  buildHighlightedSegmentArea(segment, mode = "focus") {
    if (!segment || !this.isSegmentTypeVisible(segment)) {
      return null;
    }

    const start = Number(segment.start_offset);
    const end = Number(segment.end_offset);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      return null;
    }

    const displayId = Utils.getSegmentDisplayId(segment);
    const color = getSegmentColor(segment);
    return [
      {
        xAxis: this.xIndexToValue(Math.min(start, end)),
        segmentId: segment.id,
        sid: segment.sid,
        itemStyle: {
          color: getSegmentColor(segment, "area"),
          borderColor: color,
          borderWidth: 2,
          opacity: mode === "hover" ? 0.62 : 0.8
        },
        label: {
          show: displayId != null,
          position: "insideTop",
          formatter: displayId == null ? "" : `S-${displayId}`,
          color,
          backgroundColor: "rgba(255, 255, 255, 0.94)",
          borderColor: color,
          borderWidth: 1,
          borderRadius: 2,
          padding: [2, 5],
          fontSize: 10,
          fontWeight: 800
        }
      },
      {
        xAxis: this.xIndexToValue(Math.max(start, end))
      }
    ];
  }

  focusSegment(segment) {
    if (!segment || !this.isSegmentTypeVisible(segment)) {
      return;
    }

    this.focusedSegment = segment;
    this.applyMarkAreas();

    const start = Number(segment.start_offset);
    const end = Number(segment.end_offset);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      return;
    }

    const left = Math.min(start, end);
    const right = Math.max(start, end);
    const context = Math.max(5, (right - left) * 0.12);
    const maxIndex = Math.max(0, Number(this.currentWorkout?.workoutObject?.length || 1) - 1);
    this.zoomToSegment(
      Math.max(0, left - context),
      Math.min(maxIndex, right + context)
    );
  }

  hoverSegment(segment) {
    if (!segment || !this.isSegmentTypeVisible(segment)) {
      return;
    }
    this.hoveredSegment = segment;
    this.applyMarkAreas();
  }

  clearSegmentHover() {
    if (!this.hoveredSegment) {
      return;
    }
    this.hoveredSegment = null;
    this.applyMarkAreas();
  }

  clearSegmentFocus({ resetZoom = false } = {}) {
    if (this.focusedSegment) {
      this.focusedSegment = null;
      this.applyMarkAreas();
    }

    if (resetZoom) {
      this.chart.dispatchAction({
        type: "dataZoom",
        start: 0,
        end: 100
      });
    }
  }

  clearHiddenSegmentFocus() {
    if (this.focusedSegment && !this.isSegmentTypeVisible(this.focusedSegment)) {
      this.focusedSegment = null;
    }
    if (this.hoveredSegment && !this.isSegmentTypeVisible(this.hoveredSegment)) {
      this.hoveredSegment = null;
    }
  }

  formatTooltip(params) {
    const p = params?.[0];
    if (!p) return "";

    const row = p.data;
    const index = this.xAxisMode === "distance" && this.hasDistanceXAxis()
      ? this.xValueToIndex(Number(row?.[6]) || 0)
      : Math.max(0, Math.min(
          Math.max(0, Number(this.currentWorkout?.workoutObject?.length) - 1),
          Math.round(Number(row?.[0]) || 0)
        ));
    const rawMetrics = this.currentWorkout?.workoutObject?.getMetricsAt?.(index) || null;
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
      ["power", this.t("chart.power"), Number.isFinite(rawMetrics?.power) ? `${Math.round(rawMetrics.power)} W` : "–"],
      ["heartRate", this.t("chart.heartRate"), Number.isFinite(rawMetrics?.hr) ? `${Math.round(rawMetrics.hr)} bpm` : "–"],
      ["cadence", this.t("chart.cadence"), Number.isFinite(rawMetrics?.cadence) ? `${Math.round(rawMetrics.cadence)} rpm` : "–"],
      ["speed", this.t("chart.speed"), Number.isFinite(rawMetrics?.speed) ? `${Number(rawMetrics.speed).toFixed(1)} km/h` : "–"],
      ["altitude", this.t("chart.altitude"), Number.isFinite(rawMetrics?.altitude) ? `${Math.round(rawMetrics.altitude)} m` : "–"],
      ["leftRightBalance", this.t("chart.leftRightBalance"), Number.isFinite(rawMetrics?.leftRightBalance) ? `${Number(rawMetrics.leftRightBalance).toFixed(1)} %` : "–"]
    ].filter(([key]) => this.seriesAvailability[key] !== false);

    return `
      <div style="min-width: 220px;">
        <div style="font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #94a3b8; margin-bottom: 4px;">${this.t("chart.workout")}</div>
        <div style="font-size: 14px; font-weight: 700; color: #0f172a; margin-bottom: 2px;">${headline}</div>
        <div style="font-size: 12px; font-weight: 600; color: #334155; margin-bottom: 8px;">${subline}</div>
        ${rows.map(([, label, value]) => `
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

  handleSegmentHeaderMouseOver(segment, event) {
    this.chart.dispatchAction({ type: "hideTip" });
    if (event?.target?.style) {
      event.target.attr?.({
        style: { ...event.target.style, opacity: 0.9, lineWidth: 1.5 }
      });
    }
    this.showSegmentHoverTooltip(segment, event?.event || event);
  }

  handleSegmentHeaderMouseOut(segment, event) {
    if (event?.target?.style) {
      const isHighlighted = this.hoveredSegment === segment || this.focusedSegment === segment;
      event.target.attr?.({
        style: {
          ...event.target.style,
          opacity: isHighlighted ? 0.86 : 0.62,
          lineWidth: isHighlighted ? 1.5 : 0.75
        }
      });
    }
    this.hideSegmentHoverTooltip();
  }

  handleSegmentHeaderClick(segment, event) {
    if (this.mode === "create" || this.mode === "gps-create") {
      return;
    }
    event?.event?.preventDefault?.();
    event?.event?.stopPropagation?.();
    this.handlers.onZoomSegment?.(
      Number(segment.start_offset),
      Number(segment.end_offset)
    );
  }

  showSegmentHoverTooltip(segment, nativeEvent) {
    if (!this.segmentHoverTooltip) {
      return;
    }

    this.segmentHoverTooltip.innerHTML = Utils.formatSegmentTooltip(segment);
    this.segmentHoverTooltip.style.opacity = "1";
    if (this.tooltipHoveredSegment !== segment) {
      this.tooltipHoveredSegment = segment;
      this.handlers.onSegmentHoverChange?.(segment);
    }
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
    if (this.tooltipHoveredSegment) {
      this.tooltipHoveredSegment = null;
      this.handlers.onSegmentHoverChange?.(null);
    }

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
      leftRightBalance: this.t("chart.leftRightBalance"),
      axisPower: this.t("chart.axisPower"),
      axisHeartCadence: this.t("chart.axisHeartCadence"),
      axisSpeed: this.t("chart.axisSpeed"),
      axisAltitude: this.t("chart.axisAltitude"),
      axisLeftRightBalance: this.t("chart.axisLeftRightBalance")
    };
  }

  getSeriesPalette() {
    return {
      power: "#2563eb",
      heartRate: "#16a34a",
      cadence: "#f59e0b",
      speed: "#ef4444",
      altitude: "#38bdf8",
      leftRightBalance: "#d946ef"
    };
  }

  buildStableYAxisOptions(workoutObject, labels = this.getChartLabels()) {
    const colors = this.getSeriesPalette();
    let bounds = this.yAxisBoundsCache.get(workoutObject);
    if (!bounds) {
      bounds = calculateStableYAxisBounds(workoutObject);
      this.yAxisBoundsCache.set(workoutObject, bounds);
    }

    return [
      {
        type: "value",
        name: labels.axisPower,
        position: "left",
        min: bounds.power.min,
        max: bounds.power.max
      },
      {
        type: "value",
        name: labels.axisHeartCadence,
        position: "right",
        min: bounds.heartCadence.min,
        max: bounds.heartCadence.max
      },
      {
        type: "value",
        name: labels.axisSpeed,
        position: "left",
        offset: 40,
        min: bounds.speed.min,
        max: bounds.speed.max
      },
      {
        type: "value",
        name: labels.axisAltitude,
        position: "right",
        offset: 50,
        min: bounds.altitude.min,
        max: bounds.altitude.max
      },
      {
        type: "value",
        name: labels.axisLeftRightBalance,
        position: "right",
        offset: 96,
        min: 0,
        max: 100,
        interval: 25,
        show: this.seriesAvailability.leftRightBalance === true,
        axisLine: { show: true, lineStyle: { color: colors.leftRightBalance } },
        axisLabel: { color: "#a21caf", formatter: "{value}%" },
        splitLine: { show: false }
      }
    ];
  }

  buildSeriesDefinitions(labels, xField = "x") {
    const colors = this.getSeriesPalette();

    return [
      {
        seriesKey: "power",
        name: labels.power,
        type: "line",
        showSymbol: false,
        connectNulls: this.bridgePowerCadenceZeros,
        ...getChartSeriesSamplingOption("power", this.smoothingLevel),
        yAxisIndex: 0,
        markArea: { silent: true, data: [] },
        lineStyle: { color: colors.power, width: 1.8 },
        itemStyle: { color: colors.power },
        encode: { x: xField, y: "Power" }
      },
      {
        seriesKey: "heartRate",
        name: labels.heartRate,
        type: "line",
        showSymbol: false,
        ...getChartSeriesSamplingOption("heartRate", this.smoothingLevel),
        yAxisIndex: 1,
        lineStyle: { color: colors.heartRate, width: 1.7 },
        itemStyle: { color: colors.heartRate },
        encode: { x: xField, y: "Heartrate" }
      },
      {
        seriesKey: "cadence",
        name: labels.cadence,
        type: "line",
        showSymbol: false,
        connectNulls: this.bridgePowerCadenceZeros,
        ...getChartSeriesSamplingOption("cadence", this.smoothingLevel),
        yAxisIndex: 1,
        lineStyle: { color: colors.cadence, width: 1.7 },
        itemStyle: { color: colors.cadence },
        encode: { x: xField, y: "Cadence" }
      },
      {
        seriesKey: "speed",
        name: labels.speed,
        type: "line",
        showSymbol: false,
        ...getChartSeriesSamplingOption("speed", this.smoothingLevel),
        yAxisIndex: 2,
        lineStyle: { color: colors.speed, width: 1.7 },
        itemStyle: { color: colors.speed },
        encode: { x: xField, y: "Speed" }
      },
      {
        seriesKey: "altitude",
        name: labels.altitude,
        type: "line",
        showSymbol: false,
        ...getChartSeriesSamplingOption("altitude", this.smoothingLevel),
        yAxisIndex: 3,
        z: 1,
        lineStyle: { color: colors.altitude, width: 1.1, opacity: 0.45 },
        areaStyle: { color: colors.altitude, opacity: 0.18, origin: "start" },
        itemStyle: { color: colors.altitude },
        encode: { x: xField, y: "Altitude" }
      },
      {
        seriesKey: "leftRightBalance",
        name: labels.leftRightBalance,
        type: "line",
        showSymbol: false,
        ...getChartSeriesSamplingOption("leftRightBalance", this.smoothingLevel),
        yAxisIndex: 4,
        z: 4,
        lineStyle: { color: colors.leftRightBalance, width: 1.5 },
        itemStyle: { color: colors.leftRightBalance },
        encode: { x: xField, y: "LeftRightBalance" }
      }
    ]
      .filter((series) => this.seriesAvailability[series.seriesKey] !== false)
      .map(({ seriesKey, ...series }) => series);
  }

  getLegendSelection(labels = this.getChartLabels()) {
    return {
      [labels.power]: this.seriesVisibility.power && this.seriesAvailability.power,
      [labels.heartRate]: this.seriesVisibility.heartRate && this.seriesAvailability.heartRate,
      [labels.cadence]: this.seriesVisibility.cadence && this.seriesAvailability.cadence,
      [labels.speed]: this.seriesVisibility.speed && this.seriesAvailability.speed,
      [labels.altitude]: this.seriesVisibility.altitude && this.seriesAvailability.altitude,
      [labels.leftRightBalance]: this.seriesVisibility.leftRightBalance && this.seriesAvailability.leftRightBalance
    };
  }

  getSeriesToggleDefinitions(labels = this.getChartLabels()) {
    const colors = this.getSeriesPalette();
    return [
      { key: "power", label: labels.power, color: colors.power },
      { key: "heartRate", label: labels.heartRate, color: colors.heartRate },
      { key: "cadence", label: labels.cadence, color: colors.cadence },
      { key: "speed", label: labels.speed, color: colors.speed },
      { key: "altitude", label: labels.altitude, color: colors.altitude },
      { key: "leftRightBalance", label: labels.leftRightBalance, color: colors.leftRightBalance }
    ];
  }

  getSmoothingLevelDefinitions() {
    return [
      { key: "automatic", label: this.t("smoothingAutomatic") },
      { key: "off", label: this.t("smoothingOff") },
      { key: "light", label: this.t("smoothingLight") },
      { key: "medium", label: this.t("smoothingMedium") },
      { key: "strong", label: this.t("smoothingStrong") },
      { key: "veryStrong", label: this.t("smoothingVeryStrong") }
    ];
  }

  getSmoothingConfig() {
    const presets = {
      automatic: { power: 10, hr: 5, cadence: 12, speed: 12, altitude: 6, leftRightBalance: 15 },
      off: { power: 0, hr: 0, cadence: 0, speed: 0, altitude: 0, leftRightBalance: 0 },
      light: { power: 10, hr: 5, cadence: 12, speed: 12, altitude: 6, leftRightBalance: 15 },
      medium: { power: 20, hr: 10, cadence: 30, speed: 30, altitude: 10, leftRightBalance: 30 },
      strong: { power: 35, hr: 18, cadence: 45, speed: 45, altitude: 18, leftRightBalance: 45 },
      veryStrong: { power: 60, hr: 28, cadence: 60, speed: 60, altitude: 28, leftRightBalance: 60 }
    };

    return presets[this.smoothingLevel] || presets.medium;
  }

  getChartDataset(workoutObject) {
    if (!ADAPTIVE_CHART_RESOLUTION_ENABLED) {
      this.currentAdaptiveResolution = null;
      return workoutObject.getAsStrideArray({
        smoothing: this.getSmoothingConfig(),
        includeLeftRightBalance: true
      });
    }

    if (
      this.adaptiveResolutionCache?.workoutObject !== workoutObject
      || this.adaptiveResolutionCache?.smoothingLevel !== this.smoothingLevel
      || this.adaptiveResolutionCache?.bridgePowerCadenceZeros !== this.bridgePowerCadenceZeros
    ) {
      this.adaptiveResolutionCache = {
        workoutObject,
        smoothingLevel: this.smoothingLevel,
        bridgePowerCadenceZeros: this.bridgePowerCadenceZeros,
        levels: buildAdaptiveChartResolutionLevels(
          workoutObject,
          this.smoothingLevel,
          undefined,
          { bridgePowerCadenceZeros: this.bridgePowerCadenceZeros }
        )
      };
    }

    const resolution = this.selectCurrentAdaptiveResolution(workoutObject);
    this.currentAdaptiveResolution = resolution;
    return this.adaptiveResolutionCache.levels.get(resolution)
      ?? workoutObject.getAsStrideArray({
        smoothing: this.getSmoothingConfig(),
        includeLeftRightBalance: true
      });
  }

  selectCurrentAdaptiveResolution(workoutObject = this.currentWorkout?.workoutObject) {
    const recordCount = Math.max(0, Number(workoutObject?.length) || 0);
    const zoom = this.chart?.getOption?.()?.dataZoom?.[0] || {};
    const startPercent = Number.isFinite(Number(zoom.start)) ? Number(zoom.start) : 0;
    const endPercent = Number.isFinite(Number(zoom.end)) ? Number(zoom.end) : 100;
    const visibleFraction = Math.max(0.0001, Math.abs(endPercent - startPercent) / 100);

    return selectAdaptiveChartResolution({
      visibleSeconds: recordCount * visibleFraction,
      chartWidth: this.chart?.getWidth?.() || this.container?.clientWidth || 1,
      smoothingLevel: this.smoothingLevel
    });
  }

  scheduleAdaptiveResolutionUpdate() {
    if (!ADAPTIVE_CHART_RESOLUTION_ENABLED || !this.currentWorkout?.workoutObject) {
      return;
    }

    clearTimeout(this.adaptiveResolutionTimer);
    this.adaptiveResolutionTimer = setTimeout(() => {
      this.adaptiveResolutionTimer = null;
      this.applyAdaptiveResolutionForCurrentZoom();
    }, ADAPTIVE_CHART_ZOOM_DELAY_MS);
  }

  applyAdaptiveResolutionForCurrentZoom() {
    const workoutObject = this.currentWorkout?.workoutObject;
    const levels = this.adaptiveResolutionCache?.levels;
    if (!workoutObject || !levels) {
      return;
    }

    const resolution = this.selectCurrentAdaptiveResolution(workoutObject);
    if (resolution === this.currentAdaptiveResolution) {
      return;
    }

    const result = levels.get(resolution);
    if (!result) {
      return;
    }

    const zoomRange = readChartZoomRange(this.chart);
    this.currentAdaptiveResolution = resolution;
    this.chart.setOption({
      dataset: { source: result.data },
      dataZoom: [
        { id: "chart-inside-zoom", ...zoomRange },
        { id: "chart-slider-zoom", ...zoomRange }
      ]
    });
  }

  getSegmentToggleDefinitions() {
    return [
      { key: "criticalPower", label: this.t("segmentTypeCriticalPower"), color: SEGMENT_COLORS.criticalPower.solid },
      { key: "auto", label: this.t("segmentTypeAuto"), color: SEGMENT_COLORS.auto.solid },
      { key: "manual", label: this.t("segmentTypeManual"), color: SEGMENT_COLORS.manual.solid },
      { key: "gps", label: this.t("segmentTypeGps"), color: SEGMENT_COLORS.gps.solid }
    ];
  }

  renderSeriesToggles(labels = this.getChartLabels()) {
    if (!this.seriesToggleSlot) {
      return;
    }

    this.seriesToggleButtons.clear();
    this.seriesToggleSlot.innerHTML = "";

    this.getSeriesToggleDefinitions(labels)
      .filter((series) => this.seriesAvailability[series.key] !== false)
      .forEach((series) => {
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

  renderSmoothingControls() {
    if (!this.smoothingSlot) {
      return;
    }

    this.smoothingButtons.clear();
    this.smoothingSlot.innerHTML = "";

    this.getSmoothingLevelDefinitions().forEach((entry) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "dashboard-series-toggle";
      button.dataset.smoothingLevel = entry.key;
      button.innerHTML = `
        <span class="dashboard-series-toggle__identity">
          <span class="dashboard-series-toggle__label">${entry.label}</span>
        </span>
        <span class="dashboard-series-toggle__state" aria-hidden="true">✓</span>
      `;
      this.smoothingSlot.appendChild(button);
      this.smoothingButtons.set(entry.key, button);
    });

    const zeroBridgeButton = document.createElement("button");
    zeroBridgeButton.type = "button";
    zeroBridgeButton.className = "dashboard-series-toggle dashboard-series-toggle--separated";
    zeroBridgeButton.dataset.zeroBridge = "true";
    zeroBridgeButton.innerHTML = `
      <span class="dashboard-series-toggle__identity">
        <span class="dashboard-series-toggle__label">${this.t("bridgeZeroValues")}</span>
      </span>
      <span class="dashboard-series-toggle__state" aria-hidden="true">✓</span>
    `;
    this.smoothingSlot.appendChild(zeroBridgeButton);
    this.zeroBridgeButton = zeroBridgeButton;

    this.syncSmoothingState();
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

  setSegmentVisibility(visibility = {}) {
    this.segmentVisibility = {
      ...DEFAULT_SEGMENT_VISIBILITY,
      ...visibility
    };
    this.clearHiddenSegmentFocus();
    this.syncSegmentToggleState();

    if (this.currentWorkout) {
      this.baseMarkAreas = this.buildMarkAreasForMode(this.currentWorkout);
      this.applyMarkAreas();
    }
  }

  syncSmoothingState() {
    this.smoothingButtons.forEach((button, key) => {
      const isActive = key === this.smoothingLevel;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-pressed", isActive ? "true" : "false");
    });

    if (this.zeroBridgeButton) {
      this.zeroBridgeButton.disabled = false;
      this.zeroBridgeButton.classList.toggle("is-active", this.bridgePowerCadenceZeros);
      this.zeroBridgeButton.setAttribute(
        "aria-pressed",
        this.bridgePowerCadenceZeros ? "true" : "false"
      );
      this.zeroBridgeButton.title = this.t("bridgeZeroValuesTitle");
    }
  }

  isSegmentTypeVisible(segment) {
    return isSegmentVisible(segment, this.segmentVisibility);
  }

  applySeriesSelection() {
    const labels = this.getChartLabels();
    this.chart.setOption({
      legend: {
        selected: this.getLegendSelection(labels)
      }
    });
  }

  resize() {
    this.chart.resize();
    this.scheduleAdaptiveResolutionUpdate();
    window.requestAnimationFrame(() => this.syncChartGraphics());
  }
  showLoading() { this.chart.showLoading(); }
  hideLoading() { this.chart.hideLoading(); }
}
