import MapView from "./segment-map-view.js";
import TableView from "./segment-table-view.js";
import SegmentBestEffortsCardView from "./segment-best-efforts-card-view.js";
import SegmentElevationView from "./segment-elevation-view.js";
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
    this.bestEffortsViewMode = this.uiState.get("segmentBestEffortsViewMode", "table");
    this.focusSegmentId = new URLSearchParams(window.location.search).get("focusSegmentId");
    this.restoredSegmentId = this.uiState.get("selectedSegmentId");
    this.focusApplied = false;
    this.shellElement = document.querySelector(".segments-shell");
    this.heroElement = document.querySelector(".segments-hero");
    this.workspaceElement = document.getElementById("segments-workspace");
    this.splitterElement = document.getElementById("segments-splitter");
    this.layoutMeasureRaf = null;
    this.layoutObserver = null;
    this.mapWidthPx = this.uiState.get("segmentsMapWidthPx", null);
    this.splitterPointerId = null;
    this.detailActionsMenu = document.querySelector(".segments-detail-actions-menu");
    this.initViews();
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
        }
      }

    );

    this.tableView = new TableView("#segment-table", {
      currentUserId: this.currentUserId,
      initialScope: this.bestEffortsScope,
      onRowOpen: async () => {},
      onRowDelete: async (row) => row
    });

    this.cardView = new SegmentBestEffortsCardView("#segment-best-efforts-cards", {
      currentUserId: this.currentUserId,
      initialScope: this.bestEffortsScope,
      formatSegmentHeaderMarkup: (...args) => this.tableView.formatSegmentHeaderMarkup(...args)
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
    this.bestEffortsViewTableButton = document.getElementById("segment-bestefforts-view-table");
    this.bestEffortsViewCardsButton = document.getElementById("segment-bestefforts-view-cards");
    this.updateDeleteButton();
    this.updateShareUi();
    this.updateSegmentMeta();
    this.syncScopeButtons();
    this.syncBestEffortsViewButtons();
    this.applyBestEffortsViewMode();
  }

  // -----------------------------
  // GLOBAL EVENTS
  // -----------------------------
  registerEvents() {
    window.addEventListener("resize", () => this.onResize());
    this.initLayoutObservers();
    this.registerSplitterEvents();
    this.deleteButton?.addEventListener("click", () => this.deleteSelectedSegment());
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
    [this.tableView.scopeMineButton, this.tableView.scopeSharedButton, this.tableView.scopeAllButton].forEach((button) => {
      button?.addEventListener("click", async () => {
        const scope = button.dataset.segmentBesteffortsScope || "mine";
        await this.setBestEffortsScope(scope);
      });
    });
    [this.bestEffortsViewTableButton, this.bestEffortsViewCardsButton].forEach((button) => {
      button?.addEventListener("click", async () => {
        const mode = button.dataset.segmentBesteffortsView || "table";
        await this.setBestEffortsViewMode(mode);
      });
    });
    document.addEventListener("click", (event) => {
      if (!this.detailActionsMenu?.open) {
        return;
      }

      if (event.target?.closest?.(".segments-detail-actions-menu")) {
        return;
      }

      this.closeDetailActionsMenu();
    });
    this.loadShareableGroups();
    this.scheduleDesktopLayoutMeasure();
  }

  onResize() {
    this.scheduleDesktopLayoutMeasure();
    this.applyMapWidth();
    this.scheduleChildResizes();
  }

  async handleSegmentOpen(e, segment) {
    this.selectSegment(segment);
    await this.loadSelectedSegmentBestEfforts();
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
      if (this.bestEffortsViewMode === "table") {
        this.tableView.resize();
      }

      window.setTimeout(() => {
        this.mapView.resize();
        this.elevationView.resize();
        if (this.bestEffortsViewMode === "table") {
          this.tableView.resize();
        }
      }, 60);
    });
  }

  syncScopeButtons() {
    this.scopeMineButton?.classList.toggle("active", this.segmentScope === "mine");
    this.scopeSharedButton?.classList.toggle("active", this.segmentScope === "shared");
    this.scopeAllButton?.classList.toggle("active", this.segmentScope === "all");
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

  selectSegment(segment) {
    this.selectedSegment = segment;
    this.selectedSegmentSharing = null;
    this.uiState.set("selectedSegmentId", segment?.id ?? null);
    this.mapView.selectSegment(segment);
    this.elevationView.updateSegment(segment);
    this.updateDeleteButton();
    this.updateShareUi();
    this.updateSegmentMeta();
    this.updateBestEffortsScopeUi();
    this.loadSelectedSegmentSharing();
  }

  async loadSelectedSegmentBestEfforts() {
    if (!this.selectedSegment) {
      return;
    }

    this.tableView.setScope(this.bestEffortsScope);
    this.cardView.setScope(this.bestEffortsScope);

    if (this.bestEffortsViewMode === "cards") {
      await this.cardView.loadSegment(this.selectedSegment);
      return;
    }

    await this.tableView.loadSegment(null, this.selectedSegment);
  }

  clearSelectedSegment() {
    this.selectedSegment = null;
    this.selectedSegmentSharing = null;
    this.uiState.remove("selectedSegmentId");
    this.tableView.clear();
    this.cardView.clear();
    this.elevationView.hide();
    if (this.segmentHeader) {
      this.segmentHeader.textContent = this.t("insightsTitle");
    }
    this.mapView.selectSegment(null);
    this.mapView.hideMarker();
    this.updateDeleteButton();
    this.updateShareUi();
    this.updateSegmentMeta();
    this.updateBestEffortsScopeUi();
  }

  updateDeleteButton() {
    if (!this.deleteButton) return;

    const isEditable = this.canEditSelectedSegment();
    this.deleteButton.classList.toggle("d-none", !isEditable);
    this.deleteButton.disabled = !isEditable;
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

  updateBestEffortsScopeUi() {
    const isSharedSegment = Number(this.selectedSegment?.shareGroupCount || 0) > 0;
    this.tableView?.setScopeVisibility(!!isSharedSegment);
  }

  syncBestEffortsViewButtons() {
    this.bestEffortsViewTableButton?.classList.toggle("active", this.bestEffortsViewMode === "table");
    this.bestEffortsViewCardsButton?.classList.toggle("active", this.bestEffortsViewMode === "cards");
  }

  applyBestEffortsViewMode() {
    const tableElement = document.getElementById("segment-table");
    const cardsElement = document.getElementById("segment-best-efforts-cards");
    tableElement?.classList.toggle("d-none", this.bestEffortsViewMode !== "table");
    cardsElement?.classList.toggle("d-none", this.bestEffortsViewMode !== "cards");
  }

  async setBestEffortsViewMode(mode) {
    const nextMode = mode === "cards" ? "cards" : "table";
    if (nextMode === this.bestEffortsViewMode) {
      return;
    }

    this.bestEffortsViewMode = nextMode;
    this.uiState.set("segmentBestEffortsViewMode", nextMode);
    this.syncBestEffortsViewButtons();
    this.applyBestEffortsViewMode();
    await this.loadSelectedSegmentBestEfforts();
    this.scheduleChildResizes();
  }

  async setBestEffortsScope(scope) {
    const nextScope = ["mine", "shared", "all"].includes(String(scope)) ? String(scope) : "mine";
    if (nextScope === this.bestEffortsScope) {
      return;
    }

    this.bestEffortsScope = nextScope;
    this.uiState.set("segmentBestEffortsScope", nextScope);
    this.tableView.setScope(nextScope);
    this.cardView.setScope(nextScope);
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
      this.shareInline?.classList.remove("is-open");
      if (this.shareStatus) {
        this.shareStatus.textContent = "";
      }
    }
  }

  toggleShareInline() {
    if (!this.isShareableGpsSegment(this.selectedSegment)) {
      return;
    }

    this.shareInline?.classList.toggle("is-open");
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
      this.selectedSegmentSharing = data;

      if (this.shareModeSelect) {
        this.shareModeSelect.value = data.shareMode || "private";
      }

      this.renderShareGroupOptions((data.groupIds || []).map((value) => Number(value)));
      this.updateShareModeUi();

      if (this.shareStatus) {
        this.shareStatus.textContent = data.shareMode === "groups"
          ? this.t("messages.groupsActive", { count: (data.groupIds || []).length })
          : this.t("sharePrivate");
      }
      this.updateBestEffortsScopeUi();
    } catch (error) {
      console.error(error);
      this.selectedSegmentSharing = null;
      if (this.shareStatus) {
        this.shareStatus.textContent = this.t("messages.couldNotLoadSharing");
      }
      this.updateBestEffortsScopeUi();
    }
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
      this.selectedSegmentSharing = data;
      if (this.shareStatus) {
        this.shareStatus.textContent = data.shareMode === "groups"
          ? this.t("messages.groupsActive", { count: (data.groupIds || []).length })
          : this.t("sharePrivate");
      }
      this.updateBestEffortsScopeUi();

      this.shareInline?.classList.remove("is-open");
    } catch (error) {
      console.error(error);
      window.alert(error.message || this.t("messages.couldNotSaveSharing"));
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

      this.mapSegments = this.mapSegments.filter((entry) => entry.id !== segment.id);
      this.mapView.controller.mapSegments = this.mapSegments;
      this.mapView.refreshSegments();
      this.clearSelectedSegment();
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
      segment = null;
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
        if (!this.focusSegmentId) {
          this.uiState.remove("selectedSegmentId");
        }
        this.focusApplied = true;
        return;
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
    await this.tableView.loadSegment({ type: "focus" }, segment);

    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.delete("focusSegmentId");
    window.history.replaceState({}, "", `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`);
  }
}
