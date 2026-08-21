import MapView from "./map-view.js";
import CPChartView from "./cp-chart-view.js?v=atlas-blue-29";
import FTPChartView from "./ftp-chart-view.js";
import CTLChartView from "./ctl-chart-view.js?v=atlas-blue-30";
import ChartView from "./chart-view.js";
import WorkoutService from "./workout-service.js";
import ViewPreferenceService from "./view-preference-service.js";
import { createTranslator, getCurrentLocale } from "./i18n.js";
import {
  createDefaultAnalyticsPreferences,
  mergeAnalyticsPreferences
} from "./analytics-preferences.js";
import {
  resolveAnalyticsTimeRange,
  resolveRelativeAnalyticsRange,
  selectRelativePeriodTimestamp,
  selectStablePeriodTimestamp,
  snapAnalyticsRangeToGrouping,
  toDateInputValue
} from "./analytics-time-range.js?v=atlas-blue-22";
import {
  formatAnalysisPeriod,
  mapSharedGrouping,
  resolveAnalysisPeriod,
  resolveCalendarAnalysisPeriod
} from "./analytics-period.js";
import { POWER_DISTRIBUTION_ZONES } from "../../shared/PowerDistribution.js";

const ANALYTICS_VIEW_KEY = "analytics";
const VIEW_PREFERENCE_SAVE_DELAY_MS = 500;
const VOICE_RECORDING_MAX_MS = 15_000;
const VOICE_FEEDBACK_HIDE_MS = 5_000;
const PERIOD_HOVER_WORKOUT_DELAY_MS = 180;
const PERIOD_WORKOUT_CACHE_LIMIT = 24;
const LOAD_MODEL_SERIES = new Set(["atl", "ctl", "tsb", "tss"]);

export default class Controller {

  constructor() {
    this.focusGridElement = document.getElementById("analytics-focus-grid");
    this.periodInspectorElement = document.getElementById("analytics-period-inspector");
    this.periodTitleElement = document.getElementById("analytics-period-title");
    this.periodSummaryElement = document.getElementById("analytics-period-summary");
    this.periodKpisElement = document.getElementById("analytics-period-kpis");
    this.periodPowerElement = document.getElementById("analytics-period-power");
    this.periodPowerValuesElement = document.getElementById("analytics-period-power-values");
    this.periodZonesElement = document.getElementById("analytics-period-zones");
    this.periodZoneBarElement = document.getElementById("analytics-period-zone-bar");
    this.periodZoneValuesElement = document.getElementById("analytics-period-zone-values");
    this.periodWorkoutsElement = document.getElementById("analytics-period-workouts");
    this.periodLoadMoreElement = document.getElementById("analytics-period-load-more");
    this.periodPageStatusElement = document.getElementById("analytics-period-page-status");
    this.periodLoadMoreButton = document.getElementById("analytics-period-load-more-button");
    this.detailPlaceholderElement = document.getElementById("analytics-detail-placeholder");
    this.detailElement = document.getElementById("analytics-detail");
    this.mapPanelElement = document.getElementById("analytics-map-panel");
    this.workoutMetaElement = document.getElementById("analytics-workout-meta");
    this.workoutIdElement = document.getElementById("analytics-workout-id");
    this.workoutDateElement = document.getElementById("analytics-workout-date");
    this.timeRangeSummaryElement = document.getElementById("analytics-time-range-summary");
    this.voiceButtonElement = document.getElementById("analytics-voice-button");
    this.voiceFeedbackElement = document.getElementById("analytics-voice-feedback");
    this.voiceStatusElement = document.getElementById("analytics-voice-status");
    this.voiceTranscriptElement = document.getElementById("analytics-voice-transcript");
    this.locale = getCurrentLocale();
    this.t = createTranslator("analyticsPage");
    this.analyticsPreferences = createDefaultAnalyticsPreferences();
    this.viewPreferencesAvailable = false;
    this.pendingPreferenceState = null;
    this.preferenceSaveTimer = null;
    this.preferenceSaveChain = Promise.resolve();
    this.chartTimeBounds = {};
    this.loadedChartBounds = new Set();
    this.selectedPeriodRestoreAttempted = false;
    this.selectedPeriod = null;
    this.hoveredPeriod = null;
    this.hoveredPeriodTimestamp = null;
    this.renderedPeriod = null;
    this.selectedWorkoutId = null;
    this.periodRequestId = 0;
    this.periodWorkouts = [];
    this.periodPage = 0;
    this.periodLastPage = 1;
    this.periodTotal = 0;
    this.periodAggregate = null;
    this.periodLoading = false;
    this.preservedPeriodSnapshotRequestId = null;
    this.periodWorkoutCache = new Map();
    this.periodWorkoutPreviewTimer = null;
    this.periodWorkoutPreviewController = null;
    this.previewedWorkoutPeriod = null;
    this.voicePressActive = false;
    this.voiceRecorder = null;
    this.voiceStream = null;
    this.voiceChunks = [];
    this.voiceStopTimer = null;
    this.voiceFeedbackTimer = null;
    this.initViews();
    this.registerGlobalEvents();
    this.initVoiceControl();
  }

  // -----------------------------
  // INIT
  // -----------------------------
  initViews() {
    this.mapView = new MapView("workout-map");

    this.chartView = new ChartView("workout-chart", {
      onChartHoverIndex: (idx) => {
        this.mapView.moveMarkerToIndex(idx);
      },
      onZoomSegment: (start, end) => {
        this.chartView.zoomToSegment(start, end);
      }
    });

    this.cpChartView = null;
    this.ctlChartView = null;

    void this.initAnalyticsCharts();

    const ftpChartElement = document.getElementById("ftp-chart");
    this.ftpChartView = ftpChartElement?.closest("article")?.hidden
      ? null
      : new FTPChartView('ftp-chart', {
        onCPClick: async (_row) => {
          // aktuell leer → bewusst so gelassen
        }
      });
  }

  async initAnalyticsCharts() {
    try {
      const storedState = await ViewPreferenceService.load(ANALYTICS_VIEW_KEY);
      this.viewPreferencesAvailable = true;
      if (storedState) {
        this.analyticsPreferences = {
          ...this.analyticsPreferences,
          ...storedState,
          timeRange: {
            ...this.analyticsPreferences.timeRange,
            ...storedState.timeRange
          },
          loadModel: {
            ...this.analyticsPreferences.loadModel,
            ...storedState.loadModel,
            seriesVisibility: {
              ...this.analyticsPreferences.loadModel.seriesVisibility,
              ...storedState.loadModel?.seriesVisibility
            }
          },
          powerCurve: {
            ...this.analyticsPreferences.powerCurve,
            ...storedState.powerCurve,
            seriesVisibility: {
              ...this.analyticsPreferences.powerCurve.seriesVisibility,
              ...storedState.powerCurve?.seriesVisibility
            }
          }
        };
      }
    } catch (err) {
      console.warn("Analytics preferences remain at their defaults for this session:", err);
    }

    this.renderTimeRangeSummary();
    this.initSharedGroupingControl();
    const grouping = mapSharedGrouping(this.analyticsPreferences.grouping);

    this.cpChartView = new CPChartView('cp-chart', {
      preferences: {
        ...this.analyticsPreferences.powerCurve,
        grouping: grouping.powerCurve
      },
      onPreferenceChange: (patch) => this.updateAnalyticsPreferences("powerCurve", patch),
      onTimeBoundsChange: (bounds) => this.updateChartTimeBounds("powerCurve", bounds),
      onTimeRangeChange: (range) => this.handleChartTimeRangeChange(range),
      onPeriodHover: (selection) => this.handleAnalysisPeriodHover(selection),
      onPeriodHoverEnd: () => this.handleAnalysisPeriodHoverEnd(),
      onPeriodClick: (selection) => this.handleAnalysisPointClick(selection)
    });

    this.ctlChartView = new CTLChartView('ctl-chart', {
      preferences: {
        ...this.analyticsPreferences.loadModel,
        grouping: grouping.loadModel
      },
      onPreferenceChange: (patch) => this.updateAnalyticsPreferences("loadModel", patch),
      onTimeBoundsChange: (bounds) => this.updateChartTimeBounds("loadModel", bounds),
      onTimeRangeChange: (range) => this.handleChartTimeRangeChange(range),
      onPeriodHover: (selection) => this.handleAnalysisPeriodHover(selection),
      onPeriodHoverEnd: () => this.handleAnalysisPeriodHoverEnd(),
      onPeriodClick: (selection) => this.handleAnalysisPointClick(selection)
    });

    echarts.connect([this.ctlChartView.chart, this.cpChartView.chart]);
    this.connectLoadModelPointerToPowerCurve();
    this.connectPowerCurvePointerToLoadModel();
  }

