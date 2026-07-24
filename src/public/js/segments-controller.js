import MapView from "./segment-map-view.js";
import SegmentBestEffortsCardView from "./segment-best-efforts-card-view.js";
import SegmentElevationView from "./segment-elevation-view.js";
import FlyoverView from "./flyover-view.js";
import MapSegment from "../../shared/MapSegment.js";
import UIStateManager from "./UIStateManager.js"
import confirmModal from "./confirm-modal.js";
import { createTranslator } from "./i18n.js";

export default class Controller {

  constructor() {
    this.t = createTranslator("segmentsPage");
    this.uiState = new UIStateManager("segmentController");
    this.selectedSegment = null;
    this.selectedSegmentSharing = null;
    this.mapSegments = [];
    this.shareableGroups = [];
    this.currentUserId = String(document.body?.dataset?.currentUserId || "");
    this.segmentScope = this.uiState.get("segmentScope", "mine");
    this.bestEffortsScope = this.uiState.get("segmentBestEffortsScope", "mine");
    this.bestEffortsPerUser = this.uiState.get("segmentBestEffortsPerUser", "all");
    this.favoriteOnly = !!this.uiState.get("segmentFavoriteOnly", false);
    this.recentSegmentIds = this.readStoredList("segmentsRecentIds");
    this.favoriteSegmentIds = [];
    this.favoriteSegmentsReady = this.loadFavoriteSegmentIds();
    this.focusSegmentId = new URLSearchParams(window.location.search).get("focusSegmentId");
    this.restoredSegmentId = this.uiState.get("selectedSegmentId");
    this.focusApplied = false;
    this.segmentVisibilityPopoverOpen = false;
    this.segmentVisibilityPopoverLoading = false;
    this.shellElement = document.querySelector(".segments-shell");
    this.heroElement = document.querySelector(".segments-hero");
    this.workspaceElement = document.getElementById("segments-workspace");
    this.splitterElement = document.getElementById("segments-splitter");
    this.detailSurfaceElement = document.getElementById("segment-detail-surface");
    this.detailSheetToggleButton = document.getElementById("segment-detail-sheet-toggle");
    const storedDetailSheetState = this.uiState.get("segmentDetailSheetState", "peek");
    this.detailSheetState = ["peek", "half", "full"].includes(storedDetailSheetState)
      ? storedDetailSheetState
      : "peek";
    this.layoutMeasureRaf = null;
    this.layoutObserver = null;
    this.mapWidthPx = this.uiState.get("segmentsMapWidthPx", null);
    this.maptilerApiKey = String(globalThis.__APP_CONFIG?.maptilerApiKey || "").trim();
    this.mapViewState = this.uiState.get("segmentsMapViewState", {
      baseLayerMode: "standard"
    });
    this.splitterPointerId = null;
    this.detailActionsMenu = document.querySelector(".segments-detail-actions-menu");
    this.quickAccessElement = document.getElementById("segments-quick-access");
    this.favoriteSegmentsElement = document.getElementById("segments-favorite-list");
    this.prevSegmentButton = document.getElementById("segment-prev");
    this.nextSegmentButton = document.getElementById("segment-next");
    this.map3dToggleButton = document.getElementById("segments-map-3d-toggle");
    this.segmentArchiveExportButton = document.getElementById("segments-archive-export");
    this.segmentArchiveImportButton = document.getElementById("segments-archive-import");
    this.segmentArchiveFileInput = document.getElementById("segments-archive-file");
    this.segmentArchiveBusy = false;
    this.toastElement = document.getElementById("segments-toast");
    this.toastBodyElement = document.getElementById("segments-toast-body");
    this.toast = this.toastElement && globalThis.bootstrap
      ? new globalThis.bootstrap.Toast(this.toastElement, { delay: 2800 })
      : null;
    this.initViews();
    this.didRestoreMapViewState = false;
    this.registerEvents();
  }

  // -----------------------------
  // INIT
  // -----------------------------
  initViews() {


    this.mapView = new MapView("workout-map", this,
      {
        onSegmentOpen: async (e, segment) => {
          await this.handleSegmentOpen(e, segment);
        },
        onBaseLayerChange: (baseLayerMode) => {
          this.mapViewState = { baseLayerMode };
          this.uiState.set("segmentsMapViewState", this.mapViewState);
          if (this.didRestoreMapViewState) {
            this.showToast(this.t("messages.mapStyleChanged", { style: this.t(`mapStyle${baseLayerMode.charAt(0).toUpperCase()}${baseLayerMode.slice(1)}`) }));
          }
        }
      }

    );
    this.mapView.setInitialState(this.mapViewState);
    this.didRestoreMapViewState = true;

    this.flyoverView = new FlyoverView({
      modalElementId: "segments-3d-modal",
      mapElementId: "segments-3d-map",
      summaryElementId: "segments-3d-summary",
      playToggleButtonId: "segments-3d-play-toggle",
      presetSelectId: "segments-3d-preset",
      presetStorageKey: "segmentsFlyoverCameraPreset",
      apiKey: this.maptilerApiKey,
      t: (key) => this.t(key),
      hasRenderableTrack: (segment) => Array.isArray(segment?.track) && segment.track.length > 1,
      buildSummary: (segment) => this.buildSegment3dSummary(segment),
      resolvePlaybackDurationMs: (segment, points) => this.resolveSegmentFlyoverDurationMs(segment, points)
    });

    this.cardView = new SegmentBestEffortsCardView("#segment-best-efforts-cards", {
      currentUserId: this.currentUserId,
      initialScope: this.bestEffortsScope,
      initialPerUser: this.bestEffortsPerUser,
      formatSegmentHeaderMarkup: (...args) => this.formatSegmentHeaderMarkup(...args),
      onHeaderRendered: () => this.bindSegmentHeaderEvents()
    });

    this.elevationView = new SegmentElevationView(
      "segment-elevation-chart",
      "segment-elevation-panel",
      "segment-elevation-stats",
      {
        onHoverPoint: (point) => {
          this.mapView.moveMarkerToPoint(point);
        },
        onLeave: () => {
          this.mapView.hideMarker();
        }
      }
    );

    this.deleteButton = document.getElementById("delete-selected-segment");
    this.shareToggleButton = document.getElementById("share-segment-toggle");
    this.shareInline = document.getElementById("segment-share-inline");
    this.shareModeSelect = document.getElementById("segment-share-mode");
    this.shareGroupsContainer = document.getElementById("segment-share-groups");
    this.shareStatus = document.getElementById("segment-share-status");
    this.shareSaveButton = document.getElementById("segment-share-save");
    this.segmentHeader = document.getElementById("segment-header");
    this.segmentSharedMeta = document.getElementById("segment-shared-meta");
    this.segmentSharedMetaText = document.getElementById("segment-shared-meta-text");
    this.scopeMineButton = document.getElementById("segments-scope-mine");
    this.scopeSharedButton = document.getElementById("segments-scope-shared");
    this.scopeAllButton = document.getElementById("segments-scope-all");
    this.bestEffortsScopeMineButton = document.getElementById("segment-bestefforts-scope-mine");
    this.bestEffortsScopeSharedButton = document.getElementById("segment-bestefforts-scope-shared");
    this.bestEffortsScopeAllButton = document.getElementById("segment-bestefforts-scope-all");
    this.bestEffortsScopeToggle = document.querySelector(".segment-bestefforts-scope-toggle");
    this.bestEffortsPerUserAllButton = document.getElementById("segment-bestefforts-per-user-all");
    this.bestEffortsPerUserOneButton = document.getElementById("segment-bestefforts-per-user-1");
    this.bestEffortsPerUserThreeButton = document.getElementById("segment-bestefforts-per-user-3");
    this.bestEffortsMenu = document.querySelector(".segments-best-efforts-menu");
    this.favoriteToggleButton = document.getElementById("segment-favorite-toggle");
    this.favoriteFilterButton = document.getElementById("segments-favorites-filter");
    this.bestEffortsMyPrButton = document.getElementById("segment-bestefforts-my-pr");
    this.updateDeleteButton();
    this.updateShareUi();
    this.updateSegmentMeta();
    this.syncScopeButtons();
    this.syncFavoriteFilterButton();
    this.syncBestEffortsScopeButtons();
    this.syncBestEffortsPerUserButtons();
  }

