import MapView from "./map-view.js";
import CPChartView from "./cp-chart-view.js";
import FTPChartView from "./ftp-chart-view.js";
import CTLChartView from "./ctl-chart-view.js";
import ChartView from "./chart-view.js";
import WorkoutService from "./workout-service.js";

export default class Controller {

  constructor() {
    this.shellElement = document.getElementById("analytics-shell");
    this.heroElement = document.getElementById("analytics-hero");
    this.chartGridElement = document.getElementById("analytics-chart-grid");
    this.focusGridElement = document.getElementById("analytics-focus-grid");
    this.layoutMeasureRaf = null;
    this.layoutObserver = null;
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

    this.cpChartView = new CPChartView('cp-chart', {
      onCPClick: async (row) => {
        const workout = await WorkoutService.loadWorkoutByRow(row.fileId);

        this.chartView.updateWorkoutCP(workout, row);
        this.mapView.renderTrack(workout);
      }
    });

    this.ftpChartView = new FTPChartView('ftp-chart', {
      onCPClick: async (row) => {
        // aktuell leer → bewusst so gelassen
      }
    });

    this.ctlChartView = new CTLChartView('ctl-chart', {
      onCPClick: async (row) => {
        // aktuell leer → bewusst so gelassen
      }
    });
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
    this.cpChartView.resize();
    this.ftpChartView.resize();
    this.ctlChartView.resize();
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
