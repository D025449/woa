import MapView from "./map-view.js";
import ChartView from "./chart-view.js";
import WorkoutService from "./workout-service.js";
import UIStateManager from "./UIStateManager.js";
import WorkoutLibraryView from "./workout-library-view.js";
import { createTranslator, getCurrentLocale } from "./i18n.js";
import Utils from "../../shared/Utils.js";

export default class Controller {

  constructor() {
    this.t = createTranslator("dashboardNewPage");
    this.libraryT = createTranslator("dashboardNewPage.library");
    this.locale = getCurrentLocale();
    this.uiState = new UIStateManager("dashboardNewController");
    this.currentWorkoutId = this.readInitialWorkoutId() || this.uiState.get("selectedWorkoutId");
    this.libraryState = this.uiState.get("workoutLibraryState", {
      search: "",
      sort: "newest",
      scope: "mine"
    });
    this.detailCopyElement = document.getElementById("dashboard-detail-copy");
    this.workspacePanelElement = document.getElementById("dashboard-workspace-panel");
    this.workspaceSummaryElement = document.getElementById("dashboard-workspace-summary");
    this.workspaceSummaryTitleElement = document.getElementById("dashboard-workspace-summary-title");
    this.workspaceSummaryMetaElement = document.getElementById("dashboard-workspace-summary-meta");
    this.workspaceSummaryChipsElement = document.getElementById("dashboard-workspace-summary-chips");
    this.sharedMetaElement = document.getElementById("dashboard-shared-meta");
    this.sharedMetaTextElement = document.getElementById("dashboard-shared-meta-text");
    this.toastElement = document.getElementById("dashboard-toast");
    this.toastBodyElement = document.getElementById("dashboard-toast-body");
    this.mobileLibraryToggle = document.getElementById("dashboard-mobile-library-toggle");
    this.mobileLibraryBackdrop = document.getElementById("dashboard-mobile-library-backdrop");
    this.libraryColumn = document.querySelector(".dashboard-library-column");
    this.isMobileLibraryOpen = false;
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
          this.resetWorkspaceSummary();
        }

