import MapView from "./map-view.js";
import ChartView from "./chart-view.js";
import WorkoutService from "./workout-service.js";
import UIStateManager from "./UIStateManager.js";
import WorkoutLibraryView from "./workout-library-view.js";

export default class Controller {

  constructor() {
    this.uiState = new UIStateManager("dashboardNewController");
    this.currentWorkoutId = this.uiState.get("selectedWorkoutId");
    this.libraryState = this.uiState.get("workoutLibraryState", {
      search: "",
      sort: "newest"
    });
    this.toastElement = document.getElementById("dashboard-toast");
    this.toastBodyElement = document.getElementById("dashboard-toast-body");
    this.toast = this.toastElement && globalThis.bootstrap
      ? new globalThis.bootstrap.Toast(this.toastElement, {
          delay: 2800
        })
      : null;
    this.initViews();
    this.registerEvents();
    this.boot();
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

      onToast: (message) => {
        this.showToast(message);
      }
    });

    this.libraryView = new WorkoutLibraryView("#workout-library", {
      headerElementId: "files_header",
      searchInputId: "workout-library-search",
      sortSelectId: "workout-library-sort",
      initialSearch: this.libraryState?.search || "",
      initialSort: this.libraryState?.sort || "newest",
      onWorkoutOpen: async (workoutId) => {
        this.currentWorkoutId = workoutId;
        this.uiState.set("selectedWorkoutId", workoutId);
        await this.openWorkout(workoutId);
      },
      onStateChange: (state) => {
        this.libraryState = state;
        this.uiState.set("workoutLibraryState", state);
      },
      onWorkoutDelete: async (workout) => {
        await WorkoutService.deleteWorkoutByRow({
          getData: () => workout,
          delete: async () => {}
        });

        if (String(workout.id) === String(this.currentWorkoutId)) {
          this.currentWorkoutId = null;
          this.uiState.remove("selectedWorkoutId");
        }

        this.libraryView.removeWorkout(workout.id);
      }
    });
  }

  // -----------------------------
  // GLOBAL EVENTS
  // -----------------------------
  registerEvents() {
    window.addEventListener("resize", () => this.onResize());
  }

  async boot() {
    try {
      await this.libraryView.initialize();
      await this.restoreSelectedWorkout();
    } catch (err) {
      console.error(err);
      this.showToast("Workout-Library konnte nicht geladen werden.");
    }
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
        this.libraryView.setSelectedWorkout(null);
        return;
      }

      this.currentWorkoutId = workout.id;
      this.uiState.set("selectedWorkoutId", workout.id);
      this.chartView.updateWorkout(workout);
      this.mapView.renderTrack(workout);
      this.libraryView.setSelectedWorkout(workout.id);
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
