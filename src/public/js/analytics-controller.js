import MapView from "./map-view.js";
import CPChartView from "./cp-chart-view.js";
import FTPChartView from "./ftp-chart-view.js";
import CTLChartView from "./ctl-chart-view.js";
import ChartView from "./chart-view.js";
import WorkoutService from "./workout-service.js";
import ViewPreferenceService from "./view-preference-service.js";
import {
  createDefaultAnalyticsPreferences,
  mergeAnalyticsPreferences
} from "./analytics-preferences.js";

const ANALYTICS_VIEW_KEY = "analytics";
const VIEW_PREFERENCE_SAVE_DELAY_MS = 500;

export default class Controller {

  constructor() {
    this.shellElement = document.getElementById("analytics-shell");
    this.heroElement = document.getElementById("analytics-hero");
    this.chartGridElement = document.getElementById("analytics-chart-grid");
    this.focusGridElement = document.getElementById("analytics-focus-grid");
    this.workoutMetaElement = document.getElementById("analytics-workout-meta");
    this.workoutIdElement = document.getElementById("analytics-workout-id");
    this.workoutDateElement = document.getElementById("analytics-workout-date");
    this.locale = window.__I18N?.locale || document.documentElement.lang || "en";
    this.layoutMeasureRaf = null;
    this.layoutObserver = null;
    this.analyticsPreferences = createDefaultAnalyticsPreferences();
    this.viewPreferencesAvailable = false;
    this.pendingPreferenceState = null;
    this.preferenceSaveTimer = null;
    this.preferenceSaveChain = Promise.resolve();
    this.initViews();
    this.registerGlobalEvents();
    this.initLayoutObservers();
    this.scheduleDesktopLayoutMeasure();
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
        onCPClick: async (row) => {
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

    this.cpChartView = new CPChartView('cp-chart', {
      preferences: this.analyticsPreferences.powerCurve,
      onPreferenceChange: (patch) => this.updateAnalyticsPreferences("powerCurve", patch),
      onCPClick: async (row) => {
        const workout = await WorkoutService.loadWorkoutByRow(row.fileId);

        this.chartView.updateWorkoutCP(workout, row);
        this.mapView.renderTrack(workout);
        this.renderWorkoutMeta(workout);
      }
    });

    this.ctlChartView = new CTLChartView('ctl-chart', {
      preferences: this.analyticsPreferences.loadModel,
      onPreferenceChange: (patch) => this.updateAnalyticsPreferences("loadModel", patch),
      onCPClick: async (row) => {
        // aktuell leer → bewusst so gelassen
      }
    });
  }

  updateAnalyticsPreferences(chartKey, patch) {
    this.analyticsPreferences = mergeAnalyticsPreferences(
      this.analyticsPreferences,
      chartKey,
      patch
    );
    this.pendingPreferenceState = this.analyticsPreferences;

    clearTimeout(this.preferenceSaveTimer);
    this.preferenceSaveTimer = setTimeout(() => {
      this.persistAnalyticsPreferences();
    }, VIEW_PREFERENCE_SAVE_DELAY_MS);
  }

  persistAnalyticsPreferences() {
    const state = this.pendingPreferenceState;
    if (!state || !this.viewPreferencesAvailable) {
      return;
    }

    this.pendingPreferenceState = null;
    clearTimeout(this.preferenceSaveTimer);
    this.preferenceSaveTimer = null;
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
  }

  onResize() {
    this.chartView.resize();
    this.mapView.resize();
    this.cpChartView?.resize();
    this.ftpChartView?.resize();
    this.ctlChartView?.resize();
    this.scheduleDesktopLayoutMeasure();
  }

  initLayoutObservers() {
    if (typeof ResizeObserver !== "function") {
      return;
    }

    const observerTargets = [
      document.querySelector(".app-topbar"),
      this.heroElement,
      this.chartGridElement,
      this.focusGridElement
    ].filter(Boolean);

    if (!observerTargets.length) {
      return;
    }

    this.layoutObserver = new ResizeObserver(() => {
      this.scheduleDesktopLayoutMeasure(true);
    });

    observerTargets.forEach((target) => this.layoutObserver.observe(target));
  }

  scheduleDesktopLayoutMeasure(withRenderRefresh = false) {
    if (!this.shellElement || !this.focusGridElement) {
      return;
    }

    if (this.layoutMeasureRaf != null) {
      cancelAnimationFrame(this.layoutMeasureRaf);
    }

    this.layoutMeasureRaf = requestAnimationFrame(() => {
      this.layoutMeasureRaf = null;
      this.updateDesktopLayoutMeasure(withRenderRefresh);
    });
  }

  updateDesktopLayoutMeasure(withRenderRefresh = false) {
    const shell = this.shellElement;
    const focusGrid = this.focusGridElement;

    if (!shell || !focusGrid) {
      return;
    }

    const isDesktopLike = window.matchMedia("(min-width: 1200px)").matches;
    const rect = focusGrid.getBoundingClientRect();
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const availableHeight = Math.floor(viewportHeight - rect.top - 24);
    const canUseClientLayout = isDesktopLike && availableHeight >= 420;

    shell.classList.toggle("analytics-shell--client", canUseClientLayout);

    if (!canUseClientLayout) {
      shell.style.removeProperty("--analytics-focus-height");
      if (withRenderRefresh) {
        this.chartView.resize();
        this.mapView.resize();
      }
      return;
    }

    shell.style.setProperty("--analytics-focus-height", `${availableHeight}px`);

    if (withRenderRefresh) {
      requestAnimationFrame(() => {
        this.chartView.resize();
        this.mapView.resize();
      });
    }
  }
}