        this.libraryView.removeWorkout(workout.id);
      },
      onWorkoutShareOpen: async (workout) => {
        return await WorkoutService.getWorkoutSharing(workout.id);
      },
      onWorkoutShareSave: async (workout, payload) => {
        const data = await WorkoutService.updateWorkoutSharing(workout.id, payload);
        this.showToast(this.t("messages.workoutShareUpdated"));
        return data;
      }
    });
  }

  // -----------------------------
  // GLOBAL EVENTS
  // -----------------------------
  registerEvents() {
    window.addEventListener("resize", () => this.onResize());
    this.mobileLibraryToggle?.addEventListener("click", () => this.toggleMobileLibrary());
    this.mobileLibraryBackdrop?.addEventListener("click", () => this.closeMobileLibrary());
  }

  async boot() {
    try {
      await this.loadShareableGroups();
      await this.libraryView.initialize();
      this.resetWorkspaceSummary();
      await this.restoreSelectedWorkout();
    } catch (err) {
      console.error(err);
      this.showToast(this.t("messages.workoutLibraryLoadFailed"));
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
        this.resetWorkspaceSummary();
        return;
      }

      this.currentWorkoutId = workout.id;
      this.uiState.set("selectedWorkoutId", workout.id);
      this.chartView.updateWorkout(workout);
      this.mapView.renderTrack(workout);
      this.libraryView.setSelectedWorkout(workout.id);
      this.updateWorkoutMeta(workout);
      this.updateWorkspaceSummary(workout);
      this.closeMobileLibrary();
    } catch (err) {
      console.error(err);
      this.resetWorkspaceSummary();
      this.showToast(this.t("messages.workoutOpenFailed"));
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
    const ownerLabel = access?.ownerDisplayName || access?.ownerEmail || this.t("messages.anotherUser");

    if (access?.isOwner) {
      this.sharedMetaElement.classList.add("d-none");
      this.sharedMetaTextElement.textContent = "";
      this.detailCopyElement.textContent = this.t("messages.ownedWorkoutDetailCopy");
      return;
    }

    this.sharedMetaElement.classList.remove("d-none");
    this.sharedMetaTextElement.textContent = this.t("messages.sharedBy", { owner: ownerLabel });
    this.detailCopyElement.textContent = this.t("messages.sharedWorkoutDetailCopy");
  }

  resetWorkspaceSummary() {
    if (!this.workspaceSummaryElement || !this.workspaceSummaryTitleElement || !this.workspaceSummaryMetaElement || !this.workspaceSummaryChipsElement) {
      return;
    }

    this.workspaceSummaryElement.classList.add("is-idle");
    this.workspacePanelElement?.classList.remove("is-active");
    this.workspaceSummaryTitleElement.textContent = this.t("workoutDataTitle");
    this.workspaceSummaryMetaElement.textContent = this.t("messages.ownedWorkoutDetailCopy");
    this.workspaceSummaryChipsElement.innerHTML = "";
  }

  updateWorkspaceSummary(workout) {
    if (!this.workspaceSummaryElement || !this.workspaceSummaryTitleElement || !this.workspaceSummaryMetaElement || !this.workspaceSummaryChipsElement) {
      return;
    }

    const startedAt = workout?.start_time ? new Date(workout.start_time) : null;
    const dateLabel = startedAt
      ? startedAt.toLocaleDateString(this.locale, { day: "2-digit", month: "short", year: "numeric" })
      : this.libraryT("na");
    const timeLabel = startedAt
      ? startedAt.toLocaleTimeString(this.locale, { hour: "2-digit", minute: "2-digit" })
      : "";

    const chips = [
      `${this.libraryT("duration")}: ${this.formatDuration(workout?.total_timer_time)}`,
      `${this.libraryT("distance")}: ${this.formatDistance(workout?.total_distance)}`,
      `${this.libraryT("avgPower")}: ${this.formatPower(workout?.avg_power)}`
    ];

    if (!workout?.is_owned) {
      chips.push(this.t("sharedWorkoutEyebrow"));
    }

    this.workspaceSummaryElement.classList.remove("is-idle");
    this.workspacePanelElement?.classList.add("is-active");
    this.workspaceSummaryTitleElement.textContent = this.libraryT("workoutLabel", { id: workout?.id });
    this.workspaceSummaryMetaElement.textContent = [dateLabel, timeLabel].filter(Boolean).join(" · ");
    this.workspaceSummaryChipsElement.innerHTML = chips
      .map((chip) => `<span class="dashboard-workspace-summary__chip">${chip}</span>`)
      .join("");
  }

  formatDuration(value) {
    return Number.isFinite(value) ? Utils.formatDuration(Number(value)) : this.libraryT("na");
  }

  formatDistance(value) {
    return Number.isFinite(value) ? `${(Number(value) / 1000).toFixed(1)} km` : this.libraryT("na");
  }

  formatPower(value) {
    return Number.isFinite(value) ? `${Math.round(Number(value))} W` : this.libraryT("na");
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
      throw new Error(this.t("messages.failedLoadGroups", { status: response.status }));
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
    if (!window.matchMedia("(max-width: 991.98px)").matches) {
      this.closeMobileLibrary();
    }
  }

  toggleMobileLibrary() {
    if (this.isMobileLibraryOpen) {
      this.closeMobileLibrary();
      return;
    }
    this.openMobileLibrary();
  }

  openMobileLibrary() {
    if (!this.libraryColumn || !window.matchMedia("(max-width: 991.98px)").matches) {
      return;
    }

    this.isMobileLibraryOpen = true;
    this.libraryColumn.classList.add("is-open");
    this.mobileLibraryBackdrop?.classList.add("is-open");
    if (this.mobileLibraryToggle) {
      this.mobileLibraryToggle.setAttribute("aria-expanded", "true");
      this.mobileLibraryToggle.textContent = this.t("mobileLibraryClose");
    }
    document.body.classList.add("overflow-hidden");
  }

  closeMobileLibrary() {
    this.isMobileLibraryOpen = false;
    this.libraryColumn?.classList.remove("is-open");
    this.mobileLibraryBackdrop?.classList.remove("is-open");
    if (this.mobileLibraryToggle) {
      this.mobileLibraryToggle.setAttribute("aria-expanded", "false");
      this.mobileLibraryToggle.textContent = this.t("mobileLibraryOpen");
    }
    document.body.classList.remove("overflow-hidden");
  }
}