  connectLoadModelPointerToPowerCurve() {
    const sourceChart = this.ctlChartView.chart;
    const targetChart = this.cpChartView.chart;
    let pendingPointer = null;
    let animationFrame = null;

    sourceChart.getZr().on('mousemove', (event) => {
      const sourcePoint = [event.offsetX, event.offsetY];
      if (!sourceChart.containPixel({ gridIndex: 0 }, sourcePoint)) return;

      pendingPointer = sourceChart.convertFromPixel({ xAxisIndex: 0 }, event.offsetX);
      if (!Number.isFinite(Number(pendingPointer)) || animationFrame !== null) return;

      animationFrame = requestAnimationFrame(() => {
        animationFrame = null;
        const timestamp = Number(pendingPointer);
        const targetX = targetChart.convertToPixel({ xAxisIndex: 0 }, timestamp);
        const targetGrid = targetChart.getModel().getComponent('grid', 0)?.coordinateSystem?.getRect();
        if (!Number.isFinite(targetX) || !targetGrid) return;

        targetChart.dispatchAction({
          type: 'updateAxisPointer',
          currTrigger: 'mousemove',
          x: targetX,
          y: targetGrid.y + (targetGrid.height / 2),
          escapeConnect: true
        });
      });
    });
  }

  connectPowerCurvePointerToLoadModel() {
    const sourceChart = this.cpChartView.chart;
    const targetChart = this.ctlChartView.chart;
    let pendingPointer = null;
    let animationFrame = null;

    sourceChart.getZr().on('mousemove', (event) => {
      const sourcePoint = [event.offsetX, event.offsetY];
      if (!sourceChart.containPixel({ gridIndex: 0 }, sourcePoint)) return;

      pendingPointer = sourceChart.convertFromPixel({ xAxisIndex: 0 }, event.offsetX);
      if (!Number.isFinite(Number(pendingPointer)) || animationFrame !== null) return;

      animationFrame = requestAnimationFrame(() => {
        animationFrame = null;
        const timestamp = Number(pendingPointer);
        const targetX = targetChart.convertToPixel({ xAxisIndex: 0 }, timestamp);
        const targetGrid = targetChart.getModel().getComponent('grid', 0)?.coordinateSystem?.getRect();
        if (!Number.isFinite(targetX) || !targetGrid) return;

        targetChart.dispatchAction({
          type: 'updateAxisPointer',
          currTrigger: 'mousemove',
          x: targetX,
          y: targetGrid.y + (targetGrid.height / 2),
          escapeConnect: true
        });
      });
    });
  }

  initSharedGroupingControl() {
    document.querySelectorAll('input[name="analytics-grouping"]').forEach((input) => {
      input.checked = input.value === this.analyticsPreferences.grouping;
      input.addEventListener("change", async (event) => {
        if (!event.target.checked) return;
        await this.setSharedGrouping(event.target.value);
      });
    });
  }

  async setSharedGrouping(value) {
    const grouping = mapSharedGrouping(value);
    const currentRange = resolveAnalyticsTimeRange(
      this.analyticsPreferences.timeRange,
      this.getSharedDisplayBounds()
    );
    const snappedRange = this.analyticsPreferences.timeRange?.mode === "custom"
      ? snapAnalyticsRangeToGrouping(currentRange, grouping.shared)
      : null;
    this.analyticsPreferences = {
      ...this.analyticsPreferences,
      grouping: grouping.shared,
      ...(snappedRange ? {
        timeRange: {
          mode: "custom",
          start: toDateInputValue(snappedRange.start),
          end: toDateInputValue(snappedRange.end)
        }
      } : {}),
      selectedPeriod: null,
      selectedWorkout: null,
      loadModel: { ...this.analyticsPreferences.loadModel, grouping: grouping.loadModel },
      powerCurve: { ...this.analyticsPreferences.powerCurve, grouping: grouping.powerCurve }
    };
    this.loadedChartBounds.clear();
    await Promise.all([
      this.ctlChartView?.setGrouping(grouping.loadModel),
      this.cpChartView?.setGrouping(grouping.powerCurve)
    ]);
    this.scheduleAnalyticsPreferenceSave();
    document.querySelectorAll('input[name="analytics-grouping"]').forEach((input) => {
      input.checked = input.value === grouping.shared;
    });

    if (this.selectedPeriod) {
      this.hidePeriodInspector();
    }
  }

  initVoiceControl() {
    if (!this.voiceButtonElement) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      this.voiceButtonElement.disabled = true;
      this.voiceButtonElement.title = this.t("voiceUnsupported");
      return;
    }

