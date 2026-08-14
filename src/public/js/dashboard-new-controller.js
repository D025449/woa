import MapView from "./map-view.js";
import ChartView from "./chart-view.js";
import FlyoverView from "./flyover-view.js";
import WorkoutService from "./workout-service.js";
import UIStateManager from "./UIStateManager.js";
import WorkoutLibraryView from "./workout-library-view.js";
import ViewPreferenceService from "./view-preference-service.js";
import { createTranslator, getCurrentLocale } from "./i18n.js";
import Utils from "../../shared/Utils.js";
import {
  WORKOUT_ROUTE_THUMBNAIL_STYLE_VERSION,
  getSegmentColor,
  getSegmentVisibilityKey
} from "../../shared/SegmentAppearance.js";
import confirmModal from "./confirm-modal.js";
import { intensityProfilesFromTags } from "../../shared/WorkoutIntensityTags.js";
import { parseManualActivityFile } from "./manual-activity-exchange-client.js";

const WORKOUT_LIBRARY_VIEW_KEY = "workout-library";
const VIEW_PREFERENCE_SAVE_DELAY_MS = 500;

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
      scope: "mine",
      favoritesOnly: false,
      activityType: "all",
      workoutType: "all",
      terrainProfile: "all",
      intensityProfile: "all",
      gpsFilter: "all"
    });
    this.chartViewState = this.uiState.get("chartViewState", {
      xAxisMode: "time",
      smoothingLevel: "automatic",
      bridgePowerCadenceZeros: false,
      seriesVisibility: {
        power: true,
        heartRate: true,
        cadence: true,
        speed: true,
        altitude: true,
        leftRightBalance: true
      },
      segmentVisibility: {
        criticalPower: true,
        auto: true,
        manual: true,
        gps: true
      }
    });
    this.libraryScrollTop = this.uiState.get("workoutLibraryScrollTop", 0);
    this.mapViewState = this.uiState.get("dashboardMapViewState", {
      baseLayerMode: "standard"
    });
    this.maptilerApiKey = String(globalThis.__APP_CONFIG?.maptilerApiKey || "").trim();
    this.favoriteWorkoutIds = [];
    this.viewPreferencesAvailable = false;
    this.pendingWorkoutLibraryPreferenceState = null;
    this.viewPreferenceSaveTimer = null;
    this.viewPreferenceSaveChain = Promise.resolve();
    this.detailCopyElement = document.getElementById("dashboard-detail-copy");
    this.workoutTitleElement = document.getElementById("dashboard-workout-title");
    this.intensitySummaryElement = document.getElementById("dashboard-intensity-summary");
    this.intensityBadgesElement = document.getElementById("dashboard-intensity-badges");
    this.intensityContextElement = document.getElementById("dashboard-intensity-context");
    this.heroStatusElement = document.getElementById("dashboard-hero-status");
    this.addTrainingButton = document.getElementById("dashboard-add-training");
    this.addTrainingModalElement = document.getElementById("dashboard-add-training-modal");
    this.addManualTrainingButton = document.getElementById("dashboard-add-manual-training");
    this.importManualTrainingButton = document.getElementById("dashboard-import-manual-training");
    this.manualTrainingModalElement = document.getElementById("dashboard-manual-training-modal");
    this.manualTrainingForm = document.getElementById("dashboard-manual-training-form");
    this.manualTrainingTypeSelect = document.getElementById("dashboard-manual-training-type");
    this.manualWorkoutTypeField = document.getElementById("dashboard-manual-workout-type-field");
    this.manualStrengthFocusField = document.getElementById("dashboard-manual-strength-focus-field");
    this.manualBaselinePowerField = document.getElementById("dashboard-manual-baseline-power-field");
    this.manualBaselinePowerMode = document.getElementById("dashboard-manual-baseline-power-mode");
    this.manualTssField = document.getElementById("dashboard-manual-tss-field");
    this.manualIntervalSection = document.getElementById("dashboard-manual-interval-section");
    this.manualIntervalList = document.getElementById("dashboard-manual-interval-list");
    this.manualIntervalAddButton = document.getElementById("dashboard-manual-interval-add");
    this.manualTrainingErrorElement = document.getElementById("dashboard-manual-training-error");
    this.manualTrainingTitleElement = document.getElementById("dashboard-manual-training-title");
    this.manualTrainingSubmitButton = document.getElementById("dashboard-manual-training-submit");
    this.manualTrainingBackButton = document.getElementById("dashboard-manual-training-back");
    this.editingManualActivityId = null;
    this.manualCopyModalElement = document.getElementById("dashboard-manual-copy-modal");
    this.manualCopySourceElement = document.getElementById("dashboard-manual-copy-source");
    this.manualCopyErrorElement = document.getElementById("dashboard-manual-copy-error");
    this.manualCopyMonthElement = document.getElementById("dashboard-manual-copy-month");
    this.manualCopyWeekdaysElement = document.getElementById("dashboard-manual-copy-weekdays");
    this.manualCopyDaysElement = document.getElementById("dashboard-manual-copy-days");
    this.manualCopySelectedElement = document.getElementById("dashboard-manual-copy-selected");
    this.manualCopyEmptyElement = document.getElementById("dashboard-manual-copy-empty");
    this.manualCopyCountElement = document.getElementById("dashboard-manual-copy-count");
    this.manualCopyPreviousButton = document.getElementById("dashboard-manual-copy-prev");
    this.manualCopyNextButton = document.getElementById("dashboard-manual-copy-next");
    this.manualCopySubmitButton = document.getElementById("dashboard-manual-copy-submit");
    this.manualCopyActivity = null;
    this.manualCopySelectedDates = new Set();
    this.manualCopyVisibleMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    this.exportAllFitButton = document.getElementById("dashboard-export-all-fit");
    this.exportAllManualButton = document.getElementById("dashboard-export-all-manual");
    this.manualImportModalElement = document.getElementById("dashboard-manual-import-modal");
    this.manualImportFileInput = document.getElementById("dashboard-manual-import-file");
    this.manualImportErrorElement = document.getElementById("dashboard-manual-import-error");
    this.manualImportPreviewElement = document.getElementById("dashboard-manual-import-preview");
    this.manualImportOverwriteInput = document.getElementById("dashboard-manual-import-overwrite");
    this.manualImportBackButton = document.getElementById("dashboard-manual-import-back");
    this.manualImportSubmitButton = document.getElementById("dashboard-manual-import-submit");
    this.pendingManualImportActivities = [];
    this.workspacePanelElement = document.getElementById("dashboard-workspace-panel");
    this.detailMainStackElement = document.getElementById("dashboard-detail-main-stack");
    this.similarWorkoutsPanelElement = document.getElementById("dashboard-similar-workouts-panel");
    this.similarWorkoutsListElement = document.getElementById("dashboard-similar-workouts-list");
    this.similarWorkoutsCopyElement = document.getElementById("dashboard-similar-workouts-copy");
    this.workoutSegmentsListElement = document.getElementById("dashboard-workout-segments-list");
    this.workoutSegmentsCopyElement = document.getElementById("dashboard-workout-segments-copy");
    this.focusedWorkoutSegmentKey = null;
    this.hoveredWorkoutSegmentKey = null;
    this.sharedMetaElement = document.getElementById("dashboard-shared-meta");
    this.sharedMetaTextElement = document.getElementById("dashboard-shared-meta-text");
    this.toastElement = document.getElementById("dashboard-toast");
    this.toastBodyElement = document.getElementById("dashboard-toast-body");
    this.gpsCopyModalElement = document.getElementById("dashboard-gps-copy-modal");
    this.gpsCopyStatusElement = document.getElementById("dashboard-gps-copy-status");
    this.gpsCopyCandidatesElement = document.getElementById("dashboard-gps-copy-candidates");
    this.mobileLibraryToggle = document.getElementById("dashboard-mobile-library-toggle");
    this.mobileLibraryCloseButton = document.getElementById("dashboard-mobile-library-close");
    this.mobileLibraryBackdrop = document.getElementById("dashboard-mobile-library-backdrop");
    this.map3dToggleButton = document.getElementById("dashboard-map-3d-toggle");
    this.libraryColumn = document.querySelector(".dashboard-library-column");
    this.libraryScrollElement = document.querySelector(".workout-library-scroll");
    this.quickAccessElement = document.getElementById("dashboard-quick-access");
    this.favoriteWorkoutsElement = document.getElementById("dashboard-favorite-workouts");
    this.splitterElement = document.getElementById("dashboard-splitter");
    this.shellElement = document.getElementById("dashboard-shell");
    this.heroElement = document.getElementById("dashboard-hero");
    this.masterDetailElement = document.getElementById("dashboard-master-detail");
    this.detailGridElement = document.getElementById("dashboard-detail-grid");
    this.prevWorkoutButton = document.getElementById("dashboard-workout-prev");
    this.nextWorkoutButton = document.getElementById("dashboard-workout-next");
    this.deviceInfoElement = document.getElementById("dashboard-device-info");
    this.deviceInfoCloseButton = document.getElementById("dashboard-device-info-close");
    this.deviceInfoRecorderElement = document.getElementById("dashboard-device-info-recorder");
    this.deviceInfoSoftwareElement = document.getElementById("dashboard-device-info-software");
    this.deviceInfoCreatedElement = document.getElementById("dashboard-device-info-created");
    this.deviceInfoActivityElement = document.getElementById("dashboard-device-info-activity");
    this.deviceInfoSensorsElement = document.getElementById("dashboard-device-info-sensors");
    this.deviceInfoTechnicalElement = document.getElementById("dashboard-device-info-technical");
    this.detailSplitterTopElement = document.getElementById("dashboard-detail-splitter-1");
    this.isMobileLibraryOpen = false;
    this.libraryWidthPx = this.uiState.get("dashboardLibraryWidthPx", null);
    this.detailSectionHeights = this.uiState.get("dashboardDetailSectionHeights", null);
    this.splitterPointerId = null;
    this.detailSplitterPointerId = null;
    this.layoutMeasureRaf = null;
    this.layoutObserver = null;
    this.similarWorkoutsRequestToken = 0;
    this.toast = this.toastElement && globalThis.bootstrap
      ? new globalThis.bootstrap.Toast(this.toastElement, {
          delay: 2800
        })
      : null;
    this.gpsCopyModal = this.gpsCopyModalElement && globalThis.bootstrap
      ? globalThis.bootstrap.Modal.getOrCreateInstance(this.gpsCopyModalElement)
      : null;
    this.addTrainingModal = this.addTrainingModalElement && globalThis.bootstrap
      ? globalThis.bootstrap.Modal.getOrCreateInstance(this.addTrainingModalElement)
      : null;
    this.manualTrainingModal = this.manualTrainingModalElement && globalThis.bootstrap
      ? globalThis.bootstrap.Modal.getOrCreateInstance(this.manualTrainingModalElement)
      : null;
    this.manualCopyModal = this.manualCopyModalElement && globalThis.bootstrap
      ? globalThis.bootstrap.Modal.getOrCreateInstance(this.manualCopyModalElement)
      : null;
    this.manualImportModal = this.manualImportModalElement && globalThis.bootstrap
      ? globalThis.bootstrap.Modal.getOrCreateInstance(this.manualImportModalElement)
      : null;
    this.shareableGroups = [];
    this.initViews();
    this.didRestoreMapViewState = false;
    this.registerEvents();
    this.boot();
  }

  // -----------------------------
  // INIT
  // -----------------------------
  initViews() {
    this.mapView = new MapView("workout-map", {
      initialSegmentVisibility: this.chartViewState?.segmentVisibility,
      onManualGpsSave: async (points) => {
        const workoutId = this.currentWorkoutId;
        if (!workoutId) {
          return;
        }

        const result = await WorkoutService.saveManualGps(workoutId, points);
        this.libraryView.updateWorkoutFields(workoutId, {
          validgps: true,
          validGps: true,
          gps_source: result?.gpsSource || "manual_lookup",
          gpsSource: result?.gpsSource || "manual_lookup",
          total_ascent: result?.totalAscent ?? null,
          total_descent: result?.totalDescent ?? null,
          has_thumbnail: !!result?.hasThumbnail,
          thumbnail_updated_at: result?.thumbnailUpdatedAt || new Date().toISOString()
        });
        await this.openWorkout(workoutId);
        this.showToast(this.t("messages.manualGpsSaved"));
      },
      onGpxImport: async (file, mode) => {
        const workoutId = this.currentWorkoutId;
        if (!workoutId) {
          return;
        }

        const result = await WorkoutService.importManualGpsGpx(workoutId, file, mode);
        this.libraryView.updateWorkoutFields(workoutId, {
          validgps: true,
          validGps: true,
          gps_source: result?.gpsSource || "manual_lookup",
          gpsSource: result?.gpsSource || "manual_lookup",
          total_ascent: result?.totalAscent ?? null,
          total_descent: result?.totalDescent ?? null,
          has_thumbnail: !!result?.hasThumbnail,
          thumbnail_updated_at: result?.thumbnailUpdatedAt || new Date().toISOString()
        });
        await this.openWorkout(workoutId);
        this.showToast(this.t("messages.gpxImported"));
      },
      onCopyGpsSelectionOpen: async () => {
        await this.openGpsCopyModal();
      },
      onSegmentHoverChange: (segment) => {
        if (segment) {
          this.chartView?.hoverSegment(segment);
        } else {
          this.chartView?.clearSegmentHover();
        }
        this.setHoveredWorkoutSegment(segment);
      },
      onSegmentSelectionChange: (segment) => {
        const workout = this.chartView?.currentWorkout;
        if (!workout) {
          return;
        }

        this.setHoveredWorkoutSegment(null);
        if (segment) {
          this.focusedWorkoutSegmentKey = this.getWorkoutSegmentKey(segment);
          this.chartView.focusSegment(segment);
        } else {
          this.focusedWorkoutSegmentKey = null;
          this.chartView.clearSegmentFocus({ resetZoom: true });
        }
        this.renderWorkoutSegments(workout);
      }
    });
    this.mapView.onBaseLayerChange = (baseLayerMode) => {
      this.mapViewState = {
        ...this.mapViewState,
        baseLayerMode
      };
      this.uiState.set("dashboardMapViewState", this.mapViewState);
      if (this.didRestoreMapViewState) {
        this.showToast(this.t("messages.mapStyleChanged", { style: this.t(`mapStyle${baseLayerMode.charAt(0).toUpperCase()}${baseLayerMode.slice(1)}`) }));
      }
    };
    this.mapView.onViewChange = (viewState) => {
      this.mapViewState = {
        ...this.mapViewState,
        ...viewState
      };
      this.uiState.set("dashboardMapViewState", this.mapViewState);
    };
    this.mapView.setInitialState(this.mapViewState);
    this.didRestoreMapViewState = true;

    this.chartView = new ChartView("workout-chart", {
      initialState: this.chartViewState,
      onChartHoverIndex: (idx) => {
        this.mapView.moveMarkerToIndex(idx);
      },

      onSegmentHoverChange: (segment) => {
        this.setHoveredWorkoutSegment(segment);
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
        if (this.focusedWorkoutSegmentKey) {
          const focusedSegment = workout?.segments?.find(
            (segment) => this.getWorkoutSegmentKey(segment) === this.focusedWorkoutSegmentKey
          );
          if (focusedSegment) {
            this.mapView.focusSegmentOverlay(focusedSegment);
          }
        }
        this.flyoverView?.setWorkout(workout);
        this.renderWorkoutSegments(workout);
        this.update3dMapButton();
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
        this.renderWorkoutSegments(workout);
      },

      onSegmentFocusRequested: (segment) => {
        const workout = this.chartView.currentWorkout;
        if (!workout || !segment) {
          return;
        }

        this.focusedWorkoutSegmentKey = this.getWorkoutSegmentKey(segment);
        this.mapView.focusSegmentOverlay(segment);
        this.renderWorkoutSegments(workout);
      },

      onToast: (message) => {
        this.showToast(message);
      },

      onPreferencesChange: (state) => {
        this.chartViewState = state;
        this.uiState.set("chartViewState", state);
        this.mapView.setSegmentVisibility(state.segmentVisibility);
        const workout = this.chartView.currentWorkout;
        if (this.focusedWorkoutSegmentKey && workout) {
          const focusedSegment = workout.segments?.find(
            (segment) => this.getWorkoutSegmentKey(segment) === this.focusedWorkoutSegmentKey
          );
          if (!focusedSegment || !this.chartView.isSegmentTypeVisible(focusedSegment)) {
            this.focusedWorkoutSegmentKey = null;
            this.chartView.clearSegmentFocus();
          }
        }
        this.renderWorkoutSegments(workout);
        this.scheduleWorkoutLibraryPreferenceSave(this.libraryState);
      }
    });

    this.flyoverView = new FlyoverView({
      modalElementId: "dashboard-3d-modal",
      mapElementId: "dashboard-3d-map",
      summaryElementId: "dashboard-3d-summary",
      playToggleButtonId: "dashboard-3d-play-toggle",
      presetSelectId: "dashboard-3d-preset",
      presetStorageKey: "dashboardFlyoverCameraPreset",
      apiKey: this.maptilerApiKey,
      t: (key) => this.t(key)
    });

    this.libraryView = new WorkoutLibraryView("#workout-library", {
      headerElementId: "dashboard-workout-count",
      searchInputId: "workout-library-search",
      sortSelectId: "workout-library-sort",
      initialSearch: this.libraryState?.search || "",
      initialSort: this.libraryState?.sort || "newest",
      initialScope: this.libraryState?.scope || "mine",
      initialActivityType: this.libraryState?.activityType || "all",
      initialWorkoutType: this.libraryState?.workoutType || "all",
      initialTerrainProfile: this.libraryState?.terrainProfile || "all",
      initialIntensityProfile: this.libraryState?.intensityProfile || "all",
      initialGpsFilter: this.libraryState?.gpsFilter || "all",
      initialFavoriteFilterActive: !!this.libraryState?.favoritesOnly,
      initialFavoriteWorkoutIds: this.favoriteWorkoutIds,
      onWorkoutOpen: async (workoutId) => {
        this.currentWorkoutId = workoutId;
        this.uiState.set("selectedWorkoutId", workoutId);
        await this.openWorkout(workoutId);
      },
      onStateChange: (state) => {
        this.libraryState = state;
        this.uiState.set("workoutLibraryState", state);
        this.scheduleWorkoutLibraryPreferenceSave(state);
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
      onManualActivityEdit: async (activity) => {
        await this.editManualTraining(activity);
      },
      onManualActivityCopy: (activity) => {
        this.openManualTrainingCopy(activity);
      },
      onManualActivityExport: (activity) => {
        this.exportManualActivity(activity);
      },
      onManualActivityDelete: async (activity) => {
        await this.deleteManualTraining(activity);
      },
      onBulkDelete: async (workouts) => {
        await this.deleteSelectedWorkouts(workouts);
      },
      onBulkPublish: async (workouts, payload) => {
        await this.publishSelectedWorkouts(workouts, payload);
      },
      onWorkoutShareOpen: async (workout) => {
        return await WorkoutService.getWorkoutSharing(workout.id);
      },
      onWorkoutShareSave: async (workout, payload) => {
        const data = await WorkoutService.updateWorkoutSharing(workout.id, payload);
        this.showToast(this.t("messages.workoutShareUpdated"));
        return data;
      },
      onFavoriteChange: async ({ workoutId, isFavorite }) => {
        await WorkoutService.setWorkoutFavorite(workoutId, isFavorite);
      },
      onFavoriteIdsChange: (favoriteIds) => {
        this.favoriteWorkoutIds = Array.isArray(favoriteIds) ? favoriteIds : [];
        this.renderQuickAccess();
      },
      onFavoriteToggle: ({ isFavorite }) => {
        this.showToast(isFavorite ? this.t("messages.favoriteAdded") : this.t("messages.favoriteRemoved"));
      },
      onFavoriteError: (err) => {
        this.showToast(err?.message || this.t("messages.workoutLibraryLoadFailed"));
      },
      onRendered: ({ append }) => {
        if (!append) {
          this.restoreLibraryScrollPosition();
        }
        this.renderQuickAccess();
        this.updateDetailNavigation();
      }
    });
  }

  // -----------------------------
  // GLOBAL EVENTS
  // -----------------------------
  registerEvents() {
    window.addEventListener("resize", () => this.onResize());
    this.mobileLibraryToggle?.addEventListener("click", () => this.toggleMobileLibrary());
    this.mobileLibraryCloseButton?.addEventListener("click", () => this.closeMobileLibrary());
    this.mobileLibraryBackdrop?.addEventListener("click", () => this.closeMobileLibrary());
    this.libraryScrollElement?.addEventListener("scroll", () => {
      this.libraryScrollTop = this.libraryScrollElement.scrollTop;
      this.uiState.set("workoutLibraryScrollTop", this.libraryScrollTop);
    }, { passive: true });
    document.addEventListener("keydown", (event) => this.handleGlobalShortcuts(event));
    this.map3dToggleButton?.addEventListener("click", () => this.open3dMap());
    this.addTrainingButton?.addEventListener("click", () => this.addTrainingModal?.show());
    this.addManualTrainingButton?.addEventListener("click", () => this.openManualTrainingForm());
    this.importManualTrainingButton?.addEventListener("click", () => this.openManualActivityImport());
    this.manualTrainingBackButton?.addEventListener("click", () => {
      if (this.editingManualActivityId !== null) {
        this.manualTrainingModal?.hide();
        return;
      }
      this.switchDashboardModal(this.manualTrainingModalElement, this.manualTrainingModal, this.addTrainingModal);
    });
    this.manualTrainingTypeSelect?.addEventListener("change", () => this.syncManualTrainingFields());
    this.manualBaselinePowerMode?.addEventListener("change", () => {
      this.syncManualPowerInput(this.manualBaselinePowerMode);
    });
    this.manualIntervalAddButton?.addEventListener("click", () => this.addManualTrainingInterval());
    this.manualIntervalList?.addEventListener("click", (event) => {
      const removeButton = event.target?.closest?.("[data-manual-interval-remove]");
      if (removeButton) removeButton.closest(".dashboard-manual-interval-row")?.remove();
    });
    this.manualIntervalList?.addEventListener("change", (event) => {
      if (event.target?.matches?.("[data-manual-interval-field='powerMode']")) {
        this.syncManualPowerInput(event.target);
      }
    });
    this.manualTrainingForm?.addEventListener("submit", async (event) => {
      event.preventDefault();
      await this.saveManualTraining();
    });
    this.manualCopyPreviousButton?.addEventListener("click", () => this.moveManualCopyMonth(-1));
    this.manualCopyNextButton?.addEventListener("click", () => this.moveManualCopyMonth(1));
    this.manualCopyDaysElement?.addEventListener("click", (event) => {
      const dayButton = event.target?.closest?.("[data-manual-copy-date]");
      if (dayButton) this.toggleManualCopyDate(dayButton.getAttribute("data-manual-copy-date"));
    });
    this.manualCopySelectedElement?.addEventListener("click", (event) => {
      const removeButton = event.target?.closest?.("[data-manual-copy-remove]");
      if (removeButton) this.toggleManualCopyDate(removeButton.getAttribute("data-manual-copy-remove"));
    });
    this.manualCopySubmitButton?.addEventListener("click", async () => this.copyManualTraining());
    this.exportAllFitButton?.addEventListener("click", () => {
      this.exportAllFitButton.closest("details")?.removeAttribute("open");
      this.exportAllWorkoutsAsFit();
    });
    this.exportAllManualButton?.addEventListener("click", () => {
      this.exportAllManualButton.closest("details")?.removeAttribute("open");
      this.exportAllManualActivities();
    });
    this.manualImportFileInput?.addEventListener("change", async () => {
      await this.inspectManualActivityImport(this.manualImportFileInput.files?.[0]);
    });
    this.manualImportBackButton?.addEventListener("click", () => {
      this.switchDashboardModal(this.manualImportModalElement, this.manualImportModal, this.addTrainingModal);
    });
    this.manualImportSubmitButton?.addEventListener("click", async () => {
      await this.importManualActivities();
    });
    this.registerSplitterEvents();
    this.initLayoutObservers();
    this.prevWorkoutButton?.addEventListener("click", async () => {
      await this.openRelativeWorkout(-1);
    });
    this.nextWorkoutButton?.addEventListener("click", async () => {
      await this.openRelativeWorkout(1);
    });
    this.deviceInfoCloseButton?.addEventListener("click", () => {
      this.deviceInfoElement?.removeAttribute("open");
    });
    document.addEventListener("click", (event) => {
      if (this.deviceInfoElement?.open && !this.deviceInfoElement.contains(event.target)) {
        this.deviceInfoElement.removeAttribute("open");
      }
    });
  }

  switchDashboardModal(fromElement, fromModal, toModal) {
    if (!fromElement || !fromModal || !toModal) return;
    fromElement.addEventListener("hidden.bs.modal", () => toModal.show(), { once: true });
    fromModal.hide();
  }

  openManualTrainingForm(activity = null) {
    if (!this.manualTrainingForm) return;
    this.manualTrainingForm.reset();
    this.editingManualActivityId = activity?.id ?? null;
    const startInput = this.manualTrainingForm.elements.namedItem("startTime");
    const durationInput = this.manualTrainingForm.elements.namedItem("durationMinutes");
    const startTime = activity?.start_time ? new Date(activity.start_time) : new Date();
    startTime.setSeconds(0, 0);
    const localStartTime = new Date(startTime.getTime() - startTime.getTimezoneOffset() * 60_000)
      .toISOString()
      .slice(0, 16);
    if (startInput) startInput.value = localStartTime;
    if (durationInput) {
      durationInput.value = activity
        ? String(Math.max(1, Math.round(Number(activity.total_timer_time || activity.duration_seconds) / 60)))
        : "30";
    }
    const baselinePowerMode = this.manualTrainingForm.elements.namedItem("baselinePowerMode");
    const baselinePowerValue = this.manualTrainingForm.elements.namedItem("baselinePowerValue");
    if (baselinePowerMode) baselinePowerMode.value = activity?.baseline_power_mode || "watts";
    if (baselinePowerValue) baselinePowerValue.value = activity?.baseline_power_value ?? "120";
    this.renderManualTrainingIntervals(activity?.intervals || []);
    if (activity) {
      const fieldValues = {
        activityType: activity.activity_type,
        workoutType: activity.workout_type,
        perceivedExertion: activity.perceived_exertion,
        estimatedTss: activity.tss_source === "manual" || !activity.tss_source
          ? activity.estimated_tss
          : null,
        strengthFocus: activity.strength_focus,
        title: activity.title,
        notes: activity.notes
      };
      Object.entries(fieldValues).forEach(([name, value]) => {
        const field = this.manualTrainingForm.elements.namedItem(name);
        if (field && value !== null && value !== undefined) field.value = String(value);
      });
    }
    if (this.manualTrainingTitleElement) {
      this.manualTrainingTitleElement.textContent = this.t(
        activity ? "manualTrainingEditTitle" : "manualTrainingTitle"
      );
    }
    if (this.manualTrainingSubmitButton) {
      this.manualTrainingSubmitButton.textContent = this.t(
        activity ? "manualTrainingUpdate" : "manualTrainingSave"
      );
    }
    if (this.manualTrainingBackButton) {
      this.manualTrainingBackButton.textContent = this.t(
        activity ? "manualTrainingCancel" : "manualTrainingBack"
      );
    }
    this.hideManualTrainingError();
    this.syncManualTrainingFields();
    if (activity) {
      this.manualTrainingModal?.show();
    } else {
      this.switchDashboardModal(this.addTrainingModalElement, this.addTrainingModal, this.manualTrainingModal);
    }
  }

  syncManualTrainingFields() {
    const activityType = this.manualTrainingTypeSelect?.value || "cycling";
    const isCycling = activityType === "cycling";
    if (this.manualWorkoutTypeField) this.manualWorkoutTypeField.hidden = !isCycling;
    if (this.manualBaselinePowerField) this.manualBaselinePowerField.hidden = !isCycling;
    if (this.manualTssField) this.manualTssField.hidden = !isCycling;
    if (this.manualIntervalSection) this.manualIntervalSection.hidden = !isCycling;
    const baselinePowerValue = this.manualTrainingForm?.elements.namedItem("baselinePowerValue");
    if (baselinePowerValue) baselinePowerValue.required = isCycling;
    if (this.manualStrengthFocusField) this.manualStrengthFocusField.hidden = activityType !== "strength_training";
    this.syncManualPowerInput(this.manualBaselinePowerMode);
  }

  syncManualPowerInput(modeSelect) {
    const container = modeSelect?.closest?.(".input-group, .dashboard-manual-interval-row");
    const valueInputs = container?.querySelectorAll?.(
      modeSelect === this.manualBaselinePowerMode
        ? "input[name='baselinePowerValue']"
        : "[data-manual-interval-power]"
    ) || [];
    const isPercent = modeSelect?.value === "ftp_percent";
    valueInputs.forEach((input) => {
      input.max = isPercent ? "300" : "3000";
      input.step = isPercent ? "0.5" : "1";
    });
  }

  renderManualTrainingIntervals(intervals = []) {
    if (!this.manualIntervalList) return;
    this.manualIntervalList.innerHTML = "";
    intervals.forEach((interval) => this.addManualTrainingInterval({
      repetitions: interval.repetitions,
      workDurationMinutes: Number(interval.work_duration_seconds ?? interval.workDurationSeconds) / 60,
      recoveryDurationMinutes: Number(interval.recovery_duration_seconds ?? interval.recoveryDurationSeconds) / 60,
      powerMode: interval.power_mode ?? interval.powerMode,
      workPowerValue: interval.work_power_value ?? interval.workPowerValue,
      recoveryPowerValue: interval.recovery_power_value ?? interval.recoveryPowerValue
    }));
  }

  addManualTrainingInterval(interval = {}) {
    if (!this.manualIntervalList) return;
    const row = document.createElement("div");
    row.className = "dashboard-manual-interval-row";
    row.innerHTML = `
      <label><span>${this.t("manualTrainingIntervalRepetitions")}</span><input class="form-control" type="number" min="1" max="100" step="1" value="${interval.repetitions ?? 3}" data-manual-interval-field="repetitions" required></label>
      <label><span>${this.t("manualTrainingIntervalWorkDuration")}</span><input class="form-control" type="number" min="0.25" max="60" step="0.25" value="${interval.workDurationMinutes ?? 2}" data-manual-interval-field="workDurationMinutes" required></label>
      <label><span>${this.t("manualTrainingIntervalWorkPower")}</span><input class="form-control" type="number" min="1" max="3000" step="1" value="${interval.workPowerValue ?? 250}" data-manual-interval-field="workPowerValue" data-manual-interval-power required></label>
      <label><span>${this.t("manualTrainingIntervalRecoveryDuration")}</span><input class="form-control" type="number" min="0" max="60" step="0.25" value="${interval.recoveryDurationMinutes ?? 2}" data-manual-interval-field="recoveryDurationMinutes" required></label>
      <label><span>${this.t("manualTrainingIntervalRecoveryPower")}</span><input class="form-control" type="number" min="0" max="3000" step="1" value="${interval.recoveryPowerValue ?? ""}" data-manual-interval-field="recoveryPowerValue" data-manual-interval-power></label>
      <label><span>${this.t("manualTrainingPowerMode")}</span><select class="form-select" data-manual-interval-field="powerMode"><option value="watts">${this.t("manualTrainingWatts")}</option><option value="ftp_percent">${this.t("manualTrainingFtpPercent")}</option></select></label>
      <button class="btn btn-sm btn-outline-danger dashboard-manual-interval-remove" type="button" data-manual-interval-remove aria-label="${this.t("manualTrainingIntervalRemove")}">×</button>
    `;
    const modeSelect = row.querySelector("[data-manual-interval-field='powerMode']");
    modeSelect.value = interval.powerMode || "watts";
    this.manualIntervalList.append(row);
    this.syncManualPowerInput(modeSelect);
  }

  collectManualTrainingIntervals() {
    return Array.from(this.manualIntervalList?.querySelectorAll(".dashboard-manual-interval-row") || [])
      .map((row) => {
        const value = (name) => row.querySelector(`[data-manual-interval-field='${name}']`)?.value ?? "";
        return {
          repetitions: value("repetitions"),
          workDurationSeconds: Math.round(Number(value("workDurationMinutes")) * 60),
          recoveryDurationSeconds: Math.round(Number(value("recoveryDurationMinutes")) * 60),
          powerMode: value("powerMode"),
          workPowerValue: value("workPowerValue"),
          recoveryPowerValue: value("recoveryPowerValue")
        };
      });
  }

  async editManualTraining(activity) {
    try {
      const response = await fetch(`/files/training-activities/${encodeURIComponent(activity.id)}`, {
        credentials: "include",
        headers: { Accept: "application/json" }
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || this.t("manualTrainingLoadFailed"));
      this.openManualTrainingForm(result.activity);
    } catch (error) {
      this.showToast(error?.message || this.t("manualTrainingLoadFailed"));
    }
  }

  localDateKey(date) {
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0")
    ].join("-");
  }

  dateFromLocalKey(key) {
    const [year, month, day] = String(key || "").split("-").map(Number);
    return new Date(year, month - 1, day);
  }

  openManualTrainingCopy(activity) {
    const sourceStart = new Date(activity?.start_time);
    if (!Number.isFinite(sourceStart.getTime()) || !this.manualCopyModal) return;
    this.manualCopyActivity = activity;
    this.manualCopySelectedDates.clear();
    const now = new Date();
    this.manualCopyVisibleMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const title = String(activity.title || `A-${activity.id}`);
    const time = sourceStart.toLocaleTimeString(this.locale, { hour: "2-digit", minute: "2-digit" });
    if (this.manualCopySourceElement) {
      this.manualCopySourceElement.textContent = this.t("manualTrainingCopySource", { title, time });
    }
    this.hideManualCopyError();
    this.renderManualCopyCalendar();
    this.renderManualCopySelection();
    this.manualCopyModal.show();
  }

  moveManualCopyMonth(offset) {
    this.manualCopyVisibleMonth = new Date(
      this.manualCopyVisibleMonth.getFullYear(),
      this.manualCopyVisibleMonth.getMonth() + offset,
      1
    );
    this.renderManualCopyCalendar();
  }

  toggleManualCopyDate(key) {
    if (!key) return;
    if (this.manualCopySelectedDates.has(key)) {
      this.manualCopySelectedDates.delete(key);
    } else if (this.manualCopySelectedDates.size < 50) {
      this.manualCopySelectedDates.add(key);
    }
    this.renderManualCopyCalendar();
    this.renderManualCopySelection();
  }

  renderManualCopyCalendar() {
    if (!this.manualCopyDaysElement || !this.manualCopyWeekdaysElement) return;
    const year = this.manualCopyVisibleMonth.getFullYear();
    const month = this.manualCopyVisibleMonth.getMonth();
    if (this.manualCopyMonthElement) {
      this.manualCopyMonthElement.textContent = this.manualCopyVisibleMonth.toLocaleDateString(
        this.locale,
        { month: "long", year: "numeric" }
      );
    }
    this.manualCopyWeekdaysElement.innerHTML = Array.from({ length: 7 }, (_, index) => {
      const date = new Date(2024, 0, 1 + index);
      return `<span>${date.toLocaleDateString(this.locale, { weekday: "short" })}</span>`;
    }).join("");

    const sourceKey = this.localDateKey(new Date(this.manualCopyActivity?.start_time));
    const todayKey = this.localDateKey(new Date());
    const leadingDays = (new Date(year, month, 1).getDay() + 6) % 7;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const cells = Array.from({ length: leadingDays }, () => (
      '<span class="dashboard-manual-copy-day dashboard-manual-copy-day--empty"></span>'
    ));
    for (let day = 1; day <= daysInMonth; day += 1) {
      const date = new Date(year, month, day);
      const key = this.localDateKey(date);
      const selected = this.manualCopySelectedDates.has(key);
      const disabled = key === sourceKey || (!selected && this.manualCopySelectedDates.size >= 50);
      const classes = [
        "dashboard-manual-copy-day",
        selected ? "is-selected" : "",
        key === todayKey ? "is-today" : ""
      ].filter(Boolean).join(" ");
      cells.push(`<button class="${classes}" type="button" data-manual-copy-date="${key}"${disabled ? " disabled" : ""} aria-pressed="${selected}">${day}</button>`);
    }
    this.manualCopyDaysElement.innerHTML = cells.join("");
  }

  renderManualCopySelection() {
    const keys = [...this.manualCopySelectedDates].sort();
    if (this.manualCopyCountElement) this.manualCopyCountElement.textContent = `${keys.length}/50`;
    if (this.manualCopySubmitButton) this.manualCopySubmitButton.disabled = keys.length === 0;
    this.manualCopyEmptyElement?.classList.toggle("d-none", keys.length > 0);
    if (!this.manualCopySelectedElement) return;
    this.manualCopySelectedElement.innerHTML = keys.map((key) => {
      const label = this.dateFromLocalKey(key).toLocaleDateString(this.locale, { dateStyle: "medium" });
      return `<span class="dashboard-manual-copy-chip">${label}<button type="button" data-manual-copy-remove="${key}" aria-label="${this.t("manualTrainingCopyRemoveDate", { date: label })}">×</button></span>`;
    }).join("");
  }

  hideManualCopyError() {
    if (!this.manualCopyErrorElement) return;
    this.manualCopyErrorElement.textContent = "";
    this.manualCopyErrorElement.classList.add("d-none");
  }

  showManualCopyError(message) {
    if (!this.manualCopyErrorElement) return;
    this.manualCopyErrorElement.textContent = message;
    this.manualCopyErrorElement.classList.remove("d-none");
  }

  async copyManualTraining() {
    const activity = this.manualCopyActivity;
    if (!activity?.id || this.manualCopySelectedDates.size === 0) return;
    const sourceStart = new Date(activity.start_time);
    const targetStartTimes = [...this.manualCopySelectedDates].sort().map((key) => {
      const target = this.dateFromLocalKey(key);
      target.setHours(
        sourceStart.getHours(),
        sourceStart.getMinutes(),
        sourceStart.getSeconds(),
        sourceStart.getMilliseconds()
      );
      return target.toISOString();
    });

    this.hideManualCopyError();
    this.manualCopySubmitButton.disabled = true;
    try {
      const response = await fetch(`/files/training-activities/${encodeURIComponent(activity.id)}/copies`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ targetStartTimes })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || this.t("manualTrainingCopyFailed"));
      this.manualCopyModal.hide();
      await this.libraryView.reload();
      this.showToast(this.t("manualTrainingCopyComplete", {
        created: Number(result.createdCount || 0),
        skipped: Number(result.skippedCount || 0)
      }));
    } catch (error) {
      this.showManualCopyError(error?.message || this.t("manualTrainingCopyFailed"));
    } finally {
      this.manualCopySubmitButton.disabled = this.manualCopySelectedDates.size === 0;
    }
  }

  hideManualTrainingError() {
    if (!this.manualTrainingErrorElement) return;
    this.manualTrainingErrorElement.textContent = "";
    this.manualTrainingErrorElement.classList.add("d-none");
  }

  showManualTrainingError(message) {
    if (!this.manualTrainingErrorElement) return;
    this.manualTrainingErrorElement.textContent = message;
    this.manualTrainingErrorElement.classList.remove("d-none");
  }

  async saveManualTraining() {
    if (!this.manualTrainingForm || !this.manualTrainingForm.reportValidity()) return;
    this.hideManualTrainingError();
    const formData = new FormData(this.manualTrainingForm);
    const startTime = new Date(String(formData.get("startTime") || ""));
    const payload = {
      startTime: startTime.toISOString(),
      durationSeconds: Number(formData.get("durationMinutes")) * 60,
      activityType: String(formData.get("activityType") || ""),
      workoutType: String(formData.get("workoutType") || ""),
      perceivedExertion: formData.get("perceivedExertion"),
      baselinePowerMode: formData.get("baselinePowerMode"),
      baselinePowerValue: formData.get("baselinePowerValue"),
      intervals: this.collectManualTrainingIntervals(),
      estimatedTss: formData.get("estimatedTss"),
      strengthFocus: formData.get("strengthFocus"),
      title: String(formData.get("title") || ""),
      notes: String(formData.get("notes") || "")
    };

    if (this.manualTrainingSubmitButton) this.manualTrainingSubmitButton.disabled = true;
    try {
      const activityId = this.editingManualActivityId;
      const response = await fetch(
        activityId === null
          ? "/files/training-activities"
          : `/files/training-activities/${encodeURIComponent(activityId)}`,
        {
          method: activityId === null ? "POST" : "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(payload)
        }
      );
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || this.t("manualTrainingSaveFailed"));
      this.manualTrainingModal?.hide();
      await this.libraryView.reload();
      this.showToast(this.t(activityId === null ? "manualTrainingSaved" : "manualTrainingUpdated"));
    } catch (error) {
      this.showManualTrainingError(error?.message || this.t("manualTrainingSaveFailed"));
    } finally {
      if (this.manualTrainingSubmitButton) this.manualTrainingSubmitButton.disabled = false;
    }
  }

  async deleteManualTraining(activity) {
    const activityId = activity?.id;
    if (activityId === null || activityId === undefined) return;
    const label = String(activity.title || `A-${activityId}`);
    const confirmed = await confirmModal({
      title: this.t("manualTrainingDeleteTitle"),
      message: this.t("manualTrainingDeletePrompt", { title: label }),
      acceptLabel: this.t("manualTrainingDeleteConfirm"),
      cancelLabel: this.t("manualTrainingCancel"),
      acceptClass: "btn-danger"
    });
    if (!confirmed) return;

    try {
      const response = await fetch(`/files/training-activities/${encodeURIComponent(activityId)}`, {
        method: "DELETE",
        credentials: "include",
        headers: { Accept: "application/json" }
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || this.t("manualTrainingDeleteFailed"));
      await this.libraryView.reload();
      this.showToast(this.t("manualTrainingDeleted"));
    } catch (error) {
      this.showToast(error?.message || this.t("manualTrainingDeleteFailed"));
    }
  }

  async exportAllWorkoutsAsFit() {
    if (!this.exportAllFitButton || this.exportAllFitButton.disabled) {
      return;
    }

    const button = this.exportAllFitButton;
    button.disabled = true;
    this.heroStatusElement.hidden = false;
    this.heroStatusElement.textContent = this.t("exportFitPreparing");

    let worker = null;
    try {
      const totalStartedAt = performance.now();
      const downloadStartedAt = performance.now();
      const response = await fetch("/workouts/export/all/source.zip", {
        headers: { Accept: "application/zip" }
      });
      if (!response.ok) {
        throw new Error(this.t("exportFitFailedStatus", { status: response.status }));
      }

      const sourceBuffer = await response.arrayBuffer();
      const downloadMs = performance.now() - downloadStartedAt;
      const sourceBytes = sourceBuffer.byteLength;
      this.heroStatusElement.textContent = this.t("exportFitConverting", {
        completed: 0,
        total: "…"
      });
      worker = new Worker("/js/workout-fit-export-worker.js", { type: "module" });
      const result = await new Promise((resolve, reject) => {
        worker.addEventListener("message", (event) => {
          if (event.data?.type === "progress") {
            this.heroStatusElement.textContent = this.t("exportFitConverting", {
              completed: event.data.completed,
              total: event.data.total
            });
            return;
          }
          if (event.data?.type === "complete") {
            resolve({
              archiveBytes: event.data.archiveBytes,
              profile: event.data.profile || {}
            });
            return;
          }
          if (event.data?.type === "error") {
            reject(new Error(event.data.message || this.t("exportFitFailed")));
          }
        });
        worker.addEventListener("error", reject);
        worker.postMessage({ type: "convert", sourceBuffer }, [sourceBuffer]);
      });
      const archiveBytes = result.archiveBytes;

      const blob = new Blob([archiveBytes], { type: "application/zip" });
      const downloadUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = downloadUrl;
      link.download = `woa-workouts-fit-${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(downloadUrl), 60_000);
      console.info("[fit-export] browser.profile", {
        sourceBytes,
        archiveBytes: archiveBytes.byteLength,
        downloadMs: Number(downloadMs.toFixed(2)),
        ...result.profile,
        totalMs: Number((performance.now() - totalStartedAt).toFixed(2))
      });
      this.heroStatusElement.textContent = this.t("exportFitComplete");
      setTimeout(() => {
        this.heroStatusElement.hidden = true;
      }, 4_000);
    } catch (error) {
      console.error("Bulk FIT export failed:", error);
      this.heroStatusElement.textContent = error?.message || this.t("exportFitFailed");
      this.showToast(error?.message || this.t("exportFitFailed"));
    } finally {
      worker?.terminate();
      button.disabled = false;
    }
  }

  exportManualActivity(activity) {
    const activityId = activity?.id;
    if (activityId == null) return;
    const link = document.createElement("a");
    link.href = `/files/training-activities/${encodeURIComponent(activityId)}/export.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  exportAllManualActivities() {
    const link = document.createElement("a");
    link.href = "/files/training-activities/export.zip";
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  resetManualActivityImport() {
    this.pendingManualImportActivities = [];
    if (this.manualImportFileInput) this.manualImportFileInput.value = "";
    if (this.manualImportOverwriteInput) this.manualImportOverwriteInput.checked = false;
    if (this.manualImportOverwriteInput) this.manualImportOverwriteInput.disabled = true;
    if (this.manualImportSubmitButton) this.manualImportSubmitButton.disabled = true;
    this.manualImportErrorElement?.classList.add("d-none");
    this.manualImportPreviewElement?.classList.add("d-none");
  }

  openManualActivityImport() {
    this.resetManualActivityImport();
    this.switchDashboardModal(this.addTrainingModalElement, this.addTrainingModal, this.manualImportModal);
  }

  showManualActivityImportError(message) {
    if (!this.manualImportErrorElement) return;
    this.manualImportErrorElement.textContent = message;
    this.manualImportErrorElement.classList.remove("d-none");
  }

  async inspectManualActivityImport(file) {
    this.pendingManualImportActivities = [];
    if (this.manualImportSubmitButton) this.manualImportSubmitButton.disabled = true;
    this.manualImportErrorElement?.classList.add("d-none");
    this.manualImportPreviewElement?.classList.add("d-none");
    if (!file) return;

    try {
      const parsed = await parseManualActivityFile(file);
      const response = await fetch("/files/training-activities/import/preview", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ activities: parsed.activities })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || this.t("manualActivityImportInvalid"));
      this.pendingManualImportActivities = parsed.activities;
      const preview = result.preview || {};
      if (this.manualImportOverwriteInput) {
        this.manualImportOverwriteInput.disabled = !(Number(preview.conflictCount) > 0);
      }
      if (this.manualImportPreviewElement) {
        this.manualImportPreviewElement.textContent = this.t("manualActivityImportPreview", {
          total: preview.totalCount ?? parsed.activities.length,
          fresh: preview.newCount ?? 0,
          duplicates: preview.duplicateCount ?? 0,
          conflicts: preview.conflictCount ?? 0
        });
        this.manualImportPreviewElement.classList.remove("d-none");
      }
      if (this.manualImportSubmitButton) this.manualImportSubmitButton.disabled = false;
    } catch (error) {
      console.warn("Manual activity import validation failed", error);
      this.showManualActivityImportError(this.t("manualActivityImportInvalid"));
    }
  }

  async importManualActivities() {
    if (this.pendingManualImportActivities.length === 0 || !this.manualImportSubmitButton) return;
    this.manualImportSubmitButton.disabled = true;
    this.manualImportErrorElement?.classList.add("d-none");
    try {
      const response = await fetch("/files/training-activities/import", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          activities: this.pendingManualImportActivities,
          overwriteExisting: this.manualImportOverwriteInput?.checked === true
        })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || this.t("manualActivityImportFailed"));
      const result = payload.result || {};
      this.manualImportModal?.hide();
      await this.libraryView.reload();
      this.showToast(this.t("manualActivityImportComplete", {
        created: result.createdCount ?? 0,
        updated: result.updatedCount ?? 0,
        skipped: result.skippedCount ?? 0
      }));
      this.resetManualActivityImport();
    } catch (error) {
      this.showManualActivityImportError(error?.message || this.t("manualActivityImportFailed"));
      this.manualImportSubmitButton.disabled = false;
    }
  }

  async boot() {
    try {
      await Promise.all([
        this.loadShareableGroups(),
        this.restoreWorkoutLibraryPreferences()
      ]);
      await this.libraryView.initialize();
      this.resetWorkspaceSummary();
      this.scheduleDesktopLayoutMeasure();
      await this.restoreSelectedWorkout();
      this.restoreLibraryScrollPosition();
      this.renderQuickAccess();
    } catch (err) {
      console.error(err);
      this.showToast(this.t("messages.workoutLibraryLoadFailed"));
    }
  }

  async restoreWorkoutLibraryPreferences() {
    try {
      const storedState = await ViewPreferenceService.load(WORKOUT_LIBRARY_VIEW_KEY);
      this.viewPreferencesAvailable = true;
      if (!storedState) {
        return;
      }

      const {
        xAxisMode,
        smoothingLevel,
        bridgePowerCadenceZeros,
        seriesVisibility,
        segmentVisibility,
        ...storedLibraryState
      } = storedState;
      this.libraryState = {
        ...this.libraryState,
        ...storedLibraryState
      };
      this.uiState.set("workoutLibraryState", this.libraryState);
      this.libraryView.applyState(this.libraryState);

      if (
        xAxisMode
        || smoothingLevel
        || typeof bridgePowerCadenceZeros === "boolean"
        || seriesVisibility
        || segmentVisibility
      ) {
        this.chartViewState = {
          ...this.chartViewState,
          ...(xAxisMode ? { xAxisMode } : {}),
          ...(smoothingLevel ? { smoothingLevel } : {}),
          ...(typeof bridgePowerCadenceZeros === "boolean"
            ? { bridgePowerCadenceZeros }
            : {}),
          ...(seriesVisibility ? {
            seriesVisibility: {
              ...this.chartViewState.seriesVisibility,
              ...seriesVisibility
            }
          } : {}),
          segmentVisibility: {
            ...this.chartViewState.segmentVisibility,
            ...segmentVisibility
          }
        };
        this.uiState.set("chartViewState", this.chartViewState);
        this.chartView.applyPreferences(this.chartViewState);
        this.mapView.setSegmentVisibility(this.chartViewState.segmentVisibility);
      }
    } catch (err) {
      this.viewPreferencesAvailable = false;
      console.warn("Workout library preferences remain local for this session:", err);
    }
  }

  scheduleWorkoutLibraryPreferenceSave(state) {
    if (!this.viewPreferencesAvailable) {
      return;
    }

    this.pendingWorkoutLibraryPreferenceState = {
      ...state,
      xAxisMode: this.chartViewState.xAxisMode,
      smoothingLevel: this.chartViewState.smoothingLevel,
      bridgePowerCadenceZeros: this.chartViewState.bridgePowerCadenceZeros,
      seriesVisibility: {
        ...this.chartViewState.seriesVisibility
      },
      segmentVisibility: {
        ...this.chartViewState.segmentVisibility
      }
    };
    clearTimeout(this.viewPreferenceSaveTimer);
    this.viewPreferenceSaveTimer = setTimeout(() => {
      this.persistWorkoutLibraryPreferences();
    }, VIEW_PREFERENCE_SAVE_DELAY_MS);
  }

  persistWorkoutLibraryPreferences({ keepalive = false } = {}) {
    const state = this.pendingWorkoutLibraryPreferenceState;
    if (!state || !this.viewPreferencesAvailable) {
      return;
    }

    this.pendingWorkoutLibraryPreferenceState = null;
    clearTimeout(this.viewPreferenceSaveTimer);
    this.viewPreferenceSaveTimer = null;

    if (keepalive) {
      void ViewPreferenceService.save(WORKOUT_LIBRARY_VIEW_KEY, state, { keepalive })
        .catch((err) => console.warn("Workout library preferences could not be saved:", err));
      return;
    }

    this.viewPreferenceSaveChain = this.viewPreferenceSaveChain
      .catch(() => {})
      .then(() => ViewPreferenceService.save(WORKOUT_LIBRARY_VIEW_KEY, state))
      .catch((err) => {
        console.warn("Workout library preferences could not be saved:", err);
      });
  }

  async openWorkout(workoutId) {
    if (!workoutId) {
      return;
    }

    this.chartView.showLoading();
    const profilingEnabled = WorkoutService.isOpenProfilingEnabled?.();
    const profile = {
      workoutId: String(workoutId),
      loadWorkoutMs: 0,
      applyMetaMs: 0,
      chartRenderMs: 0,
      mapRenderMs: 0,
      flyoverBindMs: 0,
      similarLoadMs: 0,
      postRenderUiMs: 0,
      firstPaintWallMs: 0,
      totalOpenMs: 0
    };
    const totalStartedAt = performance.now();

    try {
      const workoutMeta = this.libraryView.getWorkoutById(workoutId) || {};
      let stepStartedAt = performance.now();
      const workout = await WorkoutService.loadWorkoutByRow(workoutId);
      profile.loadWorkoutMs = performance.now() - stepStartedAt;
      if (!workout) {
        this.uiState.remove("selectedWorkoutId");
        this.currentWorkoutId = null;
        this.libraryView.setSelectedWorkout(null);
        this.resetWorkspaceSummary();
        return;
      }

      stepStartedAt = performance.now();
      Object.assign(workout, {
        start_time: workout.start_time ?? workoutMeta.start_time ?? null,
        total_timer_time: workout.total_timer_time ?? workoutMeta.total_timer_time ?? null,
        total_distance: workout.total_distance ?? workoutMeta.total_distance ?? null,
        avg_power: workout.avg_power ?? workoutMeta.avg_power ?? null,
        intensity_profile: workout.intensity_profile ?? workoutMeta.intensity_profile ?? "unknown",
        intensity_tags: workout.intensity_tags ?? workoutMeta.intensity_tags ?? 0,
        intensity_structure: workout.intensity_structure ?? workoutMeta.intensity_structure ?? "unknown",
        intensity_dose: workout.intensity_dose ?? workoutMeta.intensity_dose ?? "unknown",
        segmentProcessingStatus: workout.segmentProcessingStatus ?? workoutMeta.segment_processing_status ?? workoutMeta.segmentProcessingStatus ?? "queued",
        segmentProcessingError: workout.segmentProcessingError ?? workoutMeta.segment_processing_error ?? workoutMeta.segmentProcessingError ?? null,
        segmentProcessingUpdatedAt: workout.segmentProcessingUpdatedAt ?? workoutMeta.segment_processing_updated_at ?? workoutMeta.segmentProcessingUpdatedAt ?? null,
        is_owned: workoutMeta.is_owned ?? (workout.access?.isOwner !== false)
      });
      profile.applyMetaMs = performance.now() - stepStartedAt;

      this.currentWorkoutId = workout.id;
      this.uiState.set("selectedWorkoutId", workout.id);
      this.libraryView.setWorkoutFavoriteState(workout.id, workout.isFavorite);

      stepStartedAt = performance.now();
      this.focusedWorkoutSegmentKey = null;
      this.chartView.clearSegmentHover();
      this.chartView.clearSegmentFocus();
      this.chartView.updateWorkout(workout);
      profile.chartRenderMs = performance.now() - stepStartedAt;

      stepStartedAt = performance.now();
      this.mapView.renderTrack(workout);
      profile.mapRenderMs = performance.now() - stepStartedAt;

      stepStartedAt = performance.now();
      this.flyoverView.setWorkout(workout);
      profile.flyoverBindMs = performance.now() - stepStartedAt;

      this.libraryView.setSelectedWorkout(workout.id);
      this.updateWorkoutMeta(workout);
      this.updateIntensitySummary(workout);
      this.updateDeviceInfo(workout);
      this.renderWorkoutSegments(workout);

      stepStartedAt = performance.now();
      this.scheduleDesktopLayoutMeasure(true);
      this.closeMobileLibrary();
      this.scrollDetailIntoViewOnMobile();
      this.renderQuickAccess();
      this.updateDetailNavigation();
      profile.postRenderUiMs = performance.now() - stepStartedAt;

      const paintStartedAt = performance.now();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      profile.firstPaintWallMs = performance.now() - paintStartedAt;
      profile.totalOpenMs = performance.now() - totalStartedAt;

      if (profilingEnabled) {
        console.info("[workout-open] render.profile", { ...profile });
      }

      void (async () => {
        const similarStartedAt = performance.now();
        try {
          await this.loadSimilarWorkouts(workout);
          profile.similarLoadMs = performance.now() - similarStartedAt;
        } catch (err) {
          profile.similarLoadMs = performance.now() - similarStartedAt;
          console.error(err);
        } finally {
          if (profilingEnabled) {
            console.info("[workout-open] render.profile.similar", {
              workoutId: String(workout.id),
              similarLoadMs: profile.similarLoadMs
            });
          }
        }
      })();
    } catch (err) {
      profile.totalOpenMs = performance.now() - totalStartedAt;
      if (profilingEnabled) {
        console.info("[workout-open] render.profile.failed", {
          ...profile,
          error: err?.message || String(err)
        });
      }
      console.error(err);
      this.resetWorkspaceSummary();
      this.showToast(this.t("messages.workoutOpenFailed"));
    } finally {
      this.chartView.hideLoading();
      this.update3dMapButton();
    }
  }

  open3dMap() {
    if (!this.maptilerApiKey) {
      this.showToast(this.t("messages.map3dKeyMissing"));
      return;
    }

    const workout = this.chartView.currentWorkout;
    if (!workout?.validGps || !Array.isArray(workout?.track) || workout.track.length < 2) {
      this.showToast(this.t("messages.map3dNoGps"));
      return;
    }

    this.flyoverView.setWorkout(workout);
    this.flyoverView.open();
  }

  getNavigableWorkoutIds() {
    return this.libraryView.getNavigableWorkouts().map((workout) => String(workout.id));
  }

  updateDetailNavigation() {
    const ids = this.getNavigableWorkoutIds();
    const currentId = this.currentWorkoutId ? String(this.currentWorkoutId) : null;
    const index = currentId ? ids.indexOf(currentId) : -1;
    const hasPrev = index > 0;
    const hasNext = index >= 0 && index < ids.length - 1;

    this.prevWorkoutButton && (this.prevWorkoutButton.disabled = !hasPrev);
    this.nextWorkoutButton && (this.nextWorkoutButton.disabled = !hasNext);
  }

  async openRelativeWorkout(direction = 1) {
    const ids = this.getNavigableWorkoutIds();
    const currentId = this.currentWorkoutId ? String(this.currentWorkoutId) : null;
    const index = currentId ? ids.indexOf(currentId) : -1;
    if (index < 0) {
      return;
    }

    const nextId = ids[index + (direction < 0 ? -1 : 1)];
    if (!nextId) {
      return;
    }

    this.currentWorkoutId = nextId;
    this.uiState.set("selectedWorkoutId", nextId);
    const url = new URL(window.location.href);
    url.searchParams.set("workoutId", nextId);
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    await this.openWorkout(nextId);
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
    const headerDetailLine = this.buildWorkoutDetailLine(workout);

    if (this.workoutTitleElement) {
      this.workoutTitleElement.textContent = this.libraryT("workoutLabel", { id: workout?.id });
    }

    if (access?.isOwner) {
      this.sharedMetaElement.classList.add("d-none");
      this.sharedMetaTextElement.textContent = "";
      this.detailCopyElement.textContent = headerDetailLine;
      return;
    }

    this.sharedMetaElement.classList.remove("d-none");
    this.sharedMetaTextElement.textContent = this.t("messages.sharedBy", { owner: ownerLabel });
    this.detailCopyElement.textContent = headerDetailLine;
  }

  getIntensityProfileLabel(profile) {
    const normalized = profile === "vo2max"
      ? "Vo2max"
      : `${String(profile || "unknown").charAt(0).toUpperCase()}${String(profile || "unknown").slice(1)}`;
    return this.t(`intensityProfile${normalized}`);
  }

  updateIntensitySummary(workout) {
    if (!this.intensitySummaryElement || !this.intensityBadgesElement || !this.intensityContextElement) {
      return;
    }

    const primary = ["recovery", "endurance", "tempo", "threshold", "vo2max", "anaerobic"].includes(workout?.intensity_profile)
      ? workout.intensity_profile
      : "unknown";
    const profiles = intensityProfilesFromTags(workout?.intensity_tags, primary);
    const visibleProfiles = profiles.length ? profiles : ["unknown"];

    this.intensityBadgesElement.replaceChildren(...visibleProfiles.map((profile, index) => {
      const badge = document.createElement("span");
      badge.className = `workout-intensity-badge workout-intensity-badge--${profile}${index ? " workout-intensity-badge--secondary" : ""}`;
      badge.textContent = this.getIntensityProfileLabel(profile);
      if (index === 0) {
        const bolt = document.createElement("span");
        bolt.className = "workout-intensity-badge__bolt";
        bolt.setAttribute("aria-hidden", "true");
        bolt.textContent = "ϟ";
        badge.prepend(bolt);
      }
      return badge;
    }));

    const contextParts = [];
    if (["steady", "variable", "intervals"].includes(workout?.intensity_structure)) {
      contextParts.push(this.t(`intensityStructure${workout.intensity_structure.charAt(0).toUpperCase()}${workout.intensity_structure.slice(1)}`));
    }
    if (["low", "moderate", "high"].includes(workout?.intensity_dose)) {
      contextParts.push(this.t(`intensityDose${workout.intensity_dose.charAt(0).toUpperCase()}${workout.intensity_dose.slice(1)}`));
    }
    this.intensityContextElement.textContent = contextParts.join(" · ");
    this.intensityContextElement.hidden = contextParts.length === 0;
    this.intensitySummaryElement.hidden = false;
  }

  updateDeviceInfo(workout) {
    const metadata = workout?.fitDeviceMetadata;
    const fileId = metadata?.fileId && typeof metadata.fileId === "object"
      ? metadata.fileId
      : null;
    const devices = Array.isArray(metadata?.devices)
      ? metadata.devices.filter((device) => device && typeof device === "object")
      : [];

    if (!fileId && devices.length === 0) {
      this.resetDeviceInfo();
      return;
    }

    const recorder = devices.find((device) => Number(device.deviceIndex) === 0)
      || devices.find((device) => device.productName)
      || null;
    const recorderName = fileId?.productName
      || recorder?.productName
      || fileId?.manufacturerName
      || recorder?.manufacturerName
      || this.t("deviceInfoUnknown");
    const softwareVersion = recorder?.softwareVersion;
    const createdAt = fileId?.timeCreated ? new Date(fileId.timeCreated) : null;
    const sensors = devices.filter((device) => (
      device !== recorder
      && Number(device.deviceIndex) !== 0
      && !["gps", "barometer"].includes(String(device.deviceTypeName || "").toLowerCase())
    ));

    this.deviceInfoElement?.classList.remove("d-none");
    this.deviceInfoElement?.removeAttribute("open");
    this.deviceInfoRecorderElement.textContent = recorderName;
    this.deviceInfoSoftwareElement.textContent = softwareVersion == null
      ? "–"
      : String(softwareVersion);
    this.deviceInfoCreatedElement.textContent = createdAt && !Number.isNaN(createdAt.getTime())
      ? new Intl.DateTimeFormat(this.locale, {
          dateStyle: "medium",
          timeStyle: "short"
        }).format(createdAt)
      : "–";
    this.deviceInfoActivityElement.textContent = this.formatWorkoutType(workout);

    this.deviceInfoSensorsElement.replaceChildren();
    if (sensors.length === 0) {
      const empty = document.createElement("span");
      empty.className = "dashboard-device-info__empty";
      empty.textContent = this.t("deviceInfoNoSensors");
      this.deviceInfoSensorsElement.append(empty);
    } else {
      sensors.forEach((device) => {
        const item = document.createElement("div");
        item.className = "dashboard-device-info__sensor";
        const name = document.createElement("strong");
        name.textContent = this.formatDeviceType(device.deviceTypeName);
        const detail = document.createElement("span");
        detail.textContent = [device.manufacturerName, device.sourceTypeName]
          .filter(Boolean)
          .map((value) => this.humanizeFitValue(value))
          .join(" · ") || this.t("deviceInfoUnknown");
        item.append(name, detail);
        this.deviceInfoSensorsElement.append(item);
      });
    }

    const technicalRows = [
      [this.t("deviceInfoFileType"), this.humanizeFitValue(fileId?.typeName)],
      [this.t("deviceInfoManufacturer"), this.humanizeFitValue(fileId?.manufacturerName || recorder?.manufacturerName)],
      [this.t("deviceInfoProductCode"), fileId?.product],
      [this.t("deviceInfoSerialNumber"), fileId?.serialNumber],
      [this.t("deviceInfoDeviceCount"), devices.length]
    ].filter(([, value]) => value !== null && value !== undefined && value !== "");
    this.deviceInfoTechnicalElement.replaceChildren();
    technicalRows.forEach(([label, value]) => {
      const row = document.createElement("div");
      const term = document.createElement("dt");
      const description = document.createElement("dd");
      term.textContent = label;
      description.textContent = String(value);
      row.append(term, description);
      this.deviceInfoTechnicalElement.append(row);
    });
  }

  resetDeviceInfo() {
    this.deviceInfoElement?.removeAttribute("open");
    this.deviceInfoElement?.classList.add("d-none");
    this.deviceInfoSensorsElement?.replaceChildren();
    this.deviceInfoTechnicalElement?.replaceChildren();
  }

  formatWorkoutType(workout) {
    const workoutType = String(workout?.workout_type || workout?.workoutType || "unknown");
    const key = {
      indoor: "workoutTypeIndoor",
      road: "workoutTypeRoad",
      mountain: "workoutTypeMountain",
      motorsport: "workoutTypeMotorsport",
      unknown: "workoutTypeUnknown"
    }[workoutType] || "workoutTypeUnknown";
    return this.t(key);
  }

  formatDeviceType(value) {
    const normalized = String(value || "").toLowerCase();
    if (normalized === "heart_rate") return this.t("deviceInfoHeartRate");
    if (normalized === "bike_power") return this.t("deviceInfoPowerMeter");
    if (normalized.includes("cadence")) return this.t("deviceInfoCadence");
    return this.humanizeFitValue(value) || this.t("deviceInfoSensor");
  }

  humanizeFitValue(value) {
    return String(value || "")
      .replaceAll("_", " ")
      .replace(/\b\w/g, (character) => character.toUpperCase());
  }

  async deleteSelectedWorkouts(workouts = []) {
    const ownWorkouts = Array.isArray(workouts) ? workouts.filter((workout) => workout?.is_owned) : [];
    if (!ownWorkouts.length) {
      return;
    }

    const ok = await confirmModal({
      title: this.t("bulkDelete"),
      message: this.t("bulkDeletePrompt", { count: ownWorkouts.length }),
      acceptLabel: this.t("bulkDelete"),
      cancelLabel: this.t("bulkCancel"),
      acceptClass: "btn-danger"
    });

    if (!ok) {
      return;
    }

    const deletedIds = new Set(
      await WorkoutService.deleteWorkoutsByIds(ownWorkouts.map((workout) => workout.id))
    );

    ownWorkouts
      .filter((workout) => deletedIds.has(Number(workout.id)))
      .forEach((workout) => {
      if (String(workout.id) === String(this.currentWorkoutId)) {
        this.currentWorkoutId = null;
        this.uiState.remove("selectedWorkoutId");
        this.resetWorkspaceSummary();
      }
      this.libraryView.removeWorkout(workout.id);
      });

    this.libraryView.setSelectionMode(false);
    this.renderQuickAccess();
  }

  async publishSelectedWorkouts(workouts = [], payload = {}) {
    const ownWorkouts = Array.isArray(workouts) ? workouts.filter((workout) => workout?.is_owned) : [];
    if (!ownWorkouts.length) {
      return;
    }

    for (const workout of ownWorkouts) {
      const sharing = await WorkoutService.updateWorkoutSharing(workout.id, payload);
      if (sharing) {
        this.libraryView.setWorkoutSharing(workout.id, sharing);
      }
    }

    this.showToast(this.t("messages.workoutShareUpdated"));
    this.libraryView.setSelectionMode(false);
  }

  renderQuickAccess() {
    if (!this.quickAccessElement || !this.favoriteWorkoutsElement) {
      return;
    }

    const favoriteItems = this.favoriteWorkoutIds
      .map((workoutId) => ({ id: workoutId }))
      .slice(0, 4);

    this.favoriteWorkoutsElement.innerHTML = favoriteItems
      .map((workout) => `<button class="dashboard-quick-access__link" type="button" data-quick-workout-open="${workout.id}">W-${workout.id}</button>`)
      .join("");

    this.quickAccessElement.hidden = favoriteItems.length === 0;

    this.quickAccessElement.querySelectorAll("[data-quick-workout-open]").forEach((element) => {
      element.addEventListener("click", async () => {
        const workoutId = element.getAttribute("data-quick-workout-open");
        if (!workoutId) {
          return;
        }

        this.currentWorkoutId = workoutId;
        this.uiState.set("selectedWorkoutId", workoutId);
        const url = new URL(window.location.href);
        url.searchParams.set("workoutId", workoutId);
        window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
        await this.openWorkout(workoutId);
      });
    });
  }

  restoreLibraryScrollPosition() {
    if (!this.libraryScrollElement || !Number.isFinite(this.libraryScrollTop)) {
      return;
    }

    requestAnimationFrame(() => {
      if (this.libraryScrollElement) {
        this.libraryScrollElement.scrollTop = this.libraryScrollTop;
      }
    });
  }

  handleGlobalShortcuts(event) {
    const target = event.target;
    const isTypingContext = target instanceof HTMLElement && (
      target.isContentEditable
      || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)
    );

    if (event.key === "Escape" && !isTypingContext) {
      if (this.isMobileLibraryOpen) {
        this.closeMobileLibrary();
        event.preventDefault();
        return;
      }

      if (this.libraryView.handleEscape()) {
        event.preventDefault();
      }
      return;
    }

    if (event.key === "/" && !isTypingContext) {
      event.preventDefault();
      this.libraryView.searchInput?.focus();
      this.libraryView.searchInput?.select?.();
      return;
    }

    if ((event.key === "f" || event.key === "F") && !isTypingContext && this.currentWorkoutId) {
      event.preventDefault();
      this.libraryView.toggleFavoriteWorkout(String(this.currentWorkoutId));
    }
  }

  resetWorkspaceSummary() {
    this.workspacePanelElement?.classList.remove("is-active");
    if (this.workoutTitleElement) {
      this.workoutTitleElement.textContent = this.t("workoutDataTitle");
    }
    if (this.detailCopyElement) {
      this.detailCopyElement.textContent = "";
    }
    if (this.intensitySummaryElement) {
      this.intensitySummaryElement.hidden = true;
    }
    this.intensityBadgesElement?.replaceChildren();
    if (this.intensityContextElement) {
      this.intensityContextElement.textContent = "";
    }
    this.resetDeviceInfo();
    this.resetWorkoutSegments();
    this.resetSimilarWorkouts();
    this.flyoverView?.setWorkout(null);
    this.update3dMapButton();
    this.updateDetailNavigation();
  }

  async openGpsCopyModal() {
    const workoutId = this.currentWorkoutId;
    if (!workoutId || !this.gpsCopyModal || !this.gpsCopyCandidatesElement) {
      return;
    }

    this.setGpsCopyStatus(this.t("copyGpsLoading"));
    this.gpsCopyCandidatesElement.innerHTML = "";
    this.gpsCopyModal.show();

    try {
      const candidates = await WorkoutService.getGpsCopyCandidates(workoutId);
      this.renderGpsCopyCandidates(candidates);
    } catch (err) {
      console.error(err);
      this.setGpsCopyStatus(err?.message || this.t("copyGpsLoadFailed"));
    }
  }

  setGpsCopyStatus(message = "", hidden = false) {
    if (!this.gpsCopyStatusElement) {
      return;
    }

    if (hidden || !message) {
      this.gpsCopyStatusElement.textContent = "";
      this.gpsCopyStatusElement.classList.add("d-none");
      return;
    }

    this.gpsCopyStatusElement.textContent = message;
    this.gpsCopyStatusElement.classList.remove("d-none");
  }

  renderGpsCopyCandidates(candidates = []) {
    if (!this.gpsCopyCandidatesElement) {
      return;
    }

    if (!Array.isArray(candidates) || candidates.length === 0) {
      this.setGpsCopyStatus(this.t("copyGpsEmpty"));
      this.gpsCopyCandidatesElement.innerHTML = "";
      return;
    }

    this.setGpsCopyStatus("", true);
    this.gpsCopyCandidatesElement.innerHTML = candidates.map((candidate) => {
      const startedAt = candidate?.start_time ? new Date(candidate.start_time) : null;
      const dateLabel = startedAt && !Number.isNaN(startedAt.getTime())
        ? startedAt.toLocaleDateString(this.locale, {
            weekday: "short",
            day: "2-digit",
            month: "short",
            year: "numeric"
          })
        : this.libraryT("na");
      const thumb = candidate?.has_thumbnail
        ? `<img src="/workouts/${candidate.id}/thumbnail?v=${encodeURIComponent(candidate.thumbnail_updated_at || candidate.start_time || "")}&style=${WORKOUT_ROUTE_THUMBNAIL_STYLE_VERSION}" alt="Workout ${candidate.id} thumbnail" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';"><div class="dashboard-gps-copy-card__thumb-fallback" style="display:none;">${this.t("copyGpsNoThumbnail")}</div>`
        : `<div class="dashboard-gps-copy-card__thumb-fallback">${this.t("copyGpsNoThumbnail")}</div>`;

      return `
        <article class="dashboard-gps-copy-card">
          <div class="dashboard-gps-copy-card__thumb">${thumb}</div>
          <div class="dashboard-gps-copy-card__meta">
            <h3 class="dashboard-gps-copy-card__title">W-${candidate.id}</h3>
            <p class="dashboard-gps-copy-card__copy">${dateLabel}</p>
            <div class="dashboard-gps-copy-card__stats">
              <span class="dashboard-gps-copy-card__chip">${this.libraryT("distance")}: ${this.formatDistance(candidate.total_distance)}</span>
              <span class="dashboard-gps-copy-card__chip">${this.libraryT("duration")}: ${this.formatDuration(candidate.total_timer_time)}</span>
              <span class="dashboard-gps-copy-card__chip">${this.t("copyGpsAscentLabel")}: ${this.formatAscent(candidate.total_ascent)}</span>
              <span class="dashboard-gps-copy-card__chip">${this.t("copyGpsDiffLabel")}: ${this.formatDistance(candidate.distance_delta_meters)}</span>
            </div>
          </div>
          <div>
            <button class="btn btn-primary btn-sm" type="button" data-gps-copy-select="${candidate.id}">
              ${this.t("copyGpsUse")}
            </button>
          </div>
        </article>
      `;
    }).join("");

    this.gpsCopyCandidatesElement.querySelectorAll("[data-gps-copy-select]").forEach((button) => {
      button.addEventListener("click", async () => {
        const sourceWorkoutId = Number(button.getAttribute("data-gps-copy-select"));
        if (!Number.isFinite(sourceWorkoutId) || !this.currentWorkoutId) {
          return;
        }

        button.disabled = true;
        this.setGpsCopyStatus(this.t("copyGpsApplying"));
        try {
          const result = await WorkoutService.copyGpsFromWorkout(this.currentWorkoutId, sourceWorkoutId);
          this.libraryView.updateWorkoutFields(this.currentWorkoutId, {
            validgps: true,
            validGps: true,
            gps_source: result?.gpsSource || "manual_lookup",
            gpsSource: result?.gpsSource || "manual_lookup",
            total_ascent: result?.totalAscent ?? null,
            total_descent: result?.totalDescent ?? null,
            has_thumbnail: !!result?.hasThumbnail,
            thumbnail_updated_at: result?.thumbnailUpdatedAt || new Date().toISOString()
          });
          this.gpsCopyModal?.hide();
          await this.openWorkout(this.currentWorkoutId);
          this.showToast(this.t("messages.copyGpsSaved"));
        } catch (err) {
          console.error(err);
          this.setGpsCopyStatus(err?.message || this.t("copyGpsApplyFailed"));
        } finally {
          button.disabled = false;
        }
      });
    });
  }

  update3dMapButton() {
    if (!this.map3dToggleButton) {
      return;
    }

    const workout = this.chartView?.currentWorkout;
    const canOpen = !!this.maptilerApiKey
      && !!workout?.validGps
      && Array.isArray(workout?.track)
      && workout.track.length > 1;

    this.map3dToggleButton.disabled = !canOpen;
  }

  buildWorkoutDetailLine(workout) {
    const startedAt = workout?.start_time ? new Date(workout.start_time) : null;
    const parts = [];

    if (startedAt) {
      const dateLabel = startedAt.toLocaleDateString(this.locale, {
        weekday: "short",
        day: "2-digit",
        month: "short",
        year: "numeric"
      });
      const timeLabel = startedAt.toLocaleTimeString(this.locale, {
        hour: "2-digit",
        minute: "2-digit"
      });
      parts.push([dateLabel, timeLabel].filter(Boolean).join(" · "));
    }

    parts.push(`${this.libraryT("duration")}: ${this.formatDuration(workout?.total_timer_time)}`);
    parts.push(`${this.libraryT("distance")}: ${this.formatDistance(workout?.total_distance)}`);
    parts.push(`${this.libraryT("avgPower")}: ${this.formatPower(workout?.avg_power)}`);

    return parts.filter(Boolean).join(" · ");
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

  formatAscent(value) {
    return Number.isFinite(value) ? `${Math.round(Number(value))} m` : this.libraryT("na");
  }

  formatDateTime(value) {
    if (!value) {
      return this.libraryT("na");
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return this.libraryT("na");
    }

    return date.toLocaleString(this.locale, {
      weekday: "short",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  getWorkoutSegmentTypeLabel(segment) {
    const labels = {
      criticalPower: "workoutSegmentTypeCriticalPower",
      auto: "workoutSegmentTypeAuto",
      manual: "workoutSegmentTypeManual",
      gps: "workoutSegmentTypeGps"
    };
    return this.t(labels[getSegmentVisibilityKey(segment)] || labels.manual);
  }

  getWorkoutSegmentTitle(segment) {
    const explicitName = String(segment?.segmentname ?? "").trim();
    if (explicitName) {
      return explicitName;
    }

    if (getSegmentVisibilityKey(segment) === "gps") {
      const startName = String(segment?.start_name ?? segment?.startName ?? "").trim();
      const endName = String(segment?.end_name ?? segment?.endName ?? "").trim();
      if (startName && endName) {
        return `${startName} → ${endName}`;
      }
      if (startName || endName) {
        return startName || endName;
      }
    }

    return this.getWorkoutSegmentTypeLabel(segment);
  }

  getWorkoutSegmentDistance(workout, segment) {
    const workoutObject = workout?.workoutObject;
    if (!workoutObject || typeof workoutObject.getDistanceAt !== "function") {
      return null;
    }
    if (typeof workoutObject.hasDistanceSeries === "function" && !workoutObject.hasDistanceSeries()) {
      return null;
    }

    const length = Number(workoutObject.length);
    const startOffset = Number(segment?.start_offset);
    const endOffset = Number(segment?.end_offset);
    if (!Number.isInteger(length) || length <= 0 || !Number.isFinite(startOffset) || !Number.isFinite(endOffset)) {
      return null;
    }

    const startIndex = Math.max(0, Math.min(length - 1, Math.floor(startOffset)));
    const endIndex = Math.max(startIndex, Math.min(length - 1, Math.floor(endOffset)));

    try {
      const startDistance = Number(workoutObject.getDistanceAt(startIndex));
      const endDistance = Number(workoutObject.getDistanceAt(endIndex));
      const distance = endDistance - startDistance;
      return Number.isFinite(distance) && distance >= 0 ? distance : null;
    } catch {
      return null;
    }
  }

  formatWorkoutSegmentDistance(distanceMeters) {
    if (distanceMeters == null) {
      return this.libraryT("na");
    }
    const distance = Number(distanceMeters);
    if (!Number.isFinite(distance) || distance < 0) {
      return this.libraryT("na");
    }
    if (distance < 1000) {
      return `${Math.round(distance)} m`;
    }
    return `${new Intl.NumberFormat(this.locale, { maximumFractionDigits: 1 }).format(distance / 1000)} km`;
  }

  resetWorkoutSegments() {
    if (!this.workoutSegmentsListElement || !this.workoutSegmentsCopyElement) {
      return;
    }

    this.workoutSegmentsCopyElement.textContent = this.t("workoutSegmentsCopy");
    this.focusedWorkoutSegmentKey = null;
    this.hoveredWorkoutSegmentKey = null;
    this.workoutSegmentsListElement.innerHTML = `
      <div class="dashboard-workout-segments-empty">${this.t("workoutSegmentsEmpty")}</div>
    `;
  }

  getWorkoutSegmentKey(segment) {
    const displayId = Utils.getSegmentDisplayId(segment);
    if (displayId != null) {
      return `${getSegmentVisibilityKey(segment)}:${displayId}`;
    }
    return [
      getSegmentVisibilityKey(segment),
      Number(segment?.start_offset || 0),
      Number(segment?.end_offset || 0)
    ].join(":");
  }

  canDeleteWorkoutSegment(workout, segment) {
    const segmentId = Number(segment?.id);
    const isOwner = workout?.access?.isOwner !== false && workout?.is_owned !== false;
    return isOwner
      && !segment?.isGPSSegment
      && getSegmentVisibilityKey(segment) === "manual"
      && Number.isInteger(segmentId)
      && segmentId > 0;
  }

  setHoveredWorkoutSegment(segment) {
    this.hoveredWorkoutSegmentKey = segment
      ? this.getWorkoutSegmentKey(segment)
      : null;

    this.workoutSegmentsListElement
      ?.querySelectorAll(".dashboard-workout-segment.is-segment-hovered")
      .forEach((element) => element.classList.remove("is-segment-hovered"));

    if (!this.hoveredWorkoutSegmentKey) {
      return;
    }

    const button = Array.from(
      this.workoutSegmentsListElement?.querySelectorAll("[data-workout-segment-focus]") || []
    ).find((candidate) => candidate.dataset.workoutSegmentFocus === this.hoveredWorkoutSegmentKey);
    button?.closest(".dashboard-workout-segment")?.classList.add("is-segment-hovered");
  }

  async deleteWorkoutSegment(workout, segment) {
    if (!this.canDeleteWorkoutSegment(workout, segment)) {
      return false;
    }

    const label = this.getWorkoutSegmentTitle(segment);
    const confirmed = await confirmModal({
      title: this.t("workoutSegmentDeleteTitle"),
      message: this.t("workoutSegmentDeletePrompt", { label }),
      acceptLabel: this.t("workoutSegmentDeleteConfirm"),
      cancelLabel: this.t("workoutSegmentDeleteCancel"),
      acceptClass: "btn-danger"
    });
    if (!confirmed) {
      return false;
    }

    await WorkoutService.deleteManualSegment(workout.id, segment.id);
    workout.segments = (Array.isArray(workout.segments) ? workout.segments : [])
      .filter((candidate) => String(candidate?.id) !== String(segment.id));

    if (String(this.currentWorkoutId) !== String(workout.id)) {
      return true;
    }

    if (this.focusedWorkoutSegmentKey === this.getWorkoutSegmentKey(segment)) {
      this.focusedWorkoutSegmentKey = null;
      this.chartView.clearSegmentFocus({ resetZoom: true });
    }
    this.chartView.clearSegmentHover();
    this.mapView.clearSegmentHover();
    this.chartView.updateWorkout(workout);
    this.mapView.renderTrack(workout);
    this.renderWorkoutSegments(workout);
    this.showToast(this.t("workoutSegmentDeleteSuccess"));
    return true;
  }

  renderWorkoutSegments(workout) {
    if (!this.workoutSegmentsListElement || !this.workoutSegmentsCopyElement) {
      return;
    }

    const segments = (Array.isArray(workout?.segments) ? workout.segments : [])
      .filter((segment) => (
        segment?.rowstate !== "DEL"
        && this.chartView.isSegmentTypeVisible(segment)
      ))
      .slice()
      .sort((left, right) => Number(left?.start_offset || 0) - Number(right?.start_offset || 0));

    if (!segments.length) {
      this.resetWorkoutSegments();
      return;
    }

    this.workoutSegmentsCopyElement.textContent = this.t("workoutSegmentsCount", { count: segments.length });
    this.workoutSegmentsListElement.innerHTML = segments.map((segment) => {
      const segmentKey = this.getWorkoutSegmentKey(segment);
      const isFocused = segmentKey === this.focusedWorkoutSegmentKey;
      const isSegmentHovered = segmentKey === this.hoveredWorkoutSegmentKey;
      const displayId = Utils.getSegmentDisplayId(segment);
      const identifier = displayId == null ? this.libraryT("na") : `S-${displayId}`;
      const typeLabel = this.getWorkoutSegmentTypeLabel(segment);
      const title = this.getWorkoutSegmentTitle(segment);
      const duration = segment?.duration != null && Number.isFinite(Number(segment.duration))
        ? Utils.formatDuration(Number(segment.duration))
        : this.libraryT("na");
      const averagePower = segment?.avg_power != null && Number.isFinite(Number(segment.avg_power))
        ? `${Math.round(Number(segment.avg_power))} W`
        : this.libraryT("na");
      const distance = this.formatWorkoutSegmentDistance(this.getWorkoutSegmentDistance(workout, segment));
      const averageHeartRate = segment?.avg_heart_rate != null && Number(segment.avg_heart_rate) > 0
        ? `${Math.round(Number(segment.avg_heart_rate))} bpm`
        : null;
      const averageCadence = segment?.avg_cadence != null && Number(segment.avg_cadence) > 0
        ? `${Math.round(Number(segment.avg_cadence))} rpm`
        : null;
      const averageSpeed = segment?.avg_speed != null && Number(segment.avg_speed) > 0
        ? `${new Intl.NumberFormat(this.locale, { maximumFractionDigits: 1 }).format(Number(segment.avg_speed))} km/h`
        : null;
      const stats = [
        [this.libraryT("durationShort"), duration],
        [this.libraryT("distanceShort"), distance],
        ["PW", averagePower],
        ...(averageHeartRate ? [["HR", averageHeartRate]] : []),
        ...(averageCadence ? [["CD", averageCadence]] : []),
        ...(averageSpeed ? [["SP", averageSpeed]] : [])
      ];
      const canDelete = this.canDeleteWorkoutSegment(workout, segment);
      const deleteAction = this.t("workoutSegmentDeleteAction");

      return `
        <div
          class="dashboard-workout-segment${isFocused ? " is-focused" : ""}${isSegmentHovered ? " is-segment-hovered" : ""}${canDelete ? " has-delete" : ""}"
          style="--segment-color:${getSegmentColor(segment)}"
        >
          <button
            type="button"
            class="dashboard-workout-segment__focus"
            data-workout-segment-focus="${this.escapeHtml(segmentKey)}"
            aria-pressed="${isFocused ? "true" : "false"}"
          >
            <span class="dashboard-workout-segment__accent" aria-hidden="true"></span>
            <span class="dashboard-workout-segment__content">
              <span class="dashboard-workout-segment__header">
                <span class="dashboard-workout-segment__title">${this.escapeHtml(title)}</span>
                <span class="dashboard-workout-segment__id">${this.escapeHtml(identifier)}</span>
              </span>
              ${title !== typeLabel ? `<span class="dashboard-workout-segment__meta">${this.escapeHtml(typeLabel)}</span>` : ""}
              <span class="dashboard-workout-segment__stats">
                ${stats.map(([label, value]) => `
                  <span class="dashboard-workout-segment__stat">
                    <strong>${this.escapeHtml(label)}</strong>
                    <span>${this.escapeHtml(value)}</span>
                  </span>
                `).join("")}
              </span>
            </span>
          </button>
          ${canDelete ? `
            <button
              type="button"
              class="dashboard-workout-segment__delete"
              data-workout-segment-delete="${this.escapeHtml(segmentKey)}"
              title="${this.escapeHtml(deleteAction)}"
              aria-label="${this.escapeHtml(deleteAction)}"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-2 6h10l-.7 11H7.7L7 9Zm3 2v7h2v-7h-2Zm4 0v7h2v-7h-2Z" />
              </svg>
            </button>
          ` : ""}
        </div>
      `;
    }).join("");

    this.workoutSegmentsListElement.querySelectorAll("[data-workout-segment-focus]").forEach((button) => {
      const getSegment = () => {
        const segmentKey = button.dataset.workoutSegmentFocus;
        return segments.find((candidate) => this.getWorkoutSegmentKey(candidate) === segmentKey);
      };

      const highlightSegment = () => {
        const segment = getSegment();
        if (segment) {
          this.chartView.hoverSegment(segment);
          this.mapView.hoverSegmentOverlay(segment);
        }
      };

      const clearSegmentHover = () => {
        this.chartView.clearSegmentHover();
        this.mapView.clearSegmentHover();
      };

      button.addEventListener("mouseenter", highlightSegment);
      button.addEventListener("mouseleave", clearSegmentHover);
      button.addEventListener("focus", highlightSegment);
      button.addEventListener("blur", clearSegmentHover);
      button.addEventListener("click", () => {
        const segmentKey = button.dataset.workoutSegmentFocus;
        const segment = getSegment();
        if (!segment) {
          return;
        }

        if (this.focusedWorkoutSegmentKey === segmentKey) {
          this.focusedWorkoutSegmentKey = null;
          this.chartView.clearSegmentFocus({ resetZoom: true });
          this.mapView.clearSegmentSelection();
          this.mapView.fitTrackBounds();
        } else {
          this.focusedWorkoutSegmentKey = segmentKey;
          this.chartView.focusSegment(segment);
          this.mapView.focusSegmentOverlay(segment);
        }
        this.renderWorkoutSegments(workout);
      });
    });

    this.workoutSegmentsListElement.querySelectorAll("[data-workout-segment-delete]").forEach((button) => {
      button.addEventListener("click", async (event) => {
        event.stopPropagation();
        const segmentKey = button.dataset.workoutSegmentDelete;
        const segment = segments.find((candidate) => this.getWorkoutSegmentKey(candidate) === segmentKey);
        if (!segment) {
          return;
        }

        button.disabled = true;
        try {
          await this.deleteWorkoutSegment(workout, segment);
        } catch (error) {
          console.error("Failed to delete manual workout segment", error);
          this.showToast(this.t("workoutSegmentDeleteFailed"));
          if (button.isConnected) {
            button.disabled = false;
          }
        }
      });
    });
  }

  async loadSimilarWorkouts(workout) {
    if (!workout?.id) {
      this.similarWorkoutsRequestToken += 1;
      this.resetSimilarWorkouts();
      return;
    }

    const requestToken = ++this.similarWorkoutsRequestToken;
    const isOwned = workout?.access?.isOwner !== false && workout?.is_owned !== false;
    if (!isOwned || !workout?.validGps) {
      this.resetSimilarWorkouts();
      return;
    }

    this.renderSimilarWorkoutsLoading();

    try {
      const result = await WorkoutService.getSimilarWorkouts(workout.id);
      if (requestToken !== this.similarWorkoutsRequestToken || String(workout.id) !== String(this.currentWorkoutId)) {
        return;
      }
      this.renderSimilarWorkouts(result?.edges || [], workout);
    } catch (err) {
      if (requestToken !== this.similarWorkoutsRequestToken || String(workout.id) !== String(this.currentWorkoutId)) {
        return;
      }
      console.error(err);
      this.renderSimilarWorkoutsError();
    }
  }

  renderSimilarWorkoutsLoading() {
    if (!this.similarWorkoutsPanelElement || !this.similarWorkoutsListElement || !this.similarWorkoutsCopyElement) {
      return;
    }

    this.similarWorkoutsPanelElement.classList.remove("d-none");
    this.similarWorkoutsCopyElement.textContent = this.t("similarWorkoutsCopy");
    this.similarWorkoutsListElement.innerHTML = `<div class="dashboard-similar-workouts-empty">${this.t("messages.loading")}</div>`;
    this.applyDetailSectionHeights();
  }

  renderSimilarWorkoutsError() {
    if (!this.similarWorkoutsPanelElement || !this.similarWorkoutsListElement || !this.similarWorkoutsCopyElement) {
      return;
    }

    this.similarWorkoutsPanelElement.classList.remove("d-none");
    this.similarWorkoutsCopyElement.textContent = this.t("similarWorkoutsCopy");
    this.similarWorkoutsListElement.innerHTML = `<div class="dashboard-similar-workouts-empty">${this.t("messages.similarWorkoutsLoadFailed")}</div>`;
    this.applyDetailSectionHeights();
  }

  resetSimilarWorkouts() {
    if (!this.similarWorkoutsPanelElement || !this.similarWorkoutsListElement || !this.similarWorkoutsCopyElement) {
      return;
    }

    this.similarWorkoutsPanelElement.classList.remove("d-none");
    this.similarWorkoutsCopyElement.textContent = this.t("similarWorkoutsCopy");
    this.similarWorkoutsListElement.innerHTML = `
      <div class="dashboard-similar-workouts-empty">
        ${this.t("similarWorkoutsEmpty")}
      </div>
    `;
    this.applyDetailSectionHeights();
  }

  renderSimilarWorkouts(edges = [], workout = null) {
    if (!this.similarWorkoutsPanelElement || !this.similarWorkoutsListElement || !this.similarWorkoutsCopyElement) {
      return;
    }

    this.similarWorkoutsPanelElement.classList.remove("d-none");
    this.applyDetailSectionHeights();

    const directEdges = (Array.isArray(edges) ? edges : []).filter((edge) => edge?.is_direct_match !== false);

    if (!directEdges.length) {
      this.similarWorkoutsCopyElement.textContent = this.t("similarWorkoutsCopy");
      this.similarWorkoutsListElement.innerHTML = `
        <div class="dashboard-similar-workouts-empty">
          ${this.t("similarWorkoutsEmpty")}
        </div>
      `;
      return;
    }

    this.similarWorkoutsCopyElement.textContent = this.t("similarWorkoutsCount", { count: directEdges.length });
    this.similarWorkoutsListElement.innerHTML = directEdges.map((edge) => {
      const otherWorkoutId = Number(edge?.other_workout_id);
      const scorePercent = Number.isFinite(Number(edge?.score))
        ? `${Math.round(Number(edge.score) * 100)}%`
        : this.libraryT("na");
      const dateLabel = this.formatDateTime(edge?.other_start_time);
      const distanceLabel = this.formatDistance(edge?.other_total_distance);
      const ascentLabel = this.formatAscent(edge?.other_total_ascent);
      const powerLabel = this.formatPower(edge?.other_avg_power);

      return `
        <button class="dashboard-similar-workout" type="button" data-similar-workout-open="${otherWorkoutId}">
          <span class="dashboard-similar-workout__header">
            <span class="dashboard-similar-workout__score">${scorePercent}</span>
            <span class="dashboard-similar-workout__identity">
              <span class="dashboard-similar-workout__title">${this.libraryT("workoutLabel", { id: otherWorkoutId })}</span>
              <span class="dashboard-similar-workout__meta">${dateLabel}</span>
            </span>
            <span class="dashboard-similar-workout__chevron" aria-hidden="true">›</span>
          </span>
          <span class="dashboard-similar-workout__stats">
            ${distanceLabel} · ${ascentLabel} · ${powerLabel}
          </span>
        </button>
      `;
    }).join("");

    this.similarWorkoutsListElement.querySelectorAll("[data-similar-workout-open]").forEach((element) => {
      element.addEventListener("click", async () => {
        const workoutId = element.getAttribute("data-similar-workout-open");
        if (!workoutId) {
          return;
        }

        this.currentWorkoutId = workoutId;
        this.uiState.set("selectedWorkoutId", workoutId);
        const url = new URL(window.location.href);
        url.searchParams.set("workoutId", workoutId);
        window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
        await this.openWorkout(workoutId);
      });
    });
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

  setHeroStatus(message) {
    if (!this.heroStatusElement) {
      return;
    }

    this.heroStatusElement.textContent = message;
    this.heroStatusElement.hidden = !message;
  }

  clearHeroStatus() {
    if (!this.heroStatusElement) {
      return;
    }

    this.heroStatusElement.textContent = "";
    this.heroStatusElement.hidden = true;
  }

  onResize() {
    this.chartView.resize();
    this.mapView.resize();
    this.applyLibraryWidth();
    this.scheduleDesktopLayoutMeasure();
    if (!window.matchMedia("(max-width: 991.98px)").matches) {
      this.closeMobileLibrary();
    }
  }

  scrollDetailIntoViewOnMobile() {
    if (!window.matchMedia("(max-width: 991.98px)").matches) {
      return;
    }

    const target = this.detailGridElement || this.workspacePanelElement;
    if (!target) {
      return;
    }

    requestAnimationFrame(() => {
      target.scrollIntoView({
        behavior: "smooth",
        block: "start"
      });
    });
  }

  registerSplitterEvents() {
    this.splitterElement?.addEventListener("pointerdown", (event) => {
      if (!this.canUseDesktopSplitter()) {
        return;
      }

      this.splitterPointerId = event.pointerId;
      this.splitterElement?.setPointerCapture?.(event.pointerId);
      this.splitterElement?.classList.add("is-active");
      document.body.classList.add("overflow-hidden");
      event.preventDefault();
    });

    this.splitterElement?.addEventListener("pointermove", (event) => {
      if (this.splitterPointerId !== event.pointerId) {
        return;
      }

      this.updateLibraryWidthFromPointer(event.clientX);
    });

    const finishDrag = (event) => {
      if (this.splitterPointerId !== event.pointerId) {
        return;
      }

      this.updateLibraryWidthFromPointer(event.clientX);
      this.splitterPointerId = null;
      this.splitterElement?.classList.remove("is-active");
      document.body.classList.remove("overflow-hidden");
    };

    this.splitterElement?.addEventListener("pointerup", finishDrag);
    this.splitterElement?.addEventListener("pointercancel", finishDrag);

    this.detailSplitterTopElement?.addEventListener("pointerdown", (event) => {
      if (!this.canUseDesktopSplitter()) {
        return;
      }

      this.detailSplitterPointerId = event.pointerId;
      this.detailSplitterTopElement.setPointerCapture?.(event.pointerId);
      this.detailSplitterTopElement.classList.add("is-active");
      document.body.classList.add("overflow-hidden");
      event.preventDefault();
    });

    this.detailSplitterTopElement?.addEventListener("pointermove", (event) => {
      if (this.detailSplitterPointerId !== event.pointerId) {
        return;
      }

      this.updateDetailSectionHeightsFromPointer(event.clientY);
    });

    const finishDetailDrag = (event) => {
      if (this.detailSplitterPointerId !== event.pointerId) {
        return;
      }

      this.updateDetailSectionHeightsFromPointer(event.clientY);
      this.detailSplitterPointerId = null;
      this.detailSplitterTopElement?.classList.remove("is-active");
      document.body.classList.remove("overflow-hidden");
    };

    this.detailSplitterTopElement?.addEventListener("pointerup", finishDetailDrag);
    this.detailSplitterTopElement?.addEventListener("pointercancel", finishDetailDrag);
  }

  initLayoutObservers() {
    if (typeof ResizeObserver !== "function") {
      return;
    }

    const observerTargets = [
      document.querySelector(".app-topbar"),
      this.heroElement,
      this.masterDetailElement,
      this.detailGridElement
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
    if (!this.shellElement || !this.masterDetailElement) {
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
    const masterDetail = this.masterDetailElement;
    const detailGrid = this.detailGridElement;

    if (!shell || !masterDetail || !detailGrid) {
      return;
    }

    const isDesktopLike = window.matchMedia("(min-width: 992px)").matches;
    const rect = masterDetail.getBoundingClientRect();
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const availableHeight = Math.floor(viewportHeight - rect.top - 24);
    const canUseClientLayout = isDesktopLike && availableHeight >= 560;

    shell.classList.toggle("dashboard-shell--client", canUseClientLayout);
    this.splitterElement && (this.splitterElement.style.display = isDesktopLike ? "block" : "none");

    if (!canUseClientLayout) {
      shell.style.removeProperty("--dashboard-client-height");
      this.clearDetailSectionHeights();
      this.applyLibraryWidth();
      if (withRenderRefresh) {
        this.chartView.resize();
        this.mapView.resize();
      }
      return;
    }

    shell.style.setProperty("--dashboard-client-height", `${availableHeight}px`);
    this.applyLibraryWidth();
    this.applyDetailSectionHeights();

    if (withRenderRefresh) {
      requestAnimationFrame(() => {
        this.chartView.resize();
        this.mapView.resize();
      });
    }
  }

  canUseDesktopSplitter() {
    return window.matchMedia("(min-width: 992px)").matches && !!this.masterDetailElement;
  }

  applyLibraryWidth() {
    if (!this.masterDetailElement) {
      return;
    }

    if (!this.canUseDesktopSplitter() || !Number.isFinite(this.libraryWidthPx)) {
      this.masterDetailElement.style.removeProperty("--dashboard-library-width");
      return;
    }

    this.masterDetailElement.style.setProperty("--dashboard-library-width", `${Math.round(this.libraryWidthPx)}px`);
  }

  clearDetailSectionHeights() {
    this.detailMainStackElement?.style.removeProperty("--dashboard-detail-top-height");
    this.detailMainStackElement?.style.removeProperty("--dashboard-detail-middle-height");
  }

  applyDetailSectionHeights() {
    if (!this.detailGridElement || !this.detailMainStackElement || !this.canUseDesktopSplitter()) {
      this.clearDetailSectionHeights();
      return;
    }

    const hasSimilarPanel = !this.similarWorkoutsPanelElement?.classList.contains("d-none");
    this.detailGridElement.classList.toggle("has-similar-panel", hasSimilarPanel);

    const nextHeights = { top: 1, middle: 1, ...(this.detailSectionHeights || {}) };
    this.detailMainStackElement.style.setProperty("--dashboard-detail-top-height", `${nextHeights.top || 1}fr`);
    this.detailMainStackElement.style.setProperty("--dashboard-detail-middle-height", `${nextHeights.middle || 1}fr`);
  }

  updateDetailSectionHeightsFromPointer(clientY) {
    const topRect = this.workspacePanelElement?.getBoundingClientRect?.();
    const mapPanelRect = document.getElementById("workout-map")?.closest(".dashboard-detail-panel")?.getBoundingClientRect?.();

    if (!topRect || !mapPanelRect) {
      return;
    }

    const minHeight = 140;
    const total = topRect.height + mapPanelRect.height;
    const nextTop = Math.max(minHeight, Math.min(total - minHeight, clientY - topRect.top));
    const top = nextTop;
    const middle = total - nextTop;

    this.detailSectionHeights = { top, middle };
    this.uiState.set("dashboardDetailSectionHeights", this.detailSectionHeights);
    this.applyDetailSectionHeights();
    this.chartView.resize();
    this.mapView.resize();
  }

  updateLibraryWidthFromPointer(clientX) {
    if (!this.masterDetailElement) {
      return;
    }

    const rect = this.masterDetailElement.getBoundingClientRect();
    const splitterWidth = this.splitterElement?.getBoundingClientRect?.().width || 8;
    const minWidth = 280;
    const maxWidth = Math.max(minWidth, rect.width - splitterWidth - 420);
    const nextWidth = Math.max(minWidth, Math.min(maxWidth, clientX - rect.left));

    this.libraryWidthPx = nextWidth;
    this.uiState.set("dashboardLibraryWidthPx", nextWidth);
    this.applyLibraryWidth();
    this.chartView.resize();
    this.mapView.resize();
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
