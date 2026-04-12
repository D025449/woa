import MapView from "./segment-map-view.js";
import ChartView from "./segment-chart-view.js";
import TableView from "./segment-table-view.js";
import WorkoutService from "./workout-service.js";
import MapSegment from "../../shared/MapSegment.js";
import UIStateManager from "./UIStateManager.js"

export default class Controller {

  constructor() {
    this.uiState = new UIStateManager("segmentController");
    this.initViews();
    this.registerEvents();
    this.mapSegments = [];

  }

  // -----------------------------
  // INIT
  // -----------------------------
  initViews() {


    this.mapView = new MapView("workout-map", this,
      {
        onSegmentOpen: async (e, segment) => {
          console.log(e, segment);
          await this.tableView.loadSegment(e, segment);
        }
      }

    );

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
        //this.chartView.updateWorkout(workout);
        //this.mapView.renderTrack(workout);
      }
    });

    this.tableView = new TableView("#segment-table", {

      onRowOpen: async (e, row) => {
        if (e.target.closest("button")) return;

        this.chartView.showLoading();

        try {
          const segment = row.getData();
          let workout = await WorkoutService.loadWorkoutByRow(segment.wid);
          this.chartView.updateWorkout(workout, segment);
          //this.mapView.renderTrack(workout);

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