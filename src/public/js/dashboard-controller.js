import MapView from "./map-view.js";
import ChartView from "./chart-view.js";
import TableView from "./table-view.js";
import WorkoutService from "./workout-service.js";

export default class Controller {

  constructor() {
    this.initViews();
    this.registerEvents();
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
        this.mapView.highlightSegment({ start, end });
      },

      createMarkArea: (start, end) => {
        // bewusst unverändert gelassen
      },

      onUpdateWorkout: (workout) => {
        this.chartView.updateWorkout(workout);
        this.mapView.renderTrack(workout);
      }
    });

    this.tableView = new TableView("#file-table", {

      onRowOpen: async (e, row) => {
        if (e.target.closest("button")) return;

        this.chartView.showLoading();

        try {
          let workout = await WorkoutService.loadWorkoutByRow(row.getData().id);

          const d = row.getData();
          workout.validgps = d.validgps;
          workout.startDate = d.start_time;

          this.chartView.updateWorkout(workout);
          this.mapView.renderTrack(workout);

        } catch (err) {
          console.error(err);

        } finally {
          this.chartView.hideLoading();
        }
      },

      onRowDelete: async (row) => {
        await WorkoutService.deleteWorkoutByRow(row);
      }

    });
  }

  // -----------------------------
  // GLOBAL EVENTS
  // -----------------------------
  registerEvents() {
    window.addEventListener("resize", () => this.onResize());
  }

  onResize() {
    this.chartView.resize();
  }
}