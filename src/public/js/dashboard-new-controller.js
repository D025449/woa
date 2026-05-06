import MapView from "./map-view.js";
import ChartView from "./chart-view.js";
import WorkoutService from "./workout-service.js";
import UIStateManager from "./UIStateManager.js";
import WorkoutLibraryView from "./workout-library-view.js";
import { createTranslator, getCurrentLocale } from "./i18n.js";
import Utils from "../../shared/Utils.js";
import confirmModal from "./confirm-modal.js";

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
      favoritesOnly: false
    });
    this.chartViewState = this.uiState.get("chartViewState", {
      xAxisMode: "time",
      seriesVisibility: {
        power: true,
        heartRate: true,
        cadence: true,
        speed: true,
        altitude: true
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
    this.recentWorkoutIds = this.readStoredList("dashboardRecentWorkoutIds");
    this.favoriteWorkoutIds = this.readStoredList("dashboardFavoriteWorkoutIds");
    this.detailCopyElement = document.getElementById("dashboard-detail-copy");
    this.workoutTitleElement = document.getElementById("dashboard-workout-title");
    this.workspacePanelElement = document.getElementById("dashboard-workspace-panel");
    this.sharedMetaElement = document.getElementById("dashboard-shared-meta");
    this.sharedMetaTextElement = document.getElementById("dashboard-shared-meta-text");
    this.toastElement = document.getElementById("dashboard-toast");
    this.toastBodyElement = document.getElementById("dashboard-toast-body");
    this.mobileLibraryToggle = document.getElementById("dashboard-mobile-library-toggle");
    this.mobileLibraryBackdrop = document.getElementById("dashboard-mobile-library-backdrop");
    this.libraryColumn = document.querySelector(".dashboard-library-column");
    this.libraryScrollElement = document.querySelector(".workout-library-scroll");
    this.quickAccessElement = document.getElementById("dashboard-quick-access");
    this.recentWorkoutsElement = document.getElementById("dashboard-recent-workouts");
    this.favoriteWorkoutsElement = document.getElementById("dashboard-favorite-workouts");
    this.splitterElement = document.getElementById("dashboard-splitter");
    this.shellElement = document.getElementById("dashboard-shell");
    this.heroElement = document.getElementById("dashboard-hero");
    this.masterDetailElement = document.getElementById("dashboard-master-detail");
    this.detailGridElement = document.getElementById("dashboard-detail-grid");
    this.prevWorkoutButton = document.getElementById("dashboard-workout-prev");
    this.nextWorkoutButton = document.getElementById("dashboard-workout-next");
    this.isMobileLibraryOpen = false;
    this.libraryWidthPx = this.uiState.get("dashboardLibraryWidthPx", null);
    this.splitterPointerId = null;
    this.layoutMeasureRaf = null;
    this.layoutObserver = null;
    this.toast = this.toastElement && globalThis.bootstrap
      ? new globalThis.bootstrap.Toast(this.toastElement, {
          delay: 2800
        })
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
    this.mapView = new MapView("workout-map");
    this.mapView.onBaseLayerChange = (baseLayerMode) => {
      this.mapViewState = { baseLayerMode };
      this.uiState.set("dashboardMapViewState", this.mapViewState);
      if (this.didRestoreMapViewState) {
        this.showToast(this.t("messages.mapStyleChanged", { style: this.t(`mapStyle${baseLayerMode.charAt(0).toUpperCase()}${baseLayerMode.slice(1)}`) }));
      }
    };
    this.mapView.setInitialState(this.mapViewState);
    this.didRestoreMapViewState = true;

    this.chartView = new ChartView("workout-chart", {
      initialState: this.chartViewState,
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
      },

      onPreferencesChange: (state) => {
        this.chartViewState = state;
        this.uiState.set("chartViewState", state);
      }
    });

    this.libraryView = new WorkoutLibraryView("#workout-library", {
      headerElementId: "dashboard-workout-count",
      searchInputId: "workout-library-search",
      sortSelectId: "workout-library-sort",
      initialSearch: this.libraryState?.search || "",
      initialSort: this.libraryState?.sort || "newest",
      initialScope: this.libraryState?.scope || "mine",
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
      onFavoriteChange: (favoriteIds) => {
        this.favoriteWorkoutIds = Array.isArray(favoriteIds) ? favoriteIds : [];
        this.writeStoredList("dashboardFavoriteWorkoutIds", this.favoriteWorkoutIds);
        this.renderQuickAccess();
      },
      onFavoriteToggle: ({ isFavorite }) => {
        this.showToast(isFavorite ? this.t("messages.favoriteAdded") : this.t("messages.favoriteRemoved"));
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
    this.mobileLibraryBackdrop?.addEventListener("click", () => this.closeMobileLibrary());
    this.libraryScrollElement?.addEventListener("scroll", () => {
      this.libraryScrollTop = this.libraryScrollElement.scrollTop;
      this.uiState.set("workoutLibraryScrollTop", this.libraryScrollTop);
    }, { passive: true });
    document.addEventListener("keydown", (event) => this.handleGlobalShortcuts(event));
    this.registerSplitterEvents();
    this.initLayoutObservers();
    this.prevWorkoutButton?.addEventListener("click", async () => {
      await this.openRelativeWorkout(-1);
    });
    this.nextWorkoutButton?.addEventListener("click", async () => {
      await this.openRelativeWorkout(1);
    });
  }

  async boot() {
    try {
      await this.loadShareableGroups();
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

  async openWorkout(workoutId) {
    if (!workoutId) {
      return;
    }

    this.chartView.showLoading();

    try {
      const workoutMeta = this.libraryView.getWorkoutById(workoutId) || {};
      const workout = await WorkoutService.loadWorkoutByRow(workoutId);
      if (!workout) {
        this.uiState.remove("selectedWorkoutId");
        this.currentWorkoutId = null;
        this.libraryView.setSelectedWorkout(null);
        this.resetWorkspaceSummary();
        return;
      }

      Object.assign(workout, {
        start_time: workoutMeta.start_time ?? null,
        total_timer_time: workoutMeta.total_timer_time ?? null,
        total_distance: workoutMeta.total_distance ?? null,
        avg_power: workoutMeta.avg_power ?? null,
        is_owned: workoutMeta.is_owned ?? (workout.access?.isOwner !== false)
      });

      this.currentWorkoutId = workout.id;
      this.uiState.set("selectedWorkoutId", workout.id);
      this.pushRecentWorkout(workout.id);
      this.chartView.updateWorkout(workout);
      this.mapView.renderTrack(workout);
      this.libraryView.setSelectedWorkout(workout.id);
      this.updateWorkoutMeta(workout);
      this.scheduleDesktopLayoutMeasure(true);
      this.closeMobileLibrary();
      this.renderQuickAccess();
      this.updateDetailNavigation();
    } catch (err) {
      console.error(err);
      this.resetWorkspaceSummary();
      this.showToast(this.t("messages.workoutOpenFailed"));
    } finally {
      this.chartView.hideLoading();
    }
  }

  getNavigableWorkoutIds() {
    return this.libraryView.getRenderableItems().map((workout) => String(workout.id));
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

    await WorkoutService.deleteWorkoutsByIds(ownWorkouts.map((workout) => workout.id));

    ownWorkouts.forEach((workout) => {
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

  readStoredList(key) {
    try {
      const raw = localStorage.getItem(key);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.map((value) => String(value)) : [];
    } catch {
      return [];
    }
  }

  writeStoredList(key, values) {
    localStorage.setItem(key, JSON.stringify((values || []).map((value) => String(value)).slice(0, 8)));
  }

  pushRecentWorkout(workoutId) {
    const nextId = String(workoutId);
    this.recentWorkoutIds = [nextId, ...this.recentWorkoutIds.filter((value) => value !== nextId)].slice(0, 6);
    this.writeStoredList("dashboardRecentWorkoutIds", this.recentWorkoutIds);
  }

  renderQuickAccess() {
    if (!this.quickAccessElement || !this.recentWorkoutsElement || !this.favoriteWorkoutsElement) {
      return;
    }

    const recentItems = this.recentWorkoutIds
      .map((workoutId) => this.libraryView.getWorkoutById(workoutId))
      .filter(Boolean)
      .slice(0, 4);
    const favoriteItems = this.favoriteWorkoutIds
      .map((workoutId) => this.libraryView.getWorkoutById(workoutId))
      .filter(Boolean)
      .slice(0, 4);

    this.recentWorkoutsElement.innerHTML = recentItems
      .map((workout) => `<button class="dashboard-quick-access__chip" type="button" data-quick-workout-open="${workout.id}">#${workout.id}</button>`)
      .join("");
    this.favoriteWorkoutsElement.innerHTML = favoriteItems
      .map((workout) => `<button class="dashboard-quick-access__chip" type="button" data-quick-workout-open="${workout.id}">★ #${workout.id}</button>`)
      .join("");

    this.quickAccessElement.hidden = recentItems.length === 0 && favoriteItems.length === 0;

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
    this.updateDetailNavigation();
  }

  buildWorkoutDetailLine(workout) {
    const startedAt = workout?.start_time ? new Date(workout.start_time) : null;
    const parts = [];

    if (startedAt) {
      const dateLabel = startedAt.toLocaleDateString(this.locale, {
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
    this.mapView.resize();
    this.applyLibraryWidth();
    this.scheduleDesktopLayoutMeasure();
    if (!window.matchMedia("(max-width: 991.98px)").matches) {
      this.closeMobileLibrary();
    }
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
  }

  initLayoutObservers() {
    if (typeof ResizeObserver !== "function") {
      return;
    }

    const observerTargets = [
      document.querySelector(".app-topbar"),
      this.heroElement,
      this.masterDetailElement
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
      this.applyLibraryWidth();
      if (withRenderRefresh) {
        this.chartView.resize();
        this.mapView.resize();
      }
      return;
    }

    shell.style.setProperty("--dashboard-client-height", `${availableHeight}px`);
    this.applyLibraryWidth();

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