    this.voiceButtonElement.addEventListener("pointerdown", (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      event.preventDefault();
      this.voicePressActive = true;
      this.voiceButtonElement.setPointerCapture?.(event.pointerId);
      this.startVoiceRecording();
    });
    const release = (event) => {
      event.preventDefault();
      this.voicePressActive = false;
      this.stopVoiceRecording();
    };
    this.voiceButtonElement.addEventListener("pointerup", release);
    this.voiceButtonElement.addEventListener("pointercancel", release);
    this.voiceButtonElement.addEventListener("keydown", (event) => {
      if (![' ', 'Enter'].includes(event.key) || event.repeat) return;
      event.preventDefault();
      this.voicePressActive = true;
      this.startVoiceRecording();
    });
    this.voiceButtonElement.addEventListener("keyup", (event) => {
      if (![' ', 'Enter'].includes(event.key)) return;
      event.preventDefault();
      this.voicePressActive = false;
      this.stopVoiceRecording();
    });
  }

  setVoiceFeedback(status, transcript = "", { autoHide = false } = {}) {
    if (!this.voiceFeedbackElement) return;
    clearTimeout(this.voiceFeedbackTimer);
    this.voiceFeedbackTimer = null;
    this.voiceFeedbackElement.hidden = false;
    this.voiceStatusElement.textContent = status;
    this.voiceTranscriptElement.textContent = transcript;
    if (autoHide) {
      this.voiceFeedbackTimer = setTimeout(
        () => this.hideVoiceFeedback(),
        VOICE_FEEDBACK_HIDE_MS
      );
    }
  }

  hideVoiceFeedback() {
    clearTimeout(this.voiceFeedbackTimer);
    this.voiceFeedbackTimer = null;
    if (this.voiceFeedbackElement) this.voiceFeedbackElement.hidden = true;
  }

  async startVoiceRecording() {
    if (this.voiceRecorder || this.voiceButtonElement.classList.contains("is-processing")) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!this.voicePressActive) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const preferredType = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"]
        .find((type) => MediaRecorder.isTypeSupported(type));
      this.voiceStream = stream;
      this.voiceChunks = [];
      this.voiceRecorder = preferredType
        ? new MediaRecorder(stream, { mimeType: preferredType })
        : new MediaRecorder(stream);
      this.voiceRecorder.addEventListener("dataavailable", (event) => {
        if (event.data?.size) this.voiceChunks.push(event.data);
      });
      this.voiceRecorder.addEventListener("stop", () => this.finishVoiceRecording(), { once: true });
      this.voiceRecorder.start();
      this.voiceButtonElement.classList.add("is-recording");
      this.voiceButtonElement.setAttribute("aria-pressed", "true");
      this.setVoiceFeedback(this.t("voiceListening"));
      this.voiceStopTimer = setTimeout(() => {
        this.voicePressActive = false;
        this.stopVoiceRecording();
      }, VOICE_RECORDING_MAX_MS);
    } catch (error) {
      console.error("Voice recording could not start:", error);
      this.voicePressActive = false;
      this.setVoiceFeedback(this.t("voicePermissionError"), "", { autoHide: true });
    }
  }

  stopVoiceRecording() {
    clearTimeout(this.voiceStopTimer);
    this.voiceStopTimer = null;
    if (this.voiceRecorder?.state === "recording") this.voiceRecorder.stop();
  }

  async finishVoiceRecording() {
    const recorder = this.voiceRecorder;
    this.voiceRecorder = null;
    this.voiceButtonElement.classList.remove("is-recording");
    this.voiceButtonElement.classList.add("is-processing");
    this.voiceButtonElement.setAttribute("aria-pressed", "false");
    this.voiceStream?.getTracks().forEach((track) => track.stop());
    this.voiceStream = null;
    this.setVoiceFeedback(this.t("voiceProcessing"));

    try {
      const audio = new Blob(this.voiceChunks, { type: recorder?.mimeType || "audio/webm" });
      this.voiceChunks = [];
      if (!audio.size) throw new Error("Empty audio recording");
      const form = new FormData();
      form.append("audio", audio, "analytics-command.webm");
      form.append("locale", this.locale);
      const response = await fetch("/api/analytics/voice-command", { method: "POST", body: form });
      if (response.status === 401) {
        window.location.href = `/login?redirect=${encodeURIComponent(window.location.pathname)}`;
        return;
      }
      const json = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(json.error || `Voice command failed (${response.status})`);
      const transcript = String(json.data?.transcript || "").trim();
      const appliedCount = await this.applyVoiceActions(json.data?.actions);
      this.setVoiceFeedback(
        appliedCount > 0 ? this.t("voiceApplied") : this.t("voiceNoAction"),
        transcript,
        { autoHide: true }
      );
    } catch (error) {
      console.error("Voice command failed:", error);
      this.setVoiceFeedback(this.t("voiceError"), error.message || "", { autoHide: true });
    } finally {
      this.voiceButtonElement.classList.remove("is-processing");
    }
  }

  async applyVoiceActions(source) {
    const actions = Array.isArray(source) ? source.slice(0, 12) : [];
    let appliedCount = 0;
    for (const action of actions) {
      if (action?.type === "set_grouping" && ["week", "month", "quarter", "year"].includes(action.grouping)) {
        await this.setSharedGrouping(action.grouping);
        appliedCount += 1;
        continue;
      }
      if (action?.type === "set_relative_range" && this.applyRelativeVoiceRange(action.count, action.unit)) {
        appliedCount += 1;
        continue;
      }
      if (action?.type === "set_series_visibility" && this.applyVoiceSeriesVisibility(action.series, action.visible)) {
        appliedCount += 1;
        continue;
      }
      if (action?.type === "open_relative_period" && await this.openRelativeVoicePeriod(action.periodOffset)) {
        appliedCount += 1;
        continue;
      }
      if (action?.type === "open_period" && await this.openVoicePeriod(action.periodDate, action.periodGrouping)) {
        appliedCount += 1;
        continue;
      }
      if (
        action?.type === "open_calendar_period"
        && await this.openCalendarVoicePeriod(action.periodGrouping, action.periodOffset)
      ) {
        appliedCount += 1;
      }
    }
    if (appliedCount > 0) this.scheduleAnalyticsPreferenceSave();
    return appliedCount;
  }

  applyRelativeVoiceRange(countValue, unit) {
    const domain = this.getSharedTimeBounds();
    const range = resolveRelativeAnalyticsRange(domain, countValue, unit);
    if (!range) return false;
    this.handleChartTimeRangeChange(range);
    return true;
  }

  applyVoiceSeriesVisibility(series, visible) {
    if (typeof series !== "string" || typeof visible !== "boolean") return false;
    if (LOAD_MODEL_SERIES.has(series)) {
      if (!this.ctlChartView?.setSeriesVisibility(series, visible)) return false;
      this.analyticsPreferences = mergeAnalyticsPreferences(this.analyticsPreferences, "loadModel", {
        seriesVisibility: { [series]: visible }
      });
      return true;
    }
    if (!this.cpChartView?.setSeriesVisibility(series, visible)) return false;
    this.analyticsPreferences = mergeAnalyticsPreferences(this.analyticsPreferences, "powerCurve", {
      seriesVisibility: { [series]: visible }
    });
    return true;
  }

  async openRelativeVoicePeriod(offsetValue) {
    const visibleRange = resolveAnalyticsTimeRange(
      this.analyticsPreferences.timeRange,
      this.getSharedTimeBounds()
    );
    const timestamps = this.ctlChartView?.getPeriodTimestamps?.() || [];
    const timestamp = selectRelativePeriodTimestamp(timestamps, visibleRange, offsetValue);
    if (timestamp === null) return false;
    await this.handleAnalysisPointClick({
      date: timestamp,
      grouping: this.analyticsPreferences.grouping,
      data: null
    });
    return true;
  }

  async openVoicePeriod(date, grouping) {
    if (!["week", "month", "quarter", "year"].includes(grouping)) return false;
    if (this.analyticsPreferences.grouping !== grouping) {
      await this.setSharedGrouping(grouping);
    }
    const period = resolveAnalysisPeriod(date, grouping);
    if (!period) return false;
    await this.handleAnalysisPointClick({ date: period.startMs, grouping, data: null });
    return true;
  }

  async openCalendarVoicePeriod(grouping, offsetValue) {
    if (!["week", "month", "quarter", "year"].includes(grouping)) return false;
    const period = resolveCalendarAnalysisPeriod(Date.now(), grouping, offsetValue);
    if (!period) return false;
    if (this.analyticsPreferences.grouping !== grouping) {
      await this.setSharedGrouping(grouping);
    }
    await this.handleAnalysisPointClick({ date: period.startMs, grouping, data: null });
    return true;
  }

  async handleAnalysisPointClick(selection) {
    const period = selection?.preferHoveredPeriod && this.hoveredPeriod
      ? this.hoveredPeriod
      : resolveAnalysisPeriod(selection?.date, this.analyticsPreferences.grouping);
    if (!period) return;
    this.rememberSelectedPeriod(period);
    const workoutId = Number(selection?.data?.fileId);
    const hasWorkoutTarget = Number.isInteger(workoutId) && workoutId > 0;
    const isSelectedPeriod = this.isSamePeriod(period, this.selectedPeriod);
    this.ctlChartView?.setSelectedPeriod?.(period);
    this.cpChartView?.setSelectedPeriod?.(period);
    if (isSelectedPeriod && !hasWorkoutTarget) return;
    const preserveHoveredSnapshot = this.isSamePeriod(period, this.hoveredPeriod);
    this.cancelPeriodWorkoutPreview();
    if (preserveHoveredSnapshot) {
      this.periodSummaryElement.textContent = "";
      this.periodSummaryElement.hidden = true;
    }

    try {
      if (!isSelectedPeriod) {
        const isCurrentPeriod = await this.loadPeriodWorkouts(period, {
          preserveSnapshot: preserveHoveredSnapshot
        });
        if (!isCurrentPeriod) return;
      }
      if (hasWorkoutTarget) {
        await this.openWorkoutDetail(workoutId, selection.data, selection.seriesName);
      }
    } catch (err) {
      console.error("Analytics period drill-down failed:", err);
      if (this.periodSummaryElement && this.selectedPeriod === period) {
        this.periodSummaryElement.textContent = this.t("periodError");
      }
    }
  }

  isSamePeriod(left, right) {
    return Boolean(left && right && left.startMs === right.startMs && left.endMs === right.endMs);
  }

  rememberSelectedPeriod(period) {
    const start = toDateInputValue(period?.startMs);
    if (!start) return;
    const selectedPeriod = {
      grouping: this.analyticsPreferences.grouping,
      start
    };
    const current = this.analyticsPreferences.selectedPeriod;
    if (current?.grouping === selectedPeriod.grouping && current?.start === start) return;
    this.analyticsPreferences = {
      ...this.analyticsPreferences,
      selectedPeriod,
      selectedWorkout: null
    };
    this.scheduleAnalyticsPreferenceSave();
  }

  rememberSelectedWorkout(workoutId, cpRow = null) {
    const id = Number(workoutId);
    if (!Number.isSafeInteger(id) || id <= 0) return;
    const startOffset = Number(cpRow?.startOffset);
    const endOffset = Number(cpRow?.endOffset);
    const hasCriticalPowerTarget = Number.isFinite(startOffset)
      && startOffset >= 0
      && Number.isFinite(endOffset)
      && endOffset > startOffset;
    const selectedWorkout = hasCriticalPowerTarget
      ? { id, startOffset, endOffset }
      : { id };
    const current = this.analyticsPreferences.selectedWorkout;
    if (
      current?.id === selectedWorkout.id
      && current?.startOffset === selectedWorkout.startOffset
      && current?.endOffset === selectedWorkout.endOffset
    ) return;
    this.analyticsPreferences = {
      ...this.analyticsPreferences,
      selectedWorkout
    };
    this.scheduleAnalyticsPreferenceSave();
  }

  handleAnalysisPeriodHover(selection) {
    const timestamp = selectStablePeriodTimestamp(
      this.ctlChartView?.getPeriodTimestamps?.() || [],
      selection?.date,
      this.hoveredPeriodTimestamp
    );
    const period = resolveAnalysisPeriod(timestamp, this.analyticsPreferences.grouping);
    if (!period || this.isSamePeriod(period, this.hoveredPeriod)) return;
    this.hoveredPeriodTimestamp = timestamp;
    this.hoveredPeriod = period;
    const isSelected = this.isSamePeriod(period, this.selectedPeriod);
    this.renderPeriodSnapshot(period, {
      aggregate: isSelected ? this.periodAggregate : null,
      total: isSelected ? this.periodTotal : null,
      preview: !isSelected
    });
    this.schedulePeriodWorkoutPreview(period);
  }

  handleAnalysisPeriodHoverEnd() {
    if (!this.hoveredPeriod) return;
    this.cancelPeriodWorkoutPreview();
    this.hoveredPeriod = null;
    this.hoveredPeriodTimestamp = null;
    this.restoreSelectedPeriodWorkoutList();
    if (this.selectedPeriod) {
      if (this.periodLoading) {
        if (this.preservedPeriodSnapshotRequestId === this.periodRequestId) {
          if (this.isSamePeriod(this.selectedPeriod, this.renderedPeriod)) {
            this.periodSummaryElement.textContent = "";
            this.periodSummaryElement.hidden = true;
          } else {
            this.renderPeriodSnapshot(this.selectedPeriod, { preview: false });
          }
          return;
        }
        this.periodTitleElement.textContent = formatAnalysisPeriod(
          this.selectedPeriod,
          this.analyticsPreferences.grouping,
          this.locale
        );
        this.periodSummaryElement.textContent = this.t("periodLoading");
        this.periodSummaryElement.hidden = false;
        this.clearPeriodHeaderDetails();
      } else {
        if (this.isSamePeriod(this.selectedPeriod, this.renderedPeriod)) {
          this.periodSummaryElement.textContent = "";
          this.periodSummaryElement.hidden = true;
        } else {
          this.renderPeriodHeaderDetails();
        }
      }
      return;
    }
    this.periodTitleElement.textContent = this.t("periodTitle");
    this.periodSummaryElement.textContent = "";
    this.periodSummaryElement.hidden = true;
    this.clearPeriodHeaderDetails();
  }

  async loadPeriodWorkouts(period, { preserveSnapshot = false } = {}) {
    const requestId = ++this.periodRequestId;
    this.preservedPeriodSnapshotRequestId = preserveSnapshot ? requestId : null;
    this.selectedPeriod = period;
    this.periodWorkouts = [];
    this.periodPage = 0;
    this.periodLastPage = 1;
    this.periodTotal = 0;
    this.periodAggregate = null;
    this.periodLoading = false;
    if (preserveSnapshot) {
      this.periodSummaryElement.textContent = "";
      this.periodSummaryElement.hidden = true;
    } else {
      this.periodTitleElement.textContent = formatAnalysisPeriod(
        period,
        this.analyticsPreferences.grouping,
        this.locale
      );
      this.periodSummaryElement.textContent = this.t("periodLoading");
      this.periodSummaryElement.hidden = false;
      this.clearPeriodHeaderDetails();
      this.periodWorkoutsElement.replaceChildren();
    }
    this.periodLoadMoreElement.hidden = true;
    const cached = this.periodWorkoutCache.get(this.getPeriodWorkoutCacheKey(period));
    if (cached) {
      const workouts = Array.isArray(cached.data) ? cached.data : [];
      this.periodPage = 1;
      this.periodLastPage = Math.max(1, Number(cached.last_page) || 1);
      this.periodTotal = Number(cached.total_records) || workouts.length;
      this.periodAggregate = cached.filtered_summary || null;
      this.periodWorkouts = [...workouts];
      const previewAlreadyRendered = this.isSamePeriod(period, this.previewedWorkoutPeriod);
      if (!previewAlreadyRendered) this.renderPeriodWorkouts(workouts);
      this.previewedWorkoutPeriod = null;
      if (!preserveSnapshot) this.renderPeriodHeaderDetails();
      this.renderPeriodPaginationState();
      this.preservedPeriodSnapshotRequestId = null;
      return true;
    }
    await this.loadNextPeriodWorkoutPage();
    return requestId === this.periodRequestId && this.selectedPeriod === period;
  }

  buildPeriodWorkoutParams(period, page) {
    return new URLSearchParams({
      page: String(page),
      size: "20",
      scope: "mine",
      sort: JSON.stringify([{ field: "start_time", dir: "desc" }]),
      filter: JSON.stringify([
        { field: "start_time", type: ">=", value: period.start },
        { field: "start_time", type: "<", value: period.end }
      ])
    });
  }

  getPeriodWorkoutCacheKey(period) {
    return `${this.analyticsPreferences.grouping}:${period.startMs}:${period.endMs}`;
  }

  cachePeriodWorkoutResult(period, result) {
    const key = this.getPeriodWorkoutCacheKey(period);
    this.periodWorkoutCache.delete(key);
    this.periodWorkoutCache.set(key, result);
    while (this.periodWorkoutCache.size > PERIOD_WORKOUT_CACHE_LIMIT) {
      this.periodWorkoutCache.delete(this.periodWorkoutCache.keys().next().value);
    }
  }

  cancelPeriodWorkoutPreview() {
    if (this.periodWorkoutPreviewTimer !== null) {
      clearTimeout(this.periodWorkoutPreviewTimer);
      this.periodWorkoutPreviewTimer = null;
    }
    this.periodWorkoutPreviewController?.abort();
    this.periodWorkoutPreviewController = null;
  }

  schedulePeriodWorkoutPreview(period) {
    this.cancelPeriodWorkoutPreview();
    if (this.isSamePeriod(period, this.selectedPeriod)) {
      this.restoreSelectedPeriodWorkoutList();
      return;
    }
    if (this.previewedWorkoutPeriod && !this.isSamePeriod(period, this.previewedWorkoutPeriod)) {
      this.restoreSelectedPeriodWorkoutList();
    }
    this.periodWorkoutPreviewTimer = setTimeout(() => {
      this.periodWorkoutPreviewTimer = null;
      void this.loadPeriodWorkoutPreview(period);
    }, PERIOD_HOVER_WORKOUT_DELAY_MS);
  }

  async loadPeriodWorkoutPreview(period) {
    const cacheKey = this.getPeriodWorkoutCacheKey(period);
    let result = this.periodWorkoutCache.get(cacheKey);
    let requestController = null;
    try {
      if (!result) {
        requestController = new AbortController();
        this.periodWorkoutPreviewController = requestController;
        result = await this.fetchPeriodWorkoutPage(period, 1, requestController.signal);
        if (!result) return;
        this.cachePeriodWorkoutResult(period, result);
      }
      if (!this.isSamePeriod(period, this.hoveredPeriod)) return;
      const workouts = Array.isArray(result.data) ? result.data : [];
      this.renderPeriodWorkouts(workouts);
      this.previewedWorkoutPeriod = period;
      this.periodLoadMoreElement.hidden = true;
    } catch (err) {
      if (err?.name !== "AbortError") {
        console.warn("Analytics period workout preview failed:", err);
      }
    } finally {
      if (this.periodWorkoutPreviewController === requestController) {
        this.periodWorkoutPreviewController = null;
      }
    }
  }

  restoreSelectedPeriodWorkoutList() {
    if (!this.previewedWorkoutPeriod) return;
    this.previewedWorkoutPeriod = null;
    if (this.selectedPeriod) {
      this.renderPeriodWorkouts(this.periodWorkouts);
      if (this.selectedWorkoutId) this.markSelectedWorkoutCard(this.selectedWorkoutId);
      this.renderPeriodPaginationState();
      return;
    }
    this.periodWorkoutsElement.replaceChildren();
    const empty = document.createElement("p");
    empty.className = "analytics-period-empty";
    empty.textContent = this.t("periodInitial");
    this.periodWorkoutsElement.append(empty);
    this.periodLoadMoreElement.hidden = true;
  }

  async fetchPeriodWorkoutPage(period, page, signal = undefined) {
    const params = this.buildPeriodWorkoutParams(period, page);
    const response = await fetch(`/files/workouts?${params.toString()}`, { signal });
    if (response.status === 401) {
      window.location.href = "/login";
      return null;
    }
    if (!response.ok) throw new Error(`Period workouts failed (${response.status})`);
    return response.json();
  }

  renderPeriodPaginationState() {
    const hasMore = this.periodPage < this.periodLastPage;
    this.periodLoadMoreElement.hidden = !hasMore;
    this.periodPageStatusElement.hidden = !hasMore;
    if (hasMore) {
      this.periodPageStatusElement.textContent = this.t("periodLoadedSummary", {
        shown: this.periodWorkouts.length,
        count: this.periodTotal
      });
    }
  }

  async loadNextPeriodWorkoutPage() {
    if (!this.selectedPeriod || this.periodLoading || this.periodPage >= this.periodLastPage) {
      return;
    }

    const requestId = this.periodRequestId;
    const preserveSnapshot = this.preservedPeriodSnapshotRequestId === requestId;
    const page = this.periodPage + 1;
    this.periodLoading = true;
    this.periodLoadMoreButton.disabled = true;
    this.periodWorkoutsElement.setAttribute("aria-busy", "true");

    try {
      const result = await this.fetchPeriodWorkoutPage(this.selectedPeriod, page);
      if (!result) return;
      if (requestId !== this.periodRequestId) return;

      const workouts = Array.isArray(result.data) ? result.data : [];
      this.periodPage = page;
      this.periodLastPage = Math.max(1, Number(result.last_page) || 1);
      this.periodTotal = Number(result.total_records) || workouts.length;
      if (page === 1) this.periodAggregate = result.filtered_summary || null;
      if (page === 1) this.cachePeriodWorkoutResult(this.selectedPeriod, result);
      this.periodWorkouts.push(...workouts);
      this.renderPeriodWorkouts(workouts, { append: page > 1 });
      this.periodSummaryElement.textContent = "";
      this.periodSummaryElement.hidden = true;
      if (!preserveSnapshot) this.renderPeriodHeaderDetails();
      this.renderPeriodPaginationState();
    } catch (err) {
      if (requestId === this.periodRequestId) {
        this.periodSummaryElement.textContent = this.t("periodError");
        this.periodSummaryElement.hidden = false;
      }
      throw err;
    } finally {
      if (requestId === this.periodRequestId) {
        this.periodLoading = false;
        if (this.preservedPeriodSnapshotRequestId === requestId) {
          this.preservedPeriodSnapshotRequestId = null;
        }
        this.periodLoadMoreButton.disabled = false;
        this.periodWorkoutsElement.removeAttribute("aria-busy");
      }
    }
  }

  renderPeriodWorkouts(workouts, { append = false } = {}) {
    if (!append) this.periodWorkoutsElement.replaceChildren();
    if (!workouts.length && !append) {
      const empty = document.createElement("p");
      empty.className = "analytics-period-empty";
      empty.textContent = this.t("periodEmpty");
      this.periodWorkoutsElement.append(empty);
      return;
    }

    workouts.forEach((workout) => {
      const entityKey = `${workout.entity_type}:${workout.id}`;
      const alreadyRendered = [...this.periodWorkoutsElement.children]
        .some((card) => card.dataset?.entityKey === entityKey);
      if (!alreadyRendered) {
        this.periodWorkoutsElement.append(this.createPeriodWorkoutCard(workout));
      }
    });
  }

  createPeriodWorkoutCard(workout) {
    const isWorkout = workout.entity_type === "workout";
    const card = document.createElement(isWorkout ? "button" : "article");
    card.className = "analytics-period-card";
    card.dataset.entityId = String(workout.id);
    card.dataset.entityKey = `${workout.entity_type}:${workout.id}`;
    if (isWorkout) card.type = "button";

    const cpHighlights = isWorkout
      ? (this.cpChartView?.getPeriodWorkoutHighlights(this.renderedPeriod || this.selectedPeriod) || [])
        .filter((highlight) => highlight.fileId === Number(workout.id))
      : [];
    if (cpHighlights.length > 0) {
      card.classList.add("has-cp-highlights");
      const markerRail = document.createElement("span");
      markerRail.className = "analytics-period-card__cp-markers";
      markerRail.style.setProperty("--cp-marker-count", String(cpHighlights.length));
      markerRail.title = cpHighlights.map(({ label }) => label).join(" · ");
      markerRail.setAttribute("aria-label", markerRail.title);
      markerRail.append(...cpHighlights.map(({ label, color }) => {
        const marker = document.createElement("span");
        marker.className = "analytics-period-card__cp-marker";
        marker.style.backgroundColor = color;
        marker.dataset.cpLabel = label;
        return marker;
      }));
      card.append(markerRail);
    }

    const header = document.createElement("div");
    header.className = "analytics-period-card__header";
    const identity = document.createElement("div");
    identity.className = "analytics-period-card__identity";
    const id = document.createElement("strong");
    id.textContent = isWorkout ? `W-${workout.id}` : this.t("manualActivity");
    const type = document.createElement("span");
    type.className = "analytics-period-card__type";
    type.textContent = workout.title || workout.workout_type || workout.activity_type || "";
    identity.append(id, type);
    const time = document.createElement("time");
    const date = new Date(workout.start_time);
    time.textContent = Number.isNaN(date.getTime())
      ? ""
      : new Intl.DateTimeFormat(this.locale, { dateStyle: "medium" }).format(date);
    header.append(identity, time);

    const metrics = document.createElement("div");
    metrics.className = "analytics-period-card__metrics";
    [
      this.formatDurationMetric(workout.total_timer_time),
      workout.avg_power == null ? null : `${Math.round(Number(workout.avg_power))} W`,
      workout.TSS == null ? null : `${Math.round(Number(workout.TSS))} TSS`
    ].filter(Boolean).forEach((value) => {
      const metric = document.createElement("span");
      metric.textContent = value;
      metrics.append(metric);
    });
    card.append(header, metrics);
    if (isWorkout) {
      card.addEventListener("click", () => this.openWorkoutDetail(Number(workout.id)));
    }
    return card;
  }

  formatDurationMetric(seconds) {
    if (seconds == null) return null;
    const minutes = Math.round(Number(seconds) / 60);
    if (!Number.isFinite(minutes)) return null;
    if (minutes < 60) return `${minutes} min`;
    return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")} h`;
  }

  formatDistanceMetric(meters) {
    const kilometers = Number(meters) / 1000;
    if (!Number.isFinite(kilometers) || kilometers <= 0) return null;
    return `${new Intl.NumberFormat(this.locale, {
      maximumFractionDigits: kilometers < 100 ? 1 : 0
    }).format(kilometers)} km`;
  }

  createPeriodMetric(label, value, className = "analytics-period-kpi") {
    const metric = document.createElement("span");
    metric.className = className;
    const metricValue = document.createElement("strong");
    metricValue.textContent = value;
    const metricLabel = document.createElement("span");
    metricLabel.textContent = label;
    metric.append(metricValue, metricLabel);
    return metric;
  }

  createPeriodPowerMetric(label, value, target) {
    const workoutId = Number(target?.fileId);
    const startOffset = Number(target?.startOffset);
    const endOffset = Number(target?.endOffset);
    const hasWorkoutTarget = Number.isInteger(workoutId)
      && workoutId > 0
      && Number.isFinite(startOffset)
      && Number.isFinite(endOffset)
      && endOffset > startOffset;
    if (!hasWorkoutTarget) {
      return this.createPeriodMetric(label, value, "analytics-period-power__metric");
    }

    const metric = document.createElement("button");
    metric.type = "button";
    metric.className = "analytics-period-power__metric analytics-period-power__metric--action";
    metric.dataset.workoutId = String(workoutId);
    metric.dataset.startOffset = String(startOffset);
    metric.dataset.endOffset = String(endOffset);
    const isSelected = this.isSelectedPowerMetric(workoutId, target);
    metric.classList.toggle("is-selected", isSelected);
    metric.setAttribute("aria-pressed", String(isSelected));
    metric.title = `${label} · W-${workoutId}`;
    metric.setAttribute("aria-label", `${label}, ${value}, W-${workoutId}`);
    const metricValue = document.createElement("strong");
    metricValue.textContent = value;
    const metricLabel = document.createElement("span");
    metricLabel.textContent = label;
    metric.append(metricValue, metricLabel);
    metric.addEventListener("click", async () => {
      metric.disabled = true;
      try {
        await this.openWorkoutDetail(workoutId, target, label);
      } finally {
        metric.disabled = false;
      }
    });
    return metric;
  }

  clearPeriodHeaderDetails() {
    this.renderedPeriod = null;
    this.periodKpisElement?.replaceChildren();
    this.periodPowerValuesElement?.replaceChildren();
    this.periodZoneBarElement?.replaceChildren();
    this.periodZoneValuesElement?.replaceChildren();
    if (this.periodKpisElement) this.periodKpisElement.hidden = true;
    if (this.periodZonesElement) this.periodZonesElement.hidden = true;
    if (this.periodPowerElement) this.periodPowerElement.hidden = true;
    if (this.periodPageStatusElement) {
      this.periodPageStatusElement.hidden = true;
      this.periodPageStatusElement.textContent = "";
    }
  }

  renderPeriodHeaderDetails() {
    if (!this.selectedPeriod) return;
    this.renderPeriodSnapshot(this.selectedPeriod, {
      aggregate: this.periodAggregate,
      total: this.periodTotal,
      preview: false
    });
  }

  renderPeriodSnapshot(period, { aggregate = null, total = null, preview = false } = {}) {
    if (!period || !this.periodKpisElement || !this.periodPowerValuesElement) return;
    this.renderedPeriod = period;
    const loadSummary = this.ctlChartView?.getPeriodSummary(period) || {};
    const distribution = this.ctlChartView?.getPeriodDistribution(period);
    const summary = aggregate || {};
    const activityCount = Number(summary.activity_count ?? loadSummary.activityCount ?? total) || 0;
    const duration = this.formatDurationMetric(summary.total_timer_time ?? loadSummary.totalTimerTime);
    const distance = this.formatDistanceMetric(summary.total_distance ?? loadSummary.totalDistance);

    this.periodTitleElement.textContent = formatAnalysisPeriod(
      period,
      this.analyticsPreferences.grouping,
      this.locale
    );
    this.periodSummaryElement.textContent = "";
    this.periodSummaryElement.hidden = true;

    const metrics = [
      [this.t("periodActivitiesLabel"), activityCount > 0 ? String(activityCount) : null],
      [this.t("periodDurationLabel"), duration],
      [this.t("periodTssLabel"), Number.isFinite(Number(loadSummary.tss)) ? String(Math.round(loadSummary.tss)) : null],
      ["CTL", Number.isFinite(Number(loadSummary.ctl)) ? String(Math.round(loadSummary.ctl)) : null],
      ["ATL", Number.isFinite(Number(loadSummary.atl)) ? String(Math.round(loadSummary.atl)) : null],
      ["TSB", Number.isFinite(Number(loadSummary.tsb)) ? String(Math.round(loadSummary.tsb)) : null],
      [this.t("periodDistanceLabel"), distance]
    ].filter(([, value]) => value != null);
    this.periodKpisElement.replaceChildren(...metrics.map(([label, value]) => (
      this.createPeriodMetric(label, value)
    )));
    this.periodKpisElement.hidden = metrics.length === 0;

    this.renderPeriodDistribution(distribution);
    const powerMetrics = this.cpChartView?.getVisiblePeriodMetrics(period) || [];
    this.periodPowerValuesElement.replaceChildren(...powerMetrics.map(([label, value, target]) => (
      this.createPeriodPowerMetric(label, `${Math.round(value)} W`, target)
    )));
    this.periodPowerElement.hidden = powerMetrics.length === 0;
  }

  renderPeriodDistribution(distribution) {
    if (!this.periodZonesElement || !this.periodZoneBarElement || !this.periodZoneValuesElement) return;
    const zones = distribution
      ? POWER_DISTRIBUTION_ZONES.map((zone) => ({
          ...zone,
          percent: Number(distribution.zonePercentages?.[zone.key]) || 0
        })).filter((zone) => zone.percent > 0)
      : [];
    this.periodZoneBarElement.replaceChildren(...zones.map((zone) => {
      const segment = document.createElement("span");
      segment.className = "analytics-period-zone-bar__segment";
      segment.style.width = `${zone.percent}%`;
      segment.style.backgroundColor = zone.color;
      return segment;
    }));
    const zoneValues = zones.map((zone) => {
      const value = document.createElement("span");
      value.className = "analytics-period-zone-value";
      value.style.setProperty("--analytics-zone-color", zone.color);
      const duration = this.formatDurationMetric(distribution.zoneSeconds?.[zone.key]);
      value.textContent = `${zone.key.toUpperCase()} ${zone.percent.toFixed(1)} %${duration ? ` · ${duration}` : ""}`;
      return value;
    });
    const distributionDetails = distribution ? [
      [this.t("distributionActive"), distribution.activeSeconds],
      [this.t("distributionCoasting"), distribution.zeroSeconds],
      [this.t("distributionWithoutFtp"), distribution.unclassifiedSeconds]
    ].filter(([, seconds]) => Number(seconds) > 0).map(([label, seconds]) => {
      const value = document.createElement("span");
      value.className = "analytics-period-zone-value analytics-period-zone-value--summary";
      value.textContent = `${label}: ${this.formatDurationMetric(seconds)}`;
      return value;
    }) : [];
    this.periodZoneValuesElement.replaceChildren(...zoneValues, ...distributionDetails);
    this.periodZonesElement.hidden = zones.length === 0;
  }

  async openWorkoutDetail(workoutId, cpRow = null, seriesName = "") {
    const workout = await WorkoutService.loadWorkoutByRow(workoutId);
    if (!workout) return false;
    this.selectedWorkoutId = workoutId;
    this.detailPlaceholderElement.hidden = true;
    this.detailElement.hidden = false;
    this.focusGridElement.classList.toggle("analytics-focus-grid--no-map", !workout.validGps);
    if (cpRow?.startOffset != null && cpRow?.endOffset != null) {
      this.chartView.updateWorkoutCP(workout, cpRow);
    } else {
      this.chartView.updateWorkout(workout);
    }
    this.mapView.renderTrack(workout);
    this.renderWorkoutMeta(workout);
    this.markSelectedWorkoutCard(workoutId);
    this.rememberSelectedWorkout(workoutId, cpRow);
    this.markSelectedPowerMetric(workoutId, cpRow);
    requestAnimationFrame(() => {
      this.chartView.resize();
      this.mapView.resize();
    });
    return true;
  }

  markSelectedWorkoutCard(workoutId) {
    this.periodWorkoutsElement.querySelectorAll(".analytics-period-card").forEach((card) => {
      card.classList.toggle(
        "is-selected",
        card.dataset.entityKey === `workout:${workoutId}`
      );
    });
  }

  isSelectedPowerMetric(workoutId, cpRow) {
    const selected = this.analyticsPreferences.selectedWorkout;
    return selected?.id === Number(workoutId)
      && Number.isFinite(Number(cpRow?.startOffset))
      && Number.isFinite(Number(cpRow?.endOffset))
      && selected.startOffset === Number(cpRow.startOffset)
      && selected.endOffset === Number(cpRow.endOffset);
  }

  markSelectedPowerMetric(workoutId, cpRow = null) {
    const selectedStart = Number(cpRow?.startOffset);
    const selectedEnd = Number(cpRow?.endOffset);
    const hasTarget = Number.isFinite(selectedStart)
      && Number.isFinite(selectedEnd)
      && selectedEnd > selectedStart;
    this.periodPowerValuesElement?.querySelectorAll(
      "button.analytics-period-power__metric--action"
    ).forEach((metric) => {
      const isSelected = hasTarget
        && Number(metric.dataset.workoutId) === Number(workoutId)
        && Number(metric.dataset.startOffset) === selectedStart
        && Number(metric.dataset.endOffset) === selectedEnd;
      metric.classList.toggle("is-selected", isSelected);
      metric.setAttribute("aria-pressed", String(isSelected));
    });
  }

  hidePeriodInspector() {
    this.cancelPeriodWorkoutPreview();
    this.ctlChartView?.setSelectedPeriod?.(null);
    this.cpChartView?.setSelectedPeriod?.(null);
    this.selectedPeriod = null;
    this.hoveredPeriod = null;
    this.hoveredPeriodTimestamp = null;
    this.renderedPeriod = null;
    this.selectedWorkoutId = null;
    ++this.periodRequestId;
    this.periodWorkouts = [];
    this.periodPage = 0;
    this.periodLastPage = 1;
    this.periodTotal = 0;
    this.periodAggregate = null;
    this.periodLoading = false;
    this.preservedPeriodSnapshotRequestId = null;
    this.previewedWorkoutPeriod = null;
    this.periodLoadMoreButton.disabled = false;
    this.periodWorkoutsElement.removeAttribute("aria-busy");
    this.periodTitleElement.textContent = this.t("periodTitle");
    this.periodSummaryElement.textContent = "";
    this.periodSummaryElement.hidden = true;
    this.clearPeriodHeaderDetails();
    this.periodWorkoutsElement.replaceChildren();
    const empty = document.createElement("p");
    empty.className = "analytics-period-empty";
    empty.textContent = this.t("periodInitial");
    this.periodWorkoutsElement.append(empty);
    this.periodLoadMoreElement.hidden = true;
    this.detailElement.hidden = true;
    this.detailPlaceholderElement.hidden = false;
  }

  updateAnalyticsPreferences(chartKey, patch) {
    this.analyticsPreferences = mergeAnalyticsPreferences(
      this.analyticsPreferences,
      chartKey,
      patch
    );
    this.scheduleAnalyticsPreferenceSave();
  }

  scheduleAnalyticsPreferenceSave() {
    this.pendingPreferenceState = this.analyticsPreferences;

    clearTimeout(this.preferenceSaveTimer);
    this.preferenceSaveTimer = setTimeout(() => {
      this.persistAnalyticsPreferences();
    }, VIEW_PREFERENCE_SAVE_DELAY_MS);
  }

  updateChartTimeBounds(chartKey, bounds) {
    this.loadedChartBounds.add(chartKey);
    this.chartTimeBounds[chartKey] = bounds;
    if (this.loadedChartBounds.size >= 2) {
      this.applySelectedTimeRange();
      void this.restorePersistedSelectedPeriod();
    }
  }

  async restorePersistedSelectedPeriod() {
    if (this.selectedPeriodRestoreAttempted || this.loadedChartBounds.size < 2) return;
    const saved = this.analyticsPreferences.selectedPeriod;
    this.selectedPeriodRestoreAttempted = true;
    if (!saved || saved.grouping !== this.analyticsPreferences.grouping) return;

    const requestedPeriod = resolveAnalysisPeriod(saved.start, saved.grouping);
    const timestamp = (this.ctlChartView?.getPeriodTimestamps?.() || []).find((value) => (
      this.isSamePeriod(
        resolveAnalysisPeriod(value, saved.grouping),
        requestedPeriod
      )
    ));
    if (!Number.isFinite(Number(timestamp))) {
      this.analyticsPreferences = {
        ...this.analyticsPreferences,
        selectedPeriod: null,
        selectedWorkout: null
      };
      this.scheduleAnalyticsPreferenceSave();
      return;
    }

    await this.handleAnalysisPointClick({
      date: Number(timestamp),
      grouping: saved.grouping,
      data: null
    });

    const selectedWorkout = this.analyticsPreferences.selectedWorkout;
    if (!selectedWorkout) return;
    try {
      const restored = await this.openWorkoutDetail(selectedWorkout.id, selectedWorkout);
      if (restored) return;
    } catch (err) {
      console.warn("Persisted analytics workout could not be restored:", err);
    }
    this.analyticsPreferences = {
      ...this.analyticsPreferences,
      selectedWorkout: null
    };
    this.scheduleAnalyticsPreferenceSave();
  }

  getSharedTimeBounds() {
    const bounds = Object.values(this.chartTimeBounds).filter(Boolean);
    if (!bounds.length) return null;
    return {
      start: Math.min(...bounds.map((item) => item.start)),
      end: Math.max(...bounds.map((item) => item.end))
    };
  }

  getSharedDisplayBounds() {
    return snapAnalyticsRangeToGrouping(
      this.getSharedTimeBounds(),
      this.analyticsPreferences.grouping
    );
  }

  applySelectedTimeRange() {
    const domain = this.getSharedDisplayBounds();
    const range = resolveAnalyticsTimeRange(
      this.analyticsPreferences.timeRange,
      domain
    );
    if (!range) return;

    this.cpChartView?.setTimeRange(range, domain);
    this.ctlChartView?.setTimeRange(range, domain);
    this.renderTimeRangeSummary(range);
  }

  handleChartTimeRangeChange(range) {
    if (!range || range.start > range.end) return;
    const start = toDateInputValue(range.start);
    const end = toDateInputValue(range.end);
    if (!start || !end) return;

    this.analyticsPreferences = {
      ...this.analyticsPreferences,
      timeRange: { mode: "custom", start, end }
    };
    const domain = this.getSharedDisplayBounds();
    this.cpChartView?.setTimeRange(range, domain);
    this.ctlChartView?.setTimeRange(range, domain);
    this.renderTimeRangeSummary(range);
    this.scheduleAnalyticsPreferenceSave();
  }

  renderTimeRangeSummary(resolvedRange = null) {
    if (!this.timeRangeSummaryElement) return;
    const range = resolvedRange || resolveAnalyticsTimeRange(
      this.analyticsPreferences.timeRange,
      this.getSharedDisplayBounds()
    );
    if (!range) {
      this.timeRangeSummaryElement.textContent = "";
      return;
    }

    const formatter = new Intl.DateTimeFormat(this.locale, {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      timeZone: "UTC"
    });
    this.timeRangeSummaryElement.textContent = `${formatter.format(range.start)} – ${formatter.format(range.end)}`;
  }

  persistAnalyticsPreferences({ keepalive = false } = {}) {
    const state = this.pendingPreferenceState;
    if (!state || !this.viewPreferencesAvailable) {
      return;
    }

    this.pendingPreferenceState = null;
    clearTimeout(this.preferenceSaveTimer);
    this.preferenceSaveTimer = null;

    if (keepalive) {
      void ViewPreferenceService.save(ANALYTICS_VIEW_KEY, state, { keepalive })
        .catch((err) => console.warn("Analytics preferences could not be saved:", err));
      return;
    }

    this.preferenceSaveChain = this.preferenceSaveChain
      .catch(() => {})
      .then(() => ViewPreferenceService.save(ANALYTICS_VIEW_KEY, state))
      .catch((err) => {
        console.warn("Analytics preferences could not be saved:", err);
      });
  }

  renderWorkoutMeta(workout) {
    if (!this.workoutMetaElement || !this.workoutIdElement || !this.workoutDateElement) {
      return;
    }

    const workoutId = workout?.id;
    const startTime = workout?.start_time || workout?.workoutObject?.getStartTime?.();
    const date = startTime ? new Date(startTime) : null;
    const hasDate = date && !Number.isNaN(date.getTime());

    if (workoutId == null && !hasDate) {
      this.workoutMetaElement.hidden = true;
      return;
    }

    this.workoutIdElement.textContent = workoutId == null ? "" : `W-${workoutId}`;
    this.workoutDateElement.textContent = hasDate
      ? new Intl.DateTimeFormat(this.locale, { dateStyle: "short" }).format(date)
      : "";
    this.workoutDateElement.dateTime = hasDate ? date.toISOString() : "";

    const separator = this.workoutMetaElement.querySelector("span");
    if (separator) {
      separator.hidden = workoutId == null || !hasDate;
    }
    this.workoutIdElement.hidden = workoutId == null;
    this.workoutDateElement.hidden = !hasDate;
    this.workoutMetaElement.hidden = false;
  }

  // -----------------------------
  // GLOBAL EVENTS
  // -----------------------------
  registerGlobalEvents() {
    window.addEventListener("resize", () => this.onResize());
    window.addEventListener("pagehide", () => {
      this.persistAnalyticsPreferences({ keepalive: true });
    });
    document.addEventListener("pointerdown", (event) => {
      if (this.voiceFeedbackElement?.hidden) return;
      if (this.voiceButtonElement?.contains(event.target)) return;
      if (this.voiceFeedbackElement?.contains(event.target)) return;
      this.hideVoiceFeedback();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") this.hideVoiceFeedback();
    });
    this.periodLoadMoreButton?.addEventListener("click", () => {
      void this.loadNextPeriodWorkoutPage().catch((err) => {
        console.error("More analytics period workouts could not be loaded:", err);
      });
    });
  }

  onResize() {
    this.chartView.resize();
    this.mapView.resize();
    this.cpChartView?.resize();
    this.ftpChartView?.resize();
    this.ctlChartView?.resize();
  }

}
