import MapView from "./map-view.js";
import ChartView from "./chart-view.js";
import TableView from "./table-view.js";
import WorkoutService from "./workout-service.js";
import UIStateManager from "./UIStateManager.js";

export default class Controller {

  constructor() {
    this.uiState = new UIStateManager("dashboardController");
    this.currentWorkoutId = this.uiState.get("selectedWorkoutId");
    this.toastElement = document.getElementById("dashboard-toast");
    this.toastBodyElement = document.getElementById("dashboard-toast-body");
    this.toast = this.toastElement && globalThis.bootstrap
      ? new globalThis.bootstrap.Toast(this.toastElement, {
          delay: 2800
        })
      : null;
    this.initViews();
    this.registerEvents();
    this.restoreSelectedWorkout();
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
      },

      onGpsSegmentCreated: (gpsSegment) => {
        if (!gpsSegment || !this.chartView.currentWorkout) {
          return;
        }

        const workout = this.chartView.currentWorkout;
        workout.segments ??= [];

        const normalizedSegment = {
          rowstate: "DB",
          isGPSSegment: true,
          ...gpsSegment
        };

        const existingIndex = workout.segments.findIndex(
          (segment) => String(segment.id) === String(normalizedSegment.id)
        );

        if (existingIndex >= 0) {
          workout.segments[existingIndex] = normalizedSegment;
        } else {
          workout.segments.push(normalizedSegment);
        }

        this.chartView.updateWorkout(workout);
        this.mapView.renderTrack(workout);
      },

      onToast: (message) => {
        this.showToast(message);
      }
    });

    this.tableView = new TableView("#file-table", {

      onRowOpen: async (e, row) => {
        if (e.target.closest("button")) return;

        const workoutId = row.getData().id;
        this.currentWorkoutId = workoutId;
        this.uiState.set("selectedWorkoutId", workoutId);
        await this.openWorkout(workoutId);
      },

      onRowDelete: async (row) => {
        const deletedWorkoutId = row.getData()?.id;
        await WorkoutService.deleteWorkoutByRow(row);

        if (String(deletedWorkoutId) === String(this.currentWorkoutId)) {
          this.currentWorkoutId = null;
          this.uiState.remove("selectedWorkoutId");
        }
      },

      onDataLoaded: () => {
        if (this.currentWorkoutId) {
          this.tableView.highlightRowByWorkoutId(this.currentWorkoutId);
        }
      }

    });
  }

  // -----------------------------
  // GLOBAL EVENTS
  // -----------------------------
  registerEvents() {
    window.addEventListener("resize", () => this.onResize());
  }

  async openWorkout(workoutId) {
    if (!workoutId) {
      return;
    }

    this.chartView.showLoading();

    try {
      const workout = await WorkoutService.loadWorkoutByRow(workoutId);
      if (!workout) {
        this.uiState.remove("selectedWorkoutId");
        this.currentWorkoutId = null;
        return;
      }

      this.currentWorkoutId = workout.id;
      this.uiState.set("selectedWorkoutId", workout.id);
      this.chartView.updateWorkout(workout);
      this.mapView.renderTrack(workout);
      this.tableView.highlightRowByWorkoutId(workout.id);
    } catch (err) {
      console.error(err);
    } finally {
      this.chartView.hideLoading();
    }
  }

  async restoreSelectedWorkout() {
    if (!this.currentWorkoutId) {
      return;
    }

    await this.openWorkout(this.currentWorkoutId);
  }

  showToast(message) {
    if (!this.toast || !this.toastBodyElement) {
      return;
    }

    this.toastBodyElement.innerHTML = message;
    this.toast.show();
  }

  onResize() {
    this.chartView.resize();
  }
}
