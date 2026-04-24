import MapView from "./map-view.js";
import ChartView from "./chart-view.js";
import WorkoutService from "./workout-service.js";
import UIStateManager from "./UIStateManager.js";
import WorkoutLibraryView from "./workout-library-view.js";

export default class Controller {

  constructor() {
    this.uiState = new UIStateManager("dashboardNewController");
    this.currentWorkoutId = this.readInitialWorkoutId() || this.uiState.get("selectedWorkoutId");
    this.libraryState = this.uiState.get("workoutLibraryState", {
      search: "",
      sort: "newest",
      scope: "mine"
    });
    this.detailCopyElement = document.getElementById("dashboard-detail-copy");
    this.sharedMetaElement = document.getElementById("dashboard-shared-meta");
    this.sharedMetaTextElement = document.getElementById("dashboard-shared-meta-text");
    this.toastElement = document.getElementById("dashboard-toast");
    this.toastBodyElement = document.getElementById("dashboard-toast-body");
    this.toast = this.toastElement && globalThis.bootstrap
      ? new globalThis.bootstrap.Toast(this.toastElement, {
          delay: 2800
        })
      : null;
    this.shareableGroups = [];
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

    this.libraryView = new WorkoutLibraryView("#workout-library", {
      headerElementId: "files_header",
      searchInputId: "workout-library-search",
      sortSelectId: "workout-library-sort",
      initialSearch: this.libraryState?.search || "",
      initialSort: this.libraryState?.sort || "newest",
      initialScope: this.libraryState?.scope || "mine",
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
      },
      onWorkoutShareOpen: async (workout) => {
        return await WorkoutService.getWorkoutSharing(workout.id);
      },
      onWorkoutShareSave: async (workout, payload) => {
        const data = await WorkoutService.updateWorkoutSharing(workout.id, payload);
        this.showToast("Workout-Freigabe aktualisiert.");
        return data;
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
      await this.loadShareableGroups();
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
      this.updateWorkoutMeta(workout);
    } catch (err) {
      console.error(err);
      this.showToast("Workout konnte nicht geladen werden oder ist nicht freigegeben.");
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

  updateWorkoutMeta(workout) {
    if (!this.sharedMetaElement || !this.sharedMetaTextElement || !this.detailCopyElement) {
      return;
    }

    const access = workout?.access || null;
    const ownerLabel = access?.ownerDisplayName || access?.ownerEmail || "anderem User";

    if (access?.isOwner) {
      this.sharedMetaElement.classList.add("d-none");
      this.sharedMetaTextElement.textContent = "";
      this.detailCopyElement.textContent = "Leistung, Herzfrequenz, Kadenz, Speed und Höhe mit direkter Segment-Interaktion.";
      return;
    }

    this.sharedMetaElement.classList.remove("d-none");
    this.sharedMetaTextElement.textContent = `Geteilt von ${ownerLabel}`;
    this.detailCopyElement.textContent = "Leistung, Herzfrequenz, Kadenz, Speed und Höhe des freigegebenen Workouts mit direkter Segment-Interaktion.";
  }

  readInitialWorkoutId() {
    try {
      const params = new URLSearchParams(window.location.search);
      const workoutId = params.get("workoutId");
      return workoutId ? String(workoutId) : null;
    } catch {
      return null;
    }
  }

  async loadShareableGroups() {
    const response = await fetch("/collaboration/groups", {
      method: "GET",
      credentials: "include"
    });

    if (response.status === 401) {
      window.location.href = "/login";
      return;
    }

    if (!response.ok) {
      throw new Error(`Failed to load groups (${response.status})`);
    }

    const result = await response.json();
    this.shareableGroups = result.data || [];
    this.libraryView.setShareableGroups(this.shareableGroups);
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