  // -----------------------------
  // GLOBAL EVENTS
  // -----------------------------
  registerEvents() {
    window.addEventListener("resize", () => this.onResize());
    this.initLayoutObservers();
    this.registerSplitterEvents();
    this.registerDetailSheetEvents();
    this.deleteButton?.addEventListener("click", () => this.deleteSelectedSegment());
    this.favoriteToggleButton?.addEventListener("click", async () => this.toggleSelectedSegmentFavorite());
    this.favoriteFilterButton?.addEventListener("click", async () => {
      await this.toggleFavoriteFilter();
    });
    this.map3dToggleButton?.addEventListener("click", () => this.open3dMap());
    this.segmentArchiveExportButton?.addEventListener("click", async () => {
      document.getElementById("segments-map-tools-menu")?.removeAttribute("open");
      await this.exportSegmentArchive();
    });
    this.segmentArchiveImportButton?.addEventListener("click", () => {
      document.getElementById("segments-map-tools-menu")?.removeAttribute("open");
      this.segmentArchiveFileInput?.click();
    });
    this.segmentArchiveFileInput?.addEventListener("change", async () => {
      const file = this.segmentArchiveFileInput?.files?.[0];
      if (this.segmentArchiveFileInput) this.segmentArchiveFileInput.value = "";
      if (file) await this.importSegmentArchive(file);
    });
    this.shareToggleButton?.addEventListener("click", () => this.toggleShareInline());
    this.shareModeSelect?.addEventListener("change", () => this.updateShareModeUi());
    this.shareSaveButton?.addEventListener("click", async () => {
      await this.saveSegmentSharing();
    });
    [this.scopeMineButton, this.scopeSharedButton, this.scopeAllButton].forEach((button) => {
      button?.addEventListener("click", async () => {
        const scope = button.getAttribute("data-segment-scope") || "mine";
        await this.setSegmentScope(scope);
      });
    });
    [this.bestEffortsScopeMineButton, this.bestEffortsScopeSharedButton, this.bestEffortsScopeAllButton].forEach((button) => {
      button?.addEventListener("click", async () => {
        const scope = button.dataset.segmentBesteffortsScope || "mine";
        await this.setBestEffortsScope(scope);
      });
    });
    [this.bestEffortsPerUserAllButton, this.bestEffortsPerUserOneButton, this.bestEffortsPerUserThreeButton].forEach((button) => {
      button?.addEventListener("click", async () => {
        const mode = button.dataset.segmentBesteffortsPerUser || "all";
        await this.setBestEffortsPerUser(mode);
      });
    });
    this.bestEffortsMyPrButton?.addEventListener("click", async () => {
      await this.activateMyPrFocus();
      this.bestEffortsMenu?.removeAttribute("open");
    });
    this.detailActionsMenu?.querySelector("summary")?.addEventListener("click", (event) => {
      if (!this.isShareInlineOpen()) {
        return;
      }

      event.preventDefault();
      this.closeShareInline();
      this.closeDetailActionsMenu();
    });
    document.addEventListener("click", (event) => {
      const clickedInsideDetailMenu = !!event.target?.closest?.(".segments-detail-actions-menu");
      const clickedInsideShareInline = !!event.target?.closest?.("#segment-share-inline");
      const clickedInsideBestEffortsMenu = !!event.target?.closest?.(".segments-best-efforts-menu");

      if (this.detailActionsMenu?.open && !clickedInsideDetailMenu) {
        this.closeDetailActionsMenu();
      }

      if (this.isShareInlineOpen() && !clickedInsideDetailMenu && !clickedInsideShareInline) {
        this.closeShareInline();
      }

      if (this.bestEffortsMenu?.open && !clickedInsideBestEffortsMenu) {
        this.bestEffortsMenu.removeAttribute("open");
      }

      const clickedInsideVisibilityToggle = !!event.target?.closest?.("[data-segment-visibility-toggle]");
      const clickedInsideVisibilityPopover = !!event.target?.closest?.("[data-segment-visibility-popover]");
      if (this.segmentVisibilityPopoverOpen && !clickedInsideVisibilityToggle && !clickedInsideVisibilityPopover) {
        this.closeSegmentVisibilityPopover();
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") {
        this.handleGlobalShortcuts(event);
        return;
      }

      this.mapView.disableSelectionMode();
      this.closeShareInline();
      this.closeDetailActionsMenu();
      this.bestEffortsMenu?.removeAttribute("open");
      this.closeSegmentVisibilityPopover();
    });
    this.loadShareableGroups();
    this.scheduleDesktopLayoutMeasure();
    this.renderQuickAccess();
    this.prevSegmentButton?.addEventListener("click", async () => {
      await this.openRelativeSegment(-1);
    });
    this.nextSegmentButton?.addEventListener("click", async () => {
      await this.openRelativeSegment(1);
    });
    this.syncDetailSheetState();
  }

  onResize() {
    this.scheduleDesktopLayoutMeasure();
    this.applyMapWidth();
    this.syncDetailSheetState();
    this.scheduleChildResizes();
  }

