import MapView from "./map-view.js";
import CPChartView from "./cp-chart-view.js";
import FTPChartView from "./ftp-chart-view.js";
import CTLChartView from "./ctl-chart-view.js";
import ChartView from "./chart-view.js";
import WorkoutService from "./workout-service.js";

export default class Controller {

  constructor() {
    this.initViews();
    this.registerGlobalEvents();
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

        this.chartView.updateWorkoutCP(workout, row.fileId);
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
    this.cpChartView.resize();
    this.ftpChartView.resize();
    this.ctlChartView.resize();
  }
}