  registerDetailSheetEvents() {
    this.detailSheetToggleButton?.addEventListener("click", () => {
      const states = ["peek", "half", "full"];
      const currentIndex = states.indexOf(this.detailSheetState);
      const nextState = states[(currentIndex + 1) % states.length];
      this.setDetailSheetState(nextState);
    });
  }

  setDetailSheetState(state, { persist = true } = {}) {
    const normalizedState = ["peek", "half", "full"].includes(state) ? state : "peek";
    this.detailSheetState = normalizedState;
    if (persist) {
      this.uiState.set("segmentDetailSheetState", normalizedState);
    }
    this.syncDetailSheetState();
    this.scheduleChildResizes();
  }

  syncDetailSheetState() {
    if (!this.detailSurfaceElement) {
      return;
    }

    const isMobile = window.matchMedia("(max-width: 991.98px)").matches;
    const state = isMobile ? this.detailSheetState : "full";
    this.detailSurfaceElement.dataset.sheetState = state;
    this.detailSheetToggleButton?.setAttribute("aria-expanded", state === "full" ? "true" : "false");
  }

  async handleSegmentOpen(e, segment) {
    this.selectSegment(segment);
    await Promise.all([
      this.loadSelectedSegmentDetails(),
      this.loadSelectedSegmentBestEfforts()
    ]);
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

      this.updateMapWidthFromPointer(event.clientX);
    });

    const finishDrag = (event) => {
      if (this.splitterPointerId !== event.pointerId) {
        return;
      }

      this.updateMapWidthFromPointer(event.clientX);
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
      this.workspaceElement
    ].filter(Boolean);

    if (!observerTargets.length) {
      return;
    }

    this.layoutObserver = new ResizeObserver(() => {
      this.scheduleDesktopLayoutMeasure();
    });

    observerTargets.forEach((target) => this.layoutObserver.observe(target));
  }

  scheduleDesktopLayoutMeasure() {
    if (!this.shellElement || !this.workspaceElement) {
      return;
    }

    if (this.layoutMeasureRaf != null) {
      cancelAnimationFrame(this.layoutMeasureRaf);
    }

    this.layoutMeasureRaf = requestAnimationFrame(() => {
      this.layoutMeasureRaf = null;
      this.updateDesktopLayoutMeasure();
    });
  }

  updateDesktopLayoutMeasure() {
    const shell = this.shellElement;
    const workspace = this.workspaceElement;

    if (!shell || !workspace) {
      return;
    }

    const isDesktopLike = window.matchMedia("(min-width: 992px)").matches;
    const rect = workspace.getBoundingClientRect();
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const availableHeight = Math.floor(viewportHeight - rect.top - 24);
    const canUseClientLayout = isDesktopLike && availableHeight >= 560;

    shell.classList.toggle("segments-shell--client", canUseClientLayout);
    this.splitterElement && (this.splitterElement.style.display = isDesktopLike ? "block" : "none");

    if (!canUseClientLayout) {
      shell.style.removeProperty("--segments-client-height");
      shell.style.removeProperty("--segments-map-width");
      this.scheduleChildResizes();
      return;
    }

    shell.style.setProperty("--segments-client-height", `${availableHeight}px`);
    this.applyMapWidth();
    this.scheduleChildResizes();
  }

  canUseDesktopSplitter() {
    return window.matchMedia("(min-width: 992px)").matches;
  }

  applyMapWidth() {
    const workspace = this.workspaceElement;
    if (!workspace) {
      return;
    }

    if (!this.canUseDesktopSplitter() || !Number.isFinite(this.mapWidthPx)) {
      workspace.style.removeProperty("--segments-map-width");
      return;
    }

    workspace.style.setProperty("--segments-map-width", `${Math.round(this.mapWidthPx)}px`);
  }

  updateMapWidthFromPointer(clientX) {
    const workspace = this.workspaceElement;
    if (!workspace) {
      return;
    }

    const rect = workspace.getBoundingClientRect();
    const splitterWidth = this.splitterElement?.getBoundingClientRect?.().width || 8;
    const minWidth = 320;
    const maxWidth = Math.max(minWidth, rect.width - splitterWidth - 420);
    const nextWidth = Math.min(Math.max(clientX - rect.left, minWidth), maxWidth);

    this.mapWidthPx = nextWidth;
    this.uiState.set("segmentsMapWidthPx", nextWidth);
    this.applyMapWidth();
    this.scheduleChildResizes();
  }

  scheduleChildResizes() {
    requestAnimationFrame(() => {
      this.mapView.resize();
      this.elevationView.resize();

      window.setTimeout(() => {
        this.mapView.resize();
        this.elevationView.resize();
      }, 60);
    });
  }

  syncScopeButtons() {
    this.scopeMineButton?.classList.toggle("active", this.segmentScope === "mine");
    this.scopeSharedButton?.classList.toggle("active", this.segmentScope === "shared");
    this.scopeAllButton?.classList.toggle("active", this.segmentScope === "all");
  }

  syncFavoriteFilterButton() {
    this.favoriteFilterButton?.setAttribute("aria-pressed", this.favoriteOnly ? "true" : "false");
  }

  async setSegmentScope(scope) {
    const normalizedScope = ["mine", "shared", "all"].includes(String(scope))
      ? String(scope)
      : "mine";

    if (normalizedScope === this.segmentScope) {
      return;
    }

    this.segmentScope = normalizedScope;
    this.uiState.set("segmentScope", normalizedScope);
    this.syncScopeButtons();
    this.clearSelectedSegment();
    this.restoredSegmentId = null;
    if (!this.focusSegmentId) {
      this.uiState.remove("selectedSegmentId");
    }
    this.mapSegments = [];
    this.mapView.controller.mapSegments = this.mapSegments;
    this.mapView.refreshSegments();
    this.focusApplied = false;
    await this.mapView.loadSegmentsForViewport(this.mapView.map.getBounds());
  }

  async toggleFavoriteFilter() {
    await this.favoriteSegmentsReady;
    this.favoriteOnly = !this.favoriteOnly;
    this.uiState.set("segmentFavoriteOnly", this.favoriteOnly);
    this.syncFavoriteFilterButton();

    if (this.favoriteOnly && this.selectedSegment?.id && !this.isFavoriteSegment(this.selectedSegment.id)) {
      this.clearSelectedSegment();
    }

    this.mapView.refreshSegments();
    this.renderQuickAccess();
    await this.mapView.loadSegmentsForViewport(this.mapView.map.getBounds());
  }

  isSegmentVisibleInCurrentScope(segment) {
    if (!segment) {
      return false;
    }

    const ownerId = segment.uid == null ? "" : String(segment.uid);
    const isOwnedByCurrentUser = ownerId !== "" && ownerId === this.currentUserId;

    if (this.segmentScope === "shared") {
      return !isOwnedByCurrentUser;
    }

    if (this.segmentScope === "all") {
      return true;
    }

    return isOwnedByCurrentUser;
  }

  resolveScopeForSegment(segment) {
    if (!segment) {
      return this.segmentScope;
    }

    const ownerId = segment.uid == null ? "" : String(segment.uid);
    const isOwnedByCurrentUser = ownerId !== "" && ownerId === this.currentUserId;
    return isOwnedByCurrentUser ? "mine" : "all";
  }

  applySegmentScopeForFocusedSegment(segment) {
    const nextScope = this.resolveScopeForSegment(segment);
    if (!nextScope || nextScope === this.segmentScope) {
      return;
    }

    this.segmentScope = nextScope;
    this.uiState.set("segmentScope", nextScope);
    this.syncScopeButtons();
  }

  selectSegment(segment) {
    this.selectedSegment = segment;
    this.selectedSegmentSharing = segment?.sharing || null;
    this.uiState.set("selectedSegmentId", segment?.id ?? null);
    this.pushRecentSegment(segment?.id);
    this.flyoverView?.setWorkout(segment);
    this.mapView.selectSegment(segment);
    this.elevationView.updateSegment(segment);
    this.updateDeleteButton();
    this.updateShareUi();
    this.updateSegmentMeta();
    this.update3dMapButton();
    this.updateFavoriteUi();
    this.renderQuickAccess();
    this.updateBestEffortsScopeUi();
    if (this.selectedSegmentSharing) {
      this.applySelectedSegmentSharing(this.selectedSegmentSharing);
    }
    this.updateDetailNavigation();
    if (window.matchMedia("(max-width: 991.98px)").matches && this.detailSheetState === "peek") {
      this.setDetailSheetState("half", { persist: false });
    }
  }

  refreshSelectedSegmentHeader() {
    if (!this.segmentHeader) {
      return;
    }

    if (!this.selectedSegment) {
      this.segmentHeader.textContent = this.t("insightsTitle");
      return;
    }

    this.segmentHeader.innerHTML = this.formatSegmentHeaderMarkup(
      this.selectedSegment,
      this.cardView?.lastMatchCount ?? null
    );
    this.bindSegmentHeaderEvents();
  }

  bindSegmentHeaderEvents() {
    this.segmentHeader?.querySelectorAll("[data-segment-visibility-toggle]").forEach((element) => {
      element.addEventListener("click", async (event) => {
        event.stopPropagation();
        await this.toggleSelectedSegmentVisibilityPopover();
      });
    });

    this.segmentHeader?.querySelectorAll("[data-segment-visibility-popover]").forEach((element) => {
      element.addEventListener("click", (event) => {
        event.stopPropagation();
      });
    });
  }

  async loadSelectedSegmentBestEfforts() {
    if (!this.selectedSegment) {
      return;
    }

    this.cardView.setScope(this.bestEffortsScope);
    this.cardView.setPerUserFilter(this.bestEffortsPerUser);
    await this.cardView.loadSegment(this.selectedSegment);
  }

  async loadSelectedSegmentDetails() {
    const selectedId = this.selectedSegment?.id;
    if (!selectedId || this.selectedSegment?.sharing) {
      return this.selectedSegment;
    }

    try {
      const segment = await MapSegment.getSegmentById(selectedId);
      if (!segment || String(this.selectedSegment?.id) !== String(selectedId)) {
        return null;
      }

      Object.assign(this.selectedSegment, segment);
      this.selectedSegmentSharing = segment.sharing || null;
      if (this.selectedSegmentSharing) {
        this.applySelectedSegmentSharing(this.selectedSegmentSharing);
      }
      this.updateShareUi();
      this.updateSegmentMeta();
      this.updateFavoriteUi();
      this.refreshSelectedSegmentHeader();
      this.updateBestEffortsScopeUi();
      return this.selectedSegment;
    } catch (error) {
      console.error(error);
      return null;
    }
  }

  clearSelectedSegment() {
    this.selectedSegment = null;
    this.selectedSegmentSharing = null;
    this.closeSegmentVisibilityPopover({ render: false });
    this.uiState.remove("selectedSegmentId");
    this.cardView.clear();
    this.elevationView.hide();
    this.flyoverView?.setWorkout(null);
    this.refreshSelectedSegmentHeader();
    this.mapView.selectSegment(null);
    this.mapView.hideMarker();
    this.updateDeleteButton();
    this.updateShareUi();
    this.updateSegmentMeta();
    this.update3dMapButton();
    this.updateFavoriteUi();
    this.updateBestEffortsScopeUi();
    this.updateDetailNavigation();
    if (window.matchMedia("(max-width: 991.98px)").matches) {
      this.setDetailSheetState("peek", { persist: false });
    }
  }

  updateDeleteButton() {
    if (!this.deleteButton) return;

    const isEditable = this.canEditSelectedSegment();
    this.deleteButton.classList.toggle("d-none", !isEditable);
    this.deleteButton.disabled = !isEditable;
  }

  open3dMap() {
    if (!this.maptilerApiKey) {
      this.showToast(this.t("messages.map3dKeyMissing"));
      return;
    }

    if (!this.selectedSegment || !Array.isArray(this.selectedSegment.track) || this.selectedSegment.track.length < 2) {
      this.showToast(this.t("messages.map3dNoGps"));
      return;
    }

    this.flyoverView?.setWorkout(this.selectedSegment);
    this.flyoverView?.open();
  }

  update3dMapButton() {
    if (!this.map3dToggleButton) {
      return;
    }

    const canOpen = !!this.maptilerApiKey
      && Array.isArray(this.selectedSegment?.track)
      && this.selectedSegment.track.length > 1;

    this.map3dToggleButton.disabled = !canOpen;
  }

  buildSegment3dSummary(segment) {
    if (!segment) {
      return this.t("map3dEmpty");
    }

    const distanceKm = Number(segment.distance) > 0
      ? `${(Number(segment.distance) / 1000).toFixed(1)} km`
      : null;
    const ascentHm = Number(segment.ascent) > 0
      ? `${Math.round(Number(segment.ascent))} hm`
      : null;

    return [
      segment.name || `${segment.start?.name || ""} – ${segment.end?.name || ""}`.trim() || this.t("map3dTitle"),
      distanceKm,
      ascentHm
    ].filter(Boolean).join(" · ");
  }

  resolveSegmentFlyoverDurationMs(segment, points) {
    const distanceMeters = Number(segment?.distance);
    const pointCount = Array.isArray(points) ? points.length : 0;

    if (Number.isFinite(distanceMeters) && distanceMeters > 0) {
      const metersPerSecond = 600 / 3.6;
      const durationMs = (distanceMeters / metersPerSecond) * 1000;
      return Math.max(6000, Math.min(240000, durationMs));
    }

    return Math.min(100000, Math.max(40000, pointCount * 107));
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

  pushRecentSegment(segmentId) {
    if (!segmentId) {
      return;
    }

    const nextId = String(segmentId);
    this.recentSegmentIds = [nextId, ...this.recentSegmentIds.filter((value) => value !== nextId)].slice(0, 6);
    this.writeStoredList("segmentsRecentIds", this.recentSegmentIds);
  }

  isFavoriteSegment(segmentId) {
    return this.favoriteSegmentIds.includes(String(segmentId));
  }

  async loadFavoriteSegmentIds() {
    try {
      const response = await fetch("/segments/favorites", {
        method: "GET",
        credentials: "include"
      });

      if (response.status === 401) {
        window.location.href = "/login";
        return;
      }
      if (!response.ok) {
        throw new Error(`Favorite segments load failed (${response.status})`);
      }

      const result = await response.json();
      this.favoriteSegmentIds = Array.isArray(result.segmentIds)
        ? result.segmentIds.map((value) => String(value))
        : [];
      this.renderQuickAccess();
      this.updateFavoriteUi();
    } catch (err) {
      console.error(err);
      this.showToast(err?.message || this.t("messages.favoriteLoadFailed"));
    }
  }

  getRenderableSegments() {
    if (!this.favoriteOnly) {
      return this.mapSegments;
    }

    return this.mapSegments.filter((segment) => this.isFavoriteSegment(segment.id));
  }

  updateFavoriteUi() {
    const segmentId = this.selectedSegment?.id;
    const isVisible = !!segmentId;
    this.favoriteToggleButton?.classList.toggle("d-none", !isVisible);
    this.favoriteToggleButton?.classList.toggle("is-active", isVisible && this.isFavoriteSegment(segmentId));
    this.favoriteToggleButton?.setAttribute("aria-pressed", isVisible && this.isFavoriteSegment(segmentId) ? "true" : "false");
  }

  async toggleSelectedSegmentFavorite() {
    if (!this.selectedSegment?.id) {
      return;
    }

    const segmentId = String(this.selectedSegment.id);
    const wasFavorite = this.isFavoriteSegment(segmentId);
    if (wasFavorite) {
      this.favoriteSegmentIds = this.favoriteSegmentIds.filter((value) => value !== segmentId);
    } else {
      this.favoriteSegmentIds = [segmentId, ...this.favoriteSegmentIds.filter((value) => value !== segmentId)];
    }

    this.selectedSegment.isFavorite = !wasFavorite;
    this.updateFavoriteUi();
    this.renderQuickAccess();

    try {
      await MapSegment.setFavorite(segmentId, !wasFavorite);
    } catch (err) {
      if (wasFavorite) {
        this.favoriteSegmentIds = [segmentId, ...this.favoriteSegmentIds.filter((value) => value !== segmentId)];
      } else {
        this.favoriteSegmentIds = this.favoriteSegmentIds.filter((value) => value !== segmentId);
      }
      this.selectedSegment.isFavorite = wasFavorite;
      this.updateFavoriteUi();
      this.renderQuickAccess();
      this.showToast(err?.message || "Favorite update failed");
      return;
    }

    this.showToast(!wasFavorite ? this.t("messages.favoriteAdded") : this.t("messages.favoriteRemoved"));
    if (this.favoriteOnly && wasFavorite) {
      this.clearSelectedSegment();
      this.mapView.refreshSegments();
      try {
        await this.mapView.loadSegmentsForViewport(this.mapView.map.getBounds());
      } catch (err) {
        console.error(err);
      }
    }
  }

  getNavigableSegments() {
    return this.getRenderableSegments();
  }

  updateDetailNavigation() {
    const segments = this.getNavigableSegments();
    const currentId = this.selectedSegment?.id == null ? null : String(this.selectedSegment.id);
    const index = currentId ? segments.findIndex((segment) => String(segment.id) === currentId) : -1;
    const hasPrev = index > 0;
    const hasNext = index >= 0 && index < segments.length - 1;

    this.prevSegmentButton && (this.prevSegmentButton.disabled = !hasPrev);
    this.nextSegmentButton && (this.nextSegmentButton.disabled = !hasNext);
  }

  async openRelativeSegment(direction = 1) {
    const segments = this.getNavigableSegments();
    const currentId = this.selectedSegment?.id == null ? null : String(this.selectedSegment.id);
    const index = currentId ? segments.findIndex((segment) => String(segment.id) === currentId) : -1;
    if (index < 0) {
      return;
    }

    const nextSegment = segments[index + (direction < 0 ? -1 : 1)];
    if (!nextSegment) {
      return;
    }

    this.selectSegment(nextSegment);
    this.mapView.focusSegment(nextSegment);
    const url = new URL(window.location.href);
    url.searchParams.set("focusSegmentId", String(nextSegment.id));
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    await Promise.all([
      this.loadSelectedSegmentDetails(),
      this.loadSelectedSegmentBestEfforts()
    ]);
  }

  renderQuickAccess() {
    if (!this.quickAccessElement || !this.favoriteSegmentsElement) {
      return;
    }

    const favoriteSegments = this.favoriteSegmentIds.slice(0, 4).map((id) => ({ id }));
    this.favoriteSegmentsElement.innerHTML = favoriteSegments
      .map((segment) => `<button class="segments-quick-access__link" type="button" data-quick-segment-open="${segment.id}">S${segment.id}</button>`)
      .join("");

    this.quickAccessElement.hidden = favoriteSegments.length === 0;

    this.quickAccessElement.querySelectorAll("[data-quick-segment-open]").forEach((element) => {
      element.addEventListener("click", async () => {
        const segmentId = element.getAttribute("data-quick-segment-open");
        if (!segmentId) {
          return;
        }

        const segment = this.mapSegments.find((entry) => String(entry.id) === String(segmentId))
          || await MapSegment.getSegmentById(segmentId);

        if (!segment) {
          return;
        }

        const existing = this.mapSegments.some((entry) => String(entry.id) === String(segment.id));
        if (!existing) {
          this.mapSegments.push(segment);
          this.mapView.renderSegment(segment);
        }

        this.selectSegment(segment);
        this.mapView.focusSegment(segment);
        const url = new URL(window.location.href);
        url.searchParams.set("focusSegmentId", String(segment.id));
        window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
        await Promise.all([
          this.loadSelectedSegmentDetails(),
          this.loadSelectedSegmentBestEfforts()
        ]);
      });
    });
  }

  handleGlobalShortcuts(event) {
    const target = event.target;
    const isTypingContext = target instanceof HTMLElement && (
      target.isContentEditable
      || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)
    );

    if (isTypingContext) {
      return;
    }

    if (event.key === "1") {
      event.preventDefault();
      this.setBestEffortsViewMode("table");
      return;
    }

    if (event.key === "2") {
      event.preventDefault();
      this.setBestEffortsViewMode("cards");
      return;
    }

    if ((event.key === "f" || event.key === "F") && this.selectedSegment?.id) {
      event.preventDefault();
      this.toggleSelectedSegmentFavorite();
      if (this.favoriteOnly) {
        this.mapView.refreshSegments();
      }
      return;
    }

    if ((event.key === "p" || event.key === "P")) {
      event.preventDefault();
      this.activateMyPrFocus();
    }
  }

  updateSegmentMeta() {
    if (!this.segmentSharedMeta || !this.segmentSharedMetaText) {
      return;
    }

    const segment = this.selectedSegment;
    const ownerLabel = segment?.ownerDisplayName || segment?.ownerEmail || "";
    const ownerId = segment?.uid == null ? "" : String(segment.uid);
    const isOwnedByCurrentUser = ownerId !== "" && ownerId === this.currentUserId;
    const isSharedSegment = Number(segment?.shareGroupCount || 0) > 0;

    if (!segment) {
      this.segmentSharedMeta.classList.add("d-none");
      this.segmentSharedMetaText.textContent = "";
      return;
    }

    this.segmentSharedMeta.classList.remove("d-none");
    const eyebrow = this.segmentSharedMeta.querySelector(".segments-shared-meta__eyebrow");
    if (eyebrow) {
      eyebrow.textContent = isSharedSegment ? this.t("sharedSegmentEyebrow") : this.t("sharePrivate");
    }

    if (isSharedSegment) {
      this.segmentSharedMetaText.textContent = isOwnedByCurrentUser
        ? this.t("messages.sharedWithGroups")
        : this.t("messages.sharedBy", { owner: ownerLabel });
      return;
    }

    this.segmentSharedMetaText.textContent = isOwnedByCurrentUser
      ? this.t("messages.visibleOnlyToYou")
      : this.t("messages.privateBy", { owner: ownerLabel });
  }

  formatSegmentVisibilityBadge(segment = this.selectedSegment) {
    if (!segment) {
      return "";
    }

    const shareMode = this.selectedSegmentSharing?.shareMode;
    const shareGroupCount = Array.isArray(this.selectedSegmentSharing?.groupIds)
      ? this.selectedSegmentSharing.groupIds.length
      : Number(segment?.shareGroupCount || 0);
    const isShared = shareMode === "groups" || shareGroupCount > 0;
    const label = isShared
      ? this.t("shareTagGroups", { count: shareGroupCount })
      : this.t("sharePrivate");
    const modifier = isShared ? " segments-detail-heading__visibility--shared" : "";
    const popover = isShared && this.segmentVisibilityPopoverOpen ? this.renderSegmentVisibilityPopover() : "";

    if (!isShared) {
      return ` <span class="segments-detail-heading__visibility${modifier}">${this.escapeHtml(label)}</span>`;
    }

    return ` <button class="segments-detail-heading__visibility${modifier}" type="button" data-segment-visibility-toggle="true">${this.escapeHtml(label)}</button>${popover}`;
  }

  renderSegmentVisibilityPopover() {
    const groups = this.getSelectedSegmentGroupNames();

    return `
      <div class="segments-detail-visibility-popover" data-segment-visibility-popover="true">
        ${this.segmentVisibilityPopoverLoading ? `
          <div class="segments-detail-visibility-popover__empty">${this.t("messages.loading")}</div>
        ` : groups.length ? `
          <div class="segments-detail-visibility-popover__list">
            ${groups.map((groupName) => `<span class="segments-detail-visibility-popover__item">${this.escapeHtml(groupName)}</span>`).join("")}
          </div>
        ` : `
          <div class="segments-detail-visibility-popover__empty">${this.t("shareGroups")}</div>
        `}
      </div>
    `;
  }

  getSelectedSegmentGroupNames() {
    const ids = Array.isArray(this.selectedSegmentSharing?.groupIds)
      ? this.selectedSegmentSharing.groupIds.map((value) => Number(value))
      : [];

    return ids.map((groupId) => {
      const group = this.shareableGroups.find((entry) => Number(entry.id) === Number(groupId));
      return group?.name || `#${groupId}`;
    });
  }

  closeSegmentVisibilityPopover({ render = true } = {}) {
    if (!this.segmentVisibilityPopoverOpen && !this.segmentVisibilityPopoverLoading) {
      return;
    }

    this.segmentVisibilityPopoverOpen = false;
    this.segmentVisibilityPopoverLoading = false;
    if (render) {
      this.refreshSelectedSegmentHeader();
    }
  }

  async toggleSelectedSegmentVisibilityPopover() {
    const segment = this.selectedSegment;
    if (!segment) {
      return;
    }

    const shareCount = Array.isArray(this.selectedSegmentSharing?.groupIds)
      ? this.selectedSegmentSharing.groupIds.length
      : Number(segment?.shareGroupCount || 0);

    if (shareCount <= 0) {
      return;
    }

    if (this.segmentVisibilityPopoverOpen) {
      this.closeSegmentVisibilityPopover();
      return;
    }

    this.segmentVisibilityPopoverOpen = true;
    this.refreshSelectedSegmentHeader();

    if (Array.isArray(this.selectedSegmentSharing?.groupIds) && this.selectedSegmentSharing.groupIds.length) {
      return;
    }

    this.segmentVisibilityPopoverLoading = true;
    this.refreshSelectedSegmentHeader();

    try {
      await this.loadSelectedSegmentSharing();
    } finally {
      this.segmentVisibilityPopoverLoading = false;
      if (this.segmentVisibilityPopoverOpen) {
        this.refreshSelectedSegmentHeader();
      }
    }
  }

  escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  formatSegmentHeaderMarkup(segment, matchCount = null) {
    if (!segment) {
      return this.escapeHtml(this.t("insightsTitle"));
    }

    const ownerLabel = segment.ownerDisplayName || segment.ownerEmail || null;
    const title = `S${segment.id}: ${segment.start.name} - ${segment.end.name}`;
    const visibilityBadge = this.formatSegmentVisibilityBadge(segment);
    const meta = [
      ownerLabel ? `${this.t("table.ownerShort")}: ${ownerLabel}` : null,
      Number.isFinite(matchCount) ? this.t("table.matches", { count: matchCount }) : null
    ].filter(Boolean).join(" · ");

    return `
      <span class="segments-detail-heading">
        <span class="segments-detail-heading__copy">
          <span class="segments-detail-heading__title" title="${this.escapeHtml(title)}">${this.escapeHtml(title)}</span>
          <span class="segments-detail-heading__meta">
            ${meta ? `<span class="segments-detail-heading__meta-text">${this.escapeHtml(meta)}</span>` : ""}
            ${visibilityBadge}
          </span>
        </span>
      </span>
    `;
  }

  updateBestEffortsScopeUi() {
    const isSharedSegment = Number(this.selectedSegment?.shareGroupCount || 0) > 0;
    this.bestEffortsScopeToggle?.classList.toggle("is-hidden", !isSharedSegment);
  }

  syncBestEffortsScopeButtons() {
    this.bestEffortsScopeMineButton?.classList.toggle("active", this.bestEffortsScope === "mine");
    this.bestEffortsScopeSharedButton?.classList.toggle("active", this.bestEffortsScope === "shared");
    this.bestEffortsScopeAllButton?.classList.toggle("active", this.bestEffortsScope === "all");
  }

  syncBestEffortsPerUserButtons() {
    this.bestEffortsPerUserAllButton?.classList.toggle("active", this.bestEffortsPerUser === "all");
    this.bestEffortsPerUserOneButton?.classList.toggle("active", this.bestEffortsPerUser === "1");
    this.bestEffortsPerUserThreeButton?.classList.toggle("active", this.bestEffortsPerUser === "3");
  }

  async setBestEffortsScope(scope) {
    const nextScope = ["mine", "shared", "all"].includes(String(scope)) ? String(scope) : "mine";
    if (nextScope === this.bestEffortsScope) {
      return;
    }

    this.bestEffortsScope = nextScope;
    this.uiState.set("segmentBestEffortsScope", nextScope);
    this.cardView.setScope(nextScope);
    this.syncBestEffortsScopeButtons();
    await this.loadSelectedSegmentBestEfforts();
  }

  async setBestEffortsPerUser(mode) {
    const nextMode = ["all", "1", "3"].includes(String(mode)) ? String(mode) : "all";
    if (nextMode === this.bestEffortsPerUser) {
      return;
    }

    this.bestEffortsPerUser = nextMode;
    this.uiState.set("segmentBestEffortsPerUser", nextMode);
    this.cardView.setPerUserFilter(nextMode);
    this.syncBestEffortsPerUserButtons();
    await this.loadSelectedSegmentBestEfforts();
  }

  async activateMyPrFocus() {
    this.bestEffortsScope = "mine";
    this.bestEffortsPerUser = "1";
    this.uiState.set("segmentBestEffortsScope", "mine");
    this.uiState.set("segmentBestEffortsPerUser", "1");
    this.cardView.setScope("mine");
    this.cardView.setPerUserFilter("1");
    this.syncBestEffortsScopeButtons();
    this.syncBestEffortsPerUserButtons();
    await this.loadSelectedSegmentBestEfforts();
  }

  canEditSelectedSegment(segment = this.selectedSegment) {
    if (!segment) {
      return false;
    }

    const ownerId = segment.uid == null ? "" : String(segment.uid);
    return ownerId !== "" && ownerId === this.currentUserId;
  }

  isShareableGpsSegment(segment) {
    return !!segment
      && this.canEditSelectedSegment(segment)
      && segment.rowstate === "DB"
      && Number.isInteger(Number(segment.id))
      && Array.isArray(segment.track);
  }

  async loadShareableGroups() {
    try {
      const response = await fetch("/collaboration/groups", {
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
      this.renderShareGroupOptions([]);
    } catch (error) {
      console.error(error);
    }
  }

  updateShareUi() {
    const segment = this.selectedSegment;
    const isShareableGpsSegment = this.isShareableGpsSegment(segment);

    this.shareToggleButton?.classList.toggle("d-none", !isShareableGpsSegment);

    if (!isShareableGpsSegment) {
      this.closeShareInline();
      if (this.shareStatus) {
        this.shareStatus.textContent = "";
      }
    }
  }

  isShareInlineOpen() {
    return this.shareInline?.classList.contains("is-open");
  }

  closeShareInline() {
    this.shareInline?.classList.remove("is-open");
  }

  toggleShareInline() {
    if (!this.isShareableGpsSegment(this.selectedSegment)) {
      return;
    }

    if (this.isShareInlineOpen()) {
      this.closeShareInline();
      return;
    }

    this.shareInline?.classList.add("is-open");
    this.closeDetailActionsMenu();
  }

  closeDetailActionsMenu() {
    this.detailActionsMenu?.removeAttribute("open");
  }

  renderShareGroupOptions(selectedGroupIds = []) {
    if (!this.shareGroupsContainer) {
      return;
    }

    this.shareGroupsContainer.innerHTML = this.shareableGroups.map((group) => `
      <label class="segment-share-chip">
        <input type="checkbox" value="${group.id}" ${selectedGroupIds.includes(Number(group.id)) ? "checked" : ""}>
        <span>${group.name}</span>
      </label>
    `).join("");
  }

  updateShareModeUi() {
    const isGroups = this.shareModeSelect?.value === "groups";
    this.shareGroupsContainer?.classList.toggle("is-visible", isGroups);
  }

  async loadSelectedSegmentSharing() {
    const segment = this.selectedSegment;

    if (!this.isShareableGpsSegment(segment)) {
      return;
    }

    try {
      const response = await fetch(`/segments/${encodeURIComponent(segment.id)}/sharing`, {
        credentials: "include"
      });

      if (response.status === 401) {
        window.location.href = "/login";
        return;
      }

      if (!response.ok) {
        throw new Error(this.t("messages.failedLoadSegmentSharing", { status: response.status }));
      }

      const result = await response.json();
      const data = result.data || { shareMode: "private", groupIds: [] };
      this.applySelectedSegmentSharing(data);
    } catch (error) {
      console.error(error);
      this.selectedSegmentSharing = null;
      if (this.shareStatus) {
        this.shareStatus.textContent = this.t("messages.couldNotLoadSharing");
      }
      this.refreshSelectedSegmentHeader();
      this.updateBestEffortsScopeUi();
    }
  }

  applySelectedSegmentSharing(data) {
    this.selectedSegmentSharing = data;
    if (this.selectedSegment) {
      this.selectedSegment.sharing = data;
      this.selectedSegment.shareGroupCount = Array.isArray(data?.groupIds) ? data.groupIds.length : 0;
    }

    if (this.shareModeSelect) {
      this.shareModeSelect.value = data?.shareMode || "private";
    }

    this.renderShareGroupOptions((data?.groupIds || []).map((value) => Number(value)));
    this.updateShareModeUi();

    if (this.shareStatus) {
      this.shareStatus.textContent = data?.shareMode === "groups"
        ? this.t("messages.groupsActive", { count: (data.groupIds || []).length })
        : this.t("sharePrivate");
    }
    this.refreshSelectedSegmentHeader();
    this.updateBestEffortsScopeUi();
  }

  async saveSegmentSharing() {
    const segment = this.selectedSegment;

    if (!this.isShareableGpsSegment(segment)) {
      return;
    }

    const groupIds = Array.from(
      this.shareGroupsContainer?.querySelectorAll('input[type="checkbox"]:checked') || []
    ).map((input) => Number(input.value)).filter((value) => Number.isInteger(value) && value > 0);

    const payload = {
      shareMode: this.shareModeSelect?.value || "private",
      groupIds
    };

    try {
      const response = await fetch(`/segments/${encodeURIComponent(segment.id)}/sharing`, {
        method: "PUT",
        credentials: "include",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      if (response.status === 401) {
        window.location.href = "/login";
        return;
      }

      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(result.error || `Failed to save segment sharing (${response.status})`);
      }

      const data = result.data || payload;
      this.applySelectedSegmentSharing(data);
      this.showToast(this.t("messages.segmentShareUpdated"));

      this.closeShareInline();
    } catch (error) {
      console.error(error);
      window.alert(error.message || this.t("messages.couldNotSaveSharing"));
    }
  }

  showToast(message) {
    if (!this.toast || !this.toastBodyElement) {
      return;
    }

    this.toastBodyElement.innerHTML = message;
    this.toast.show();
  }

  setSegmentArchiveBusy(busy) {
    this.segmentArchiveBusy = !!busy;
    if (this.segmentArchiveExportButton) this.segmentArchiveExportButton.disabled = this.segmentArchiveBusy;
    if (this.segmentArchiveImportButton) this.segmentArchiveImportButton.disabled = this.segmentArchiveBusy;
  }

  async readApiError(response) {
    const result = await response.json().catch(() => ({}));
    return result.error || `${response.status} ${response.statusText}`;
  }

  async exportSegmentArchive() {
    if (this.segmentArchiveBusy) return;
    this.setSegmentArchiveBusy(true);
    try {
      const response = await fetch("/segments/archive/export");
      if (!response.ok) throw new Error(await this.readApiError(response));

      const disposition = response.headers.get("Content-Disposition") || "";
      const filename = disposition.match(/filename="?([^";]+)"?/i)?.[1] || "woa-segments.zip";
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      this.showToast(this.t("messages.segmentArchiveExported"));
    } catch (error) {
      console.error("Segment archive export failed", error);
      window.alert(error.message || this.t("messages.segmentArchiveFailed"));
    } finally {
      this.setSegmentArchiveBusy(false);
    }
  }

  async importSegmentArchive(file) {
    if (this.segmentArchiveBusy) return;
    this.setSegmentArchiveBusy(true);
    try {
      const formData = new FormData();
      formData.append("archive", file);
      const response = await fetch("/segments/archive/import", {
        method: "POST",
        body: formData
      });
      if (!response.ok) throw new Error(await this.readApiError(response));

      const result = await response.json();
      this.clearSelectedSegment();
      this.mapSegments = [];
      this.mapView.controller.mapSegments = this.mapSegments;
      this.mapView.refreshSegments();
      this.focusApplied = false;
      await this.mapView.loadSegmentsForViewport(this.mapView.map.getBounds());
      this.showToast(this.t("messages.segmentArchiveImported", {
        imported: Number(result.imported || 0),
        skipped: Number(result.skippedDuplicates || 0)
      }));
    } catch (error) {
      console.error("Segment archive import failed", error);
      window.alert(error.message || this.t("messages.segmentArchiveFailed"));
    } finally {
      this.setSegmentArchiveBusy(false);
    }
  }

  async deleteSelectedSegment() {
    const segment = this.selectedSegment;
    if (!segment) return;

    const label = `${segment.start?.name ?? this.t("messages.start")} - ${segment.end?.name ?? this.t("messages.end")}`;
    const ok = await confirmModal({
      title: this.t("deleteSegment"),
      message: this.t("messages.deleteSegmentPrompt", { label }),
      acceptLabel: this.t("deleteSegment"),
      cancelLabel: this.t("messages.cancel"),
      acceptClass: "btn-danger"
    });
    if (!ok) return;

    try {
      if (segment.rowstate === "DB") {
        await MapSegment.deleteSegment(segment.id);
      }

      const deletedSegmentId = String(segment.id);
      this.favoriteSegmentIds = this.favoriteSegmentIds.filter((value) => value !== deletedSegmentId);
      this.recentSegmentIds = this.recentSegmentIds.filter((value) => value !== deletedSegmentId);
      this.writeStoredList("segmentsRecentIds", this.recentSegmentIds);

      this.mapSegments = this.mapSegments.filter((entry) => entry.id !== segment.id);
      this.mapView.controller.mapSegments = this.mapSegments;
      this.mapView.refreshSegments();
      this.clearSelectedSegment();
      this.renderQuickAccess();
    } catch (err) {
      console.error(err);
      window.alert(this.t("messages.failedDeleteSegment"));
    }
  }

  async tryFocusRequestedSegment() {
    const targetSegmentId = this.focusSegmentId || this.restoredSegmentId;

    if (!targetSegmentId || this.focusApplied) {
      return;
    }

    let segment = this.mapSegments.find(
      (entry) => String(entry.id) === String(targetSegmentId)
    );

    if (segment && !this.isSegmentVisibleInCurrentScope(segment)) {
      this.applySegmentScopeForFocusedSegment(segment);
    }

    if (!segment) {
      segment = await MapSegment.getSegmentById(targetSegmentId);
      if (!segment) {
        if (!this.focusSegmentId) {
          this.uiState.remove("selectedSegmentId");
        }
        this.focusApplied = true;
        return;
      }

      if (!this.isSegmentVisibleInCurrentScope(segment)) {
        this.applySegmentScopeForFocusedSegment(segment);
      }

      const alreadyPresent = this.mapSegments.some(
        (entry) => String(entry.id) === String(segment.id)
      );

      if (!alreadyPresent) {
        this.mapSegments.push(segment);
        this.mapView.renderSegment(segment);
      }
    }

    this.focusApplied = true;
    this.selectSegment(segment);
    this.mapView.focusSegment(segment);
    await Promise.all([
      this.loadSelectedSegmentDetails(),
      this.loadSelectedSegmentBestEfforts()
    ]);

    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.delete("focusSegmentId");
    window.history.replaceState({}, "", `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`);
  }
}